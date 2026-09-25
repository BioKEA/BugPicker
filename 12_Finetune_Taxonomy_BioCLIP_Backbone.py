#!/usr/bin/env python3
"""12: Occasionally fine-tune the BioCLIP backbone for BugPicker taxonomy.

This is the slower, less frequent taxonomy update path. It trains from the same
curated taxonomy manifest as the weekly Order-head retrainer, but it updates the
BioCLIP image encoder as well as the taxonomy Order head.
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import random
import shutil
import sys
import tempfile
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import DataLoader, Dataset

try:
    import open_clip
except ModuleNotFoundError as exc:
    raise SystemExit(
        "Missing dependency 'open_clip'. Install open_clip_torch from requirements.txt."
    ) from exc


SCRIPT_DIR = Path(__file__).resolve().parent
RETRAINER_PATH = SCRIPT_DIR / "10_Retrain_Taxonomy_Classifier.py"
spec = importlib.util.spec_from_file_location("taxonomy_head_retrainer", RETRAINER_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Could not load retrainer module: {RETRAINER_PATH}")
taxonomy_head_retrainer = importlib.util.module_from_spec(spec)
sys.modules["taxonomy_head_retrainer"] = taxonomy_head_retrainer
spec.loader.exec_module(taxonomy_head_retrainer)

BIOCLIP_MODEL = taxonomy_head_retrainer.BIOCLIP_MODEL
HierarchicalClassifier = taxonomy_head_retrainer.HierarchicalClassifier
DEFAULT_MANIFEST = taxonomy_head_retrainer.DEFAULT_MANIFEST
DEFAULT_BASE_MODEL = taxonomy_head_retrainer.DEFAULT_BASE_MODEL
DEFAULT_CANDIDATE = SCRIPT_DIR / "Data/taxonomy_classifier_backbone_candidate.pt"
DEFAULT_REPORT = SCRIPT_DIR / "Data/taxonomy_feedback/taxonomy_backbone_finetune_report.csv"
IMAGE_KINDS = ("well", "hires", "scan", "bottom")


class ImageViewDataset(Dataset):
    def __init__(self, examples: list[dict[str, Any]], order_to_idx: dict[str, int], transform) -> None:
        self.examples = examples
        self.order_to_idx = order_to_idx
        self.transform = transform

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, index: int):
        example = self.examples[index]
        with Image.open(example["path"]) as image:
            tensor = self.transform(image.convert("RGB"))
        return tensor, self.order_to_idx[example["order"]], example["specimen_key"]


def atomic_torch_save(payload: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        torch.save(payload, temp_path)
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)


def select_device(requested: str) -> torch.device:
    return taxonomy_head_retrainer.select_device(requested)


def stratified_specimen_split(specimens: list[Any], validation_fraction: float, seed: int) -> tuple[set[str], set[str]]:
    return taxonomy_head_retrainer.stratified_specimen_split(specimens, validation_fraction, seed)


def load_checkpoint(checkpoint_path: Path, device: torch.device):
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    species_names = list(checkpoint["species_names"])
    order_names = list(checkpoint["all_orders"])
    order_to_idx = {str(name): index for index, name in enumerate(order_names)}
    classifier = HierarchicalClassifier(
        embedding_dim=int(checkpoint.get("embedding_dim", 768)),
        hidden_dim=int(checkpoint.get("hidden_dim", 512)),
        num_species=len(species_names),
        num_orders=len(order_names),
        dropout=float(checkpoint.get("dropout", 0.30)),
    )
    classifier.load_state_dict(checkpoint["model_state_dict"])
    classifier.to(device)
    for parameter in classifier.parameters():
        parameter.requires_grad = False
    for parameter in classifier.order_head.parameters():
        parameter.requires_grad = True
    return checkpoint, classifier, order_names, order_to_idx


def load_bioclip(checkpoint: dict[str, Any], device: torch.device):
    model, _, preprocess = open_clip.create_model_and_transforms(BIOCLIP_MODEL)
    if "bioclip_state_dict" in checkpoint:
        model.load_state_dict(checkpoint["bioclip_state_dict"])
    model.to(device)
    for parameter in model.parameters():
        parameter.requires_grad = True
    return model, preprocess


def build_view_examples(specimens: list[Any], train_keys: set[str], val_keys: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    train: list[dict[str, Any]] = []
    val: list[dict[str, Any]] = []
    for specimen in specimens:
        key = taxonomy_head_retrainer.specimen_key(specimen)
        target = train if key in train_keys else val if key in val_keys else None
        if target is None:
            continue
        for view in IMAGE_KINDS:
            path = specimen.image_paths.get(view)
            if path is None:
                continue
            target.append({
                "specimen_key": key,
                "plate": specimen.plate,
                "well": specimen.well,
                "image_code": specimen.image_code,
                "order": specimen.order,
                "view": view,
                "path": path,
            })
    return train, val


def evaluate_specimens(bioclip, classifier, preprocess, specimens: list[Any], order_to_idx: dict[str, int], device: torch.device) -> dict[str, Any]:
    total = 0
    correct = 0
    by_order: dict[str, Counter[str]] = defaultdict(Counter)
    bioclip.eval()
    classifier.eval()
    with torch.inference_mode():
        for specimen in specimens:
            tensors = []
            for view in IMAGE_KINDS:
                path = specimen.image_paths.get(view)
                if path is None:
                    continue
                with Image.open(path) as image:
                    tensors.append(preprocess(image.convert("RGB")))
            if not tensors:
                continue
            images = torch.stack(tensors).to(device)
            embeddings = F.normalize(bioclip.encode_image(images).float(), p=2, dim=-1)
            _, logits = classifier(embeddings)
            probabilities = torch.softmax(logits.float(), dim=-1).mean(dim=0)
            prediction = int(probabilities.argmax().item())
            truth = order_to_idx[specimen.order]
            total += 1
            correct += int(prediction == truth)
            by_order[specimen.order]["total"] += 1
            if prediction == truth:
                by_order[specimen.order]["correct"] += 1
    return {
        "specimen_total": total,
        "specimen_correct": correct,
        "specimen_accuracy": correct / total if total else 0.0,
        "by_order": {
            order: {
                "total": counts["total"],
                "correct": counts["correct"],
                "accuracy": counts["correct"] / counts["total"] if counts["total"] else 0.0,
            }
            for order, counts in sorted(by_order.items())
        },
    }


def write_report(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--base-model", type=Path, default=DEFAULT_BASE_MODEL)
    parser.add_argument("--output", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--backbone-learning-rate", type=float, default=1e-6)
    parser.add_argument("--head-learning-rate", type=float, default=5e-5)
    parser.add_argument("--validation-fraction", type=float, default=0.20)
    parser.add_argument("--minimum-views", type=int, default=3)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--promote", action="store_true")
    args = parser.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = select_device(args.device)
    print(f"Device: {device}", flush=True)

    checkpoint, classifier, order_names, order_to_idx = load_checkpoint(args.base_model, device)
    specimens, discovery = taxonomy_head_retrainer.load_reviewed_specimens(
        manifest_path=args.manifest,
        valid_orders=set(order_to_idx),
        minimum_views=args.minimum_views,
    )
    if len(specimens) < 200:
        raise SystemExit(
            f"Backbone fine-tuning needs at least 200 reviewed specimens; found {len(specimens)}. "
            "Use weekly Order-head retraining until more labels accumulate."
        )
    if len(set(specimen.order for specimen in specimens)) < 3:
        raise SystemExit("Backbone fine-tuning needs at least 3 represented Orders.")

    train_keys, val_keys = stratified_specimen_split(specimens, args.validation_fraction, args.seed)
    train_views, val_views = build_view_examples(specimens, train_keys, val_keys)
    if not train_views or not val_views:
        raise SystemExit("Training/validation split produced no usable image views.")

    bioclip, preprocess = load_bioclip(checkpoint, device)
    train_loader = DataLoader(
        ImageViewDataset(train_views, order_to_idx, preprocess),
        batch_size=args.batch_size,
        shuffle=True,
    )

    class_counts = Counter(specimen.order for specimen in specimens if taxonomy_head_retrainer.specimen_key(specimen) in train_keys)
    class_weights = torch.zeros(len(order_names), dtype=torch.float32, device=device)
    total_train = max(1, sum(class_counts.values()))
    represented = max(1, len(class_counts))
    for order, count in class_counts.items():
        class_weights[order_to_idx[order]] = total_train / (represented * max(1, count))
    criterion = nn.CrossEntropyLoss(weight=class_weights)
    optimizer = torch.optim.AdamW(
        [
            {"params": bioclip.parameters(), "lr": args.backbone_learning_rate},
            {"params": classifier.order_head.parameters(), "lr": args.head_learning_rate},
        ]
    )

    print(
        f"Fine-tuning BioCLIP backbone: specimens={len(specimens):,} "
        f"train_views={len(train_views):,} val_specimens={len(val_keys):,}",
        flush=True,
    )
    val_specimens = [
        specimen for specimen in specimens
        if taxonomy_head_retrainer.specimen_key(specimen) in val_keys
    ]
    active_metrics = evaluate_specimens(
        bioclip, classifier, preprocess, val_specimens, order_to_idx, device
    )
    rows: list[dict[str, Any]] = []
    best_accuracy = -1.0
    best_bioclip_state = None
    best_classifier_state = None
    start = time.time()

    for epoch in range(1, args.epochs + 1):
        bioclip.train()
        classifier.train()
        running_loss = 0.0
        batches = 0
        for images, labels, _keys in train_loader:
            images = images.to(device)
            labels = labels.to(device)
            optimizer.zero_grad(set_to_none=True)
            embeddings = F.normalize(bioclip.encode_image(images).float(), p=2, dim=-1)
            _, logits = classifier(embeddings)
            loss = criterion(logits, labels)
            loss.backward()
            optimizer.step()
            running_loss += float(loss.item())
            batches += 1

        metrics = evaluate_specimens(bioclip, classifier, preprocess, val_specimens, order_to_idx, device)
        row = {
            "epoch": epoch,
            "training_loss": running_loss / max(1, batches),
            "validation_specimen_accuracy": metrics["specimen_accuracy"],
            "validation_specimen_correct": metrics["specimen_correct"],
            "validation_specimen_total": metrics["specimen_total"],
        }
        rows.append(row)
        print(json.dumps(row, sort_keys=True), flush=True)
        if float(metrics["specimen_accuracy"]) > best_accuracy:
            best_accuracy = float(metrics["specimen_accuracy"])
            best_bioclip_state = {key: value.detach().cpu().clone() for key, value in bioclip.state_dict().items()}
            best_classifier_state = {key: value.detach().cpu().clone() for key, value in classifier.state_dict().items()}

    if best_bioclip_state is None or best_classifier_state is None:
        raise SystemExit("Fine-tuning did not produce a candidate state.")

    output = dict(checkpoint)
    output["model_state_dict"] = best_classifier_state
    output["bioclip_state_dict"] = best_bioclip_state
    output["taxonomy_backbone_finetuning"] = {
        "training_mode": "bioclip_backbone_plus_order_head",
        "base_model": str(args.base_model),
        "manifest": str(args.manifest),
        "specimen_count": len(specimens),
        "class_counts": dict(sorted(Counter(specimen.order for specimen in specimens).items())),
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "backbone_learning_rate": args.backbone_learning_rate,
        "head_learning_rate": args.head_learning_rate,
        "best_validation_specimen_accuracy": best_accuracy,
        "elapsed_seconds": round(time.time() - start, 1),
        "created_at_unix": time.time(),
    }
    atomic_torch_save(output, args.output)
    write_report(args.report, rows)

    promoted = False
    backup_path = ""
    if args.promote:
        backup = args.base_model.with_suffix(args.base_model.suffix + f".backup_backbone_{int(time.time())}")
        if args.base_model.exists():
            shutil.copy2(args.base_model, backup)
            backup_path = str(backup)
        shutil.copy2(args.output, args.base_model)
        promoted = True

    summary = {
        "output": str(args.output),
        "candidate_model": str(args.output),
        "active_model": str(args.base_model),
        "report": str(args.report),
        "specimens": len(specimens),
        "best_validation_specimen_accuracy": best_accuracy,
        "active_validation_specimen_accuracy": active_metrics["specimen_accuracy"],
        "promotion_recommended": best_accuracy > active_metrics["specimen_accuracy"],
        "recommendation": (
            "Promote: the candidate improves validation specimen accuracy over the active BioCLIP model."
            if best_accuracy > active_metrics["specimen_accuracy"] else
            "Do not promote: the candidate does not improve validation specimen accuracy over the active BioCLIP model."
        ),
        "promoted": promoted,
        "backup": backup_path,
        "discovery": discovery,
    }
    print(json.dumps(summary, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
