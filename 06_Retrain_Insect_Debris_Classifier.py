#!/usr/bin/env python3
"""Retrain the BugPicker insect/debris classifier from reviewed feedback."""

from __future__ import annotations

import argparse
import csv
import json
import random
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset, random_split
from torchvision import transforms

from insect_debris_classifier import (
    CLASS_NAMES,
    IMAGE_SIZE,
    InsectDebrisClassifier,
    build_model,
)


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_FEEDBACK = SCRIPT_DIR / "Data/classifier_feedback/insect_debris_feedback.jsonl"
DEFAULT_BASE_MODEL = SCRIPT_DIR / "Data/insect_debris_classifier.pt"
DEFAULT_CANDIDATE = SCRIPT_DIR / "Data/insect_debris_classifier_candidate.pt"
DEFAULT_REPORT = SCRIPT_DIR / "Data/classifier_feedback/retrain_report.csv"


@dataclass(frozen=True)
class TrainingExample:
    image_path: Path
    label: int
    object_index: int | None
    scan_id: str
    reviewed_at: str


class FeedbackDataset(Dataset):
    def __init__(self, examples: list[TrainingExample], transform) -> None:
        self.examples = examples
        self.transform = transform

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, index: int):
        example = self.examples[index]
        image = Image.open(example.image_path).convert("RGB")
        return self.transform(image), example.label


def iter_jsonl(path: Path):
    if not path.exists():
        return
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def resolve_image_path(record: dict[str, Any]) -> Path | None:
    for key in ("copied_crop_file", "crop_file"):
        value = record.get(key)
        if not value:
            continue
        path = Path(str(value))
        if path.is_absolute() and path.exists():
            return path
        scan_dir = record.get("scan_dir")
        if scan_dir:
            candidate = Path(str(scan_dir)) / path
            if candidate.exists():
                return candidate
    return None


def load_examples(feedback_file: Path) -> list[TrainingExample]:
    latest_by_image: dict[Path, TrainingExample] = {}
    for record in iter_jsonl(feedback_file) or []:
        decision = str(record.get("decision", "")).lower()
        if decision not in {"specimen", "debris"}:
            continue
        image_path = resolve_image_path(record)
        if image_path is None:
            continue
        label = CLASS_NAMES.index("insect" if decision == "specimen" else "debris")
        try:
            object_index = int(record.get("object_index"))
        except (TypeError, ValueError):
            object_index = None
        latest_by_image[image_path.resolve()] = TrainingExample(
            image_path=image_path.resolve(),
            label=label,
            object_index=object_index,
            scan_id=str(record.get("scan_id", "")),
            reviewed_at=str(record.get("reviewed_at", "")),
        )
    return list(latest_by_image.values())


def training_transform():
    return transforms.Compose(
        [
            transforms.Resize(int(IMAGE_SIZE * 1.14)),
            transforms.RandomHorizontalFlip(),
            transforms.RandomRotation(12),
            transforms.ColorJitter(brightness=0.18, contrast=0.18, saturation=0.12),
            transforms.CenterCrop(IMAGE_SIZE),
            transforms.ToTensor(),
            transforms.Normalize(
                mean=[0.485, 0.456, 0.406],
                std=[0.229, 0.224, 0.225],
            ),
        ]
    )


def inference_transform():
    return transforms.Compose(
        [
            transforms.Resize(int(IMAGE_SIZE * 1.14)),
            transforms.CenterCrop(IMAGE_SIZE),
            transforms.ToTensor(),
            transforms.Normalize(
                mean=[0.485, 0.456, 0.406],
                std=[0.229, 0.224, 0.225],
            ),
        ]
    )


def evaluate(model: nn.Module, loader: DataLoader, device: torch.device) -> dict[str, int | float]:
    model.eval()
    total = 0
    correct = 0
    false_debris = 0
    false_insect = 0
    with torch.inference_mode():
        for images, labels in loader:
            images = images.to(device)
            labels = labels.to(device)
            predictions = torch.argmax(model(images), dim=1)
            total += int(labels.numel())
            correct += int((predictions == labels).sum().item())
            false_debris += int(((labels == CLASS_NAMES.index("insect")) & (predictions == CLASS_NAMES.index("debris"))).sum().item())
            false_insect += int(((labels == CLASS_NAMES.index("debris")) & (predictions == CLASS_NAMES.index("insect"))).sum().item())
    return {
        "total": total,
        "correct": correct,
        "accuracy": correct / total if total else 0.0,
        "false_debris": false_debris,
        "false_insect": false_insect,
    }


def write_report(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feedback", type=Path, default=DEFAULT_FEEDBACK)
    parser.add_argument("--base-model", type=Path, default=DEFAULT_BASE_MODEL)
    parser.add_argument("--output", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--validation-fraction", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--promote", action="store_true", help="Replace the active .pt after training.")
    args = parser.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    examples = load_examples(args.feedback)
    if len(examples) < 20:
        raise SystemExit(f"Need at least 20 reviewed crop examples; found {len(examples)} in {args.feedback}")

    class_counts = {
        "debris": sum(1 for example in examples if example.label == CLASS_NAMES.index("debris")),
        "insect": sum(1 for example in examples if example.label == CLASS_NAMES.index("insect")),
    }
    if min(class_counts.values()) < 5:
        raise SystemExit(f"Need at least 5 examples per class; found {class_counts}")

    device = torch.device(args.device)
    full_training_dataset = FeedbackDataset(examples, training_transform())
    full_eval_dataset = FeedbackDataset(examples, inference_transform())
    validation_count = max(1, int(round(len(examples) * args.validation_fraction)))
    training_count = len(examples) - validation_count
    generator = torch.Generator().manual_seed(args.seed)
    training_dataset, _ = random_split(full_training_dataset, [training_count, validation_count], generator=generator)
    _, validation_dataset = random_split(full_eval_dataset, [training_count, validation_count], generator=generator)

    training_loader = DataLoader(training_dataset, batch_size=args.batch_size, shuffle=True)
    validation_loader = DataLoader(validation_dataset, batch_size=args.batch_size, shuffle=False)
    all_loader = DataLoader(full_eval_dataset, batch_size=args.batch_size, shuffle=False)

    model = build_model("efficientnet_b0", len(CLASS_NAMES))
    if args.base_model.exists():
        checkpoint = torch.load(args.base_model, map_location=device, weights_only=False)
        state_dict = checkpoint["model_state_dict"] if isinstance(checkpoint, dict) and "model_state_dict" in checkpoint else checkpoint
        model.load_state_dict(state_dict)
    model.to(device)
    active_metrics = evaluate(model, validation_loader, device) if args.base_model.exists() else None

    class_weights = torch.tensor(
        [
            len(examples) / max(1, class_counts["debris"]),
            len(examples) / max(1, class_counts["insect"]),
        ],
        dtype=torch.float32,
        device=device,
    )
    criterion = nn.CrossEntropyLoss(weight=class_weights)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)

    rows: list[dict[str, Any]] = []
    start = time.time()
    for epoch in range(1, args.epochs + 1):
        model.train()
        running_loss = 0.0
        batch_count = 0
        for images, labels in training_loader:
            images = images.to(device)
            labels = labels.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(images), labels)
            loss.backward()
            optimizer.step()
            running_loss += float(loss.item())
            batch_count += 1
        metrics = evaluate(model, validation_loader, device)
        rows.append(
            {
                "epoch": epoch,
                "epoch_total": args.epochs,
                "training_loss": running_loss / max(1, batch_count),
                **metrics,
            }
        )
        print(json.dumps(rows[-1], sort_keys=True), flush=True)

    final_metrics = evaluate(model, all_loader, device)
    candidate_validation_metrics = evaluate(model, validation_loader, device)
    promotion_recommended = (
        active_metrics is None
        or (
            candidate_validation_metrics["accuracy"] > active_metrics["accuracy"]
            and candidate_validation_metrics["false_debris"] <= active_metrics["false_debris"]
        )
    )
    recommendation = (
        "Promote: the candidate improves accuracy without increasing specimens classified as debris."
        if promotion_recommended and active_metrics is not None else
        "Promote: no active debris model was available for comparison."
        if promotion_recommended else
        "Do not promote: the candidate does not improve accuracy without increasing specimen-to-debris errors."
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "model_state_dict": model.state_dict(),
            "class_names": CLASS_NAMES,
            "architecture": "efficientnet_b0",
            "trained_from_feedback": str(args.feedback),
            "base_model": str(args.base_model),
            "example_count": len(examples),
            "class_counts": class_counts,
            "validation_fraction": args.validation_fraction,
            "epochs": args.epochs,
            "final_metrics": final_metrics,
            "created_at_unix": time.time(),
        },
        args.output,
    )
    write_report(args.report, rows)

    promoted = False
    if args.promote:
        backup = args.base_model.with_suffix(args.base_model.suffix + f".backup_{int(time.time())}")
        if args.base_model.exists():
            shutil.copy2(args.base_model, backup)
        shutil.copy2(args.output, args.base_model)
        promoted = True

    summary = {
        "output": str(args.output),
        "report": str(args.report),
        "example_count": len(examples),
        "class_counts": class_counts,
        "final_metrics": final_metrics,
        "candidate_validation_metrics": candidate_validation_metrics,
        "active_metrics": active_metrics,
        "active_model": str(args.base_model),
        "candidate_model": str(args.output),
        "promotion_recommended": promotion_recommended,
        "recommendation": recommendation,
        "elapsed_seconds": round(time.time() - start, 1),
        "promoted": promoted,
    }
    print(json.dumps(summary, sort_keys=True))

    # Sanity-load the candidate with the runtime wrapper.
    InsectDebrisClassifier(args.output, threshold=0.45, device=str(device))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
