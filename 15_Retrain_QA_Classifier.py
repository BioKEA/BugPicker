#!/usr/bin/env python3
"""Train a small BugPicker QA image classifier from reviewed QA labels.

This trains a local candidate model for either well QA or bottom/nozzle QA.
It does not change the live picker unless --promote is used and later live
integration chooses to load the promoted model.
"""

from __future__ import annotations

import argparse
import copy
import csv
import fcntl
import json
import os
import random
import re
import signal
import shutil
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
from PIL import Image, ImageDraw, ImageStat
from torch import nn
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms


SCRIPT_DIR = Path(__file__).resolve().parent
QA_FEEDBACK_DIR = SCRIPT_DIR / "Data/qa_feedback"
LABEL_FILES = {
    "well": QA_FEEDBACK_DIR / "well_qa_labels.jsonl",
    "nozzle": QA_FEEDBACK_DIR / "nozzle_qa_labels.jsonl",
}
CLASSES = {
    "well": ["empty_well", "occupied_well"],
    "nozzle": ["empty_nozzle", "specimen_present"],
}
NOZZLE_PRESENT_LABELS = {
    "single_specimen_on_nozzle",
    "multiple_specimens_on_nozzle",
    "bad_pickup_outside_nozzle",
    "specimen_present",
}
DEBRIS_BACKBONE = SCRIPT_DIR / "Data/insect_debris_classifier.pt"
NOZZLE_FRAMEWORK_VERSION = 2
NOZZLE_TIP_CROP_FRACTION = 0.55


@dataclass(frozen=True)
class Example:
    image_path: Path
    label: str
    record: dict[str, Any]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def iter_jsonl(path: Path):
    if not path.exists():
        return
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue


def load_examples(mode: str) -> list[Example]:
    latest: dict[str, Example] = {}
    allowed = set(CLASSES[mode])
    for record in iter_jsonl(LABEL_FILES[mode]) or []:
        source_label = str(record.get("user_label") or "").strip()
        if mode == "nozzle":
            label = "specimen_present" if source_label in NOZZLE_PRESENT_LABELS else source_label
        elif source_label in {"single_specimen_in_well", "multiple_specimens_in_well", "occupied_well"}:
            label = "occupied_well"
        else:
            label = source_label
        image_path = Path(str(record.get("image_path") or ""))
        if label not in allowed or not image_path.exists():
            continue
        if mode == "well" and not (
            "wells_top" in image_path.parts or "empty_well_captures" in image_path.parts
        ):
            continue
        latest[str(image_path.resolve())] = Example(image_path.resolve(), label, record)

    readable: list[Example] = []
    unreadable: list[tuple[Path, str]] = []
    for key in sorted(latest):
        example = latest[key]
        try:
            with Image.open(example.image_path) as image:
                image.convert("RGB").load()
        except (OSError, ValueError) as error:
            unreadable.append((example.image_path, str(error)))
            continue
        readable.append(example)

    for image_path, error in unreadable[:20]:
        print(f"Skipping unreadable QA image: {image_path} ({error})", flush=True)
    if unreadable:
        extra = len(unreadable) - min(20, len(unreadable))
        suffix = f"; {extra} additional path(s) omitted" if extra else ""
        print(
            f"Skipped {len(unreadable)} unreadable reviewed QA image(s){suffix}.",
            flush=True,
        )
    return readable


def unreviewed_post_pick_count() -> int:
    reviewed = {
        str(Path(str(record.get("image_path") or "")).resolve())
        for record in iter_jsonl(LABEL_FILES["nozzle"]) or []
        if record.get("image_path")
    }
    scans_root = SCRIPT_DIR.parent.parent / "scans"
    return sum(
        1
        for path in scans_root.glob("scan_*/bottom_inspections/*post_pick*_bottom.png")
        if str(path.resolve()) not in reviewed
    )


def example_group(example: Example) -> str:
    record = example.record
    capture_session = str(record.get("capture_session") or "").strip()
    if capture_session:
        return f"capture:{capture_session}"
    scan_id = str(record.get("scan_id") or "").strip()
    if scan_id:
        return f"scan:{scan_id}"
    return f"image:{example.image_path}"


def split_examples(
    examples: list[Example],
    validation_fraction: float,
    seed: int,
    forced_train_paths: set[str] | None = None,
) -> tuple[list[Example], list[Example]]:
    forced_train_paths = forced_train_paths or set()
    groups: dict[str, list[Example]] = {}
    for example in examples:
        groups.setdefault(example_group(example), []).append(example)

    shuffled_groups = list(groups.items())
    random.Random(seed).shuffle(shuffled_groups)
    label_counts: dict[str, int] = {}
    for example in examples:
        label_counts[example.label] = label_counts.get(example.label, 0) + 1
    val_targets = {label: max(1, round(count * validation_fraction)) for label, count in label_counts.items()}
    val_seen = {label: 0 for label in label_counts}
    val_group_names: set[str] = set()

    # A dedicated capture session alone is too easy a nozzle-empty holdout.
    # Reserve one real preflight/post-clean scan before filling the remainder.
    if "empty_nozzle" in label_counts and "specimen_present" in label_counts:
        realistic_empty_groups = [
            (name, members)
            for name, members in shuffled_groups
            if name.startswith("scan:")
            and any(
                member.label == "empty_nozzle"
                and member.record.get("review_source") != "empty_nozzle_capture"
                for member in members
            )
        ]
        if realistic_empty_groups:
            realistic_target = max(1, val_targets["empty_nozzle"] // 2)
            name, members = min(
                realistic_empty_groups,
                key=lambda item: abs(
                    realistic_target
                    - sum(member.label == "empty_nozzle" for member in item[1])
                ),
            )
            val_group_names.add(name)
            for member in members:
                val_seen[member.label] += 1

    for label in sorted(label_counts, key=lambda item: label_counts[item]):
        candidates = [
            (name, members)
            for name, members in shuffled_groups
            if name not in val_group_names
            and not any(str(member.image_path) in forced_train_paths for member in members)
            and any(member.label == label for member in members)
        ]
        candidates.sort(key=lambda item: sum(member.label == label for member in item[1]))
        while val_seen[label] < val_targets[label] and candidates:
            name, members = min(
                candidates,
                key=lambda item: abs(
                    val_targets[label]
                    - val_seen[label]
                    - sum(member.label == label for member in item[1])
                ),
            )
            candidates = [item for item in candidates if item[0] != name]
            val_group_names.add(name)
            for member in members:
                val_seen[member.label] += 1

    train: list[Example] = []
    val: list[Example] = []
    for group_name, members in groups.items():
        (val if group_name in val_group_names else train).extend(members)
    return train, val


class QaDataset(Dataset):
    def __init__(
        self,
        examples: list[Example],
        class_to_index: dict[str, int],
        transform,
        nozzle_tip_crop_fraction: float | None = None,
    ) -> None:
        self.examples = examples
        self.class_to_index = class_to_index
        self.transform = transform
        self.nozzle_tip_crop_fraction = nozzle_tip_crop_fraction

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, index: int):
        example = self.examples[index]
        image = Image.open(example.image_path).convert("RGB")
        if (
            example.label in {"empty_nozzle", "specimen_present"}
            and "_bottom_full" in example.image_path.stem
        ):
            # Runtime starts with the full Bottom-camera frame, while most reviewed
            # records point to the 50% capture crop. Normalize both to one view.
            image = FractionalCenterCrop(0.50)(image)
        if (
            example.label in {"empty_nozzle", "specimen_present"}
            and self.nozzle_tip_crop_fraction is not None
        ):
            image = FractionalCenterCrop(self.nozzle_tip_crop_fraction)(image)
        return self.transform(image), self.class_to_index[example.label]


class FractionalCenterCrop:
    def __init__(
        self,
        fraction: float,
        *,
        fraction_variation: float = 0.0,
        center_jitter: float = 0.0,
    ) -> None:
        self.fraction = fraction
        self.fraction_variation = fraction_variation
        self.center_jitter = center_jitter

    def __call__(self, image: Image.Image) -> Image.Image:
        width, height = image.size
        fraction = self.fraction
        if self.fraction_variation:
            fraction += random.uniform(-self.fraction_variation, self.fraction_variation)
        crop_width = max(1, min(width, round(width * fraction)))
        crop_height = max(1, min(height, round(height * fraction)))
        center_x = width / 2.0
        center_y = height / 2.0
        if self.center_jitter:
            center_x += random.uniform(-width * self.center_jitter, width * self.center_jitter)
            center_y += random.uniform(-height * self.center_jitter, height * self.center_jitter)
        left = max(0, min(width - crop_width, round(center_x - crop_width / 2.0)))
        top = max(0, min(height - crop_height, round(center_y - crop_height / 2.0)))
        return image.crop((left, top, left + crop_width, top + crop_height))


class CircularWellMask:
    def __init__(self, radius_fraction: float) -> None:
        self.radius_fraction = radius_fraction

    def __call__(self, image: Image.Image) -> Image.Image:
        image = image.convert("RGB")
        width, height = image.size
        radius = min(width, height) * self.radius_fraction
        center_x = width / 2.0
        center_y = height / 2.0
        mask = Image.new("L", image.size, 0)
        draw = ImageDraw.Draw(mask)
        draw.ellipse(
            (center_x - radius, center_y - radius, center_x + radius, center_y + radius),
            fill=255,
        )
        mean = tuple(round(value) for value in ImageStat.Stat(image).mean)
        background = Image.new("RGB", image.size, mean)
        return Image.composite(image, background, mask)


class SmallQaCnn(nn.Module):
    def __init__(self, class_count: int) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 24, kernel_size=5, stride=2, padding=2),
            nn.BatchNorm2d(24),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(24, 48, kernel_size=3, padding=1),
            nn.BatchNorm2d(48),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(48, 96, kernel_size=3, padding=1),
            nn.BatchNorm2d(96),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d((1, 1)),
        )
        self.classifier = nn.Linear(96, class_count)

    def forward(self, x):
        x = self.features(x)
        x = torch.flatten(x, 1)
        return self.classifier(x)


def build_qa_model(architecture: str, class_count: int) -> nn.Module:
    if architecture == "small_qa_cnn":
        return SmallQaCnn(class_count)
    if architecture == "efficientnet_b0":
        model = models.efficientnet_b0(weights=None)
        input_features = model.classifier[1].in_features
        model.classifier = nn.Sequential(
            nn.Dropout(p=0.25),
            nn.Linear(input_features, class_count),
        )
        return model
    raise ValueError(f"Unsupported QA architecture: {architecture}")


def initialize_efficientnet_backbone(model: nn.Module, checkpoint_path: Path) -> int:
    if not checkpoint_path.exists():
        return 0
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    source = checkpoint.get("model_state_dict", checkpoint)
    target = model.state_dict()
    compatible = {
        key: value
        for key, value in source.items()
        if key.startswith("features.")
        and key in target
        and target[key].shape == value.shape
    }
    model.load_state_dict(compatible, strict=False)
    return len(compatible)


def model_from_checkpoint(checkpoint: dict[str, Any]) -> nn.Module:
    classes = list(checkpoint.get("classes") or checkpoint.get("class_names") or [])
    architecture = str(checkpoint.get("architecture") or "small_qa_cnn")
    model = build_qa_model(architecture, len(classes))
    state_dict = checkpoint.get("state_dict") or checkpoint.get("model_state_dict")
    model.load_state_dict(state_dict)
    # QaDataset normalizes full Bottom-camera frames to the saved 50% crop.
    # Do not apply the checkpoint's live full-frame crop a second time while
    # evaluating either legacy or current models on reviewed dataset images.
    model.qa_center_crop_fraction = None
    model.qa_nozzle_tip_crop_fraction = checkpoint.get("nozzle_tip_crop_fraction")
    model.qa_well_mask_radius_fraction = checkpoint.get("well_mask_radius_fraction")
    return model


def qa_eval_transform(model: nn.Module):
    operations = []
    crop_fraction = getattr(model, "qa_center_crop_fraction", None)
    well_mask_fraction = getattr(model, "qa_well_mask_radius_fraction", None)
    if well_mask_fraction is not None:
        operations.append(CircularWellMask(float(well_mask_fraction)))
    if crop_fraction is not None:
        operations.append(FractionalCenterCrop(float(crop_fraction)))
    operations.extend([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])
    return transforms.Compose(operations)


def prediction_rows(
    model: nn.Module,
    examples: list[Example],
    classes: list[str],
    device: torch.device,
) -> list[dict[str, Any]]:
    transform = qa_eval_transform(model)
    placeholder_indices = {example.label: 0 for example in examples}
    placeholder_indices.update({label: index for index, label in enumerate(classes)})
    loader = DataLoader(
        QaDataset(
            examples,
            placeholder_indices,
            transform,
            getattr(model, "qa_nozzle_tip_crop_fraction", None),
        ),
        batch_size=16,
        shuffle=False,
        num_workers=0,
    )
    rows: list[dict[str, Any]] = []
    model.eval()
    offset = 0
    with torch.no_grad():
        for images, _labels in loader:
            probabilities = torch.softmax(model(images.to(device)), dim=1).cpu()
            for row_index in range(probabilities.shape[0]):
                example = examples[offset + row_index]
                prediction_index = int(torch.argmax(probabilities[row_index]).item())
                rows.append({
                    "image_path": str(example.image_path),
                    "truth": example.label,
                    "prediction": classes[prediction_index],
                    "confidence": float(probabilities[row_index, prediction_index].item()),
                    "probabilities": {
                        label: float(probabilities[row_index, index].item())
                        for index, label in enumerate(classes)
                    },
                    "group": example_group(example),
                })
            offset += probabilities.shape[0]
    return rows


def previous_false_empty_paths(candidate_path: Path, examples: list[Example]) -> set[str]:
    if not candidate_path.exists():
        return set()
    try:
        report_path = candidate_path.with_name("nozzle_qa_classifier_report.json")
        if report_path.exists():
            report = json.loads(report_path.read_text(encoding="utf-8"))
            if "high_confidence_false_empty_examples" in report:
                paths = {
                    str(row["image_path"])
                    for row in report.get("high_confidence_false_empty_examples") or []
                    if row.get("image_path")
                }
                print(f"Loaded {len(paths)} prior false-empty hard examples from the report.", flush=True)
                return paths
        print(
            f"Evaluating previous candidate across {len(examples)} images for hard examples...",
            flush=True,
        )
        checkpoint = torch.load(candidate_path, map_location="cpu", weights_only=False)
        prior_classes = list(checkpoint.get("classes") or [])
        if "empty_nozzle" not in prior_classes:
            return set()
        model = model_from_checkpoint(checkpoint)
        rows = prediction_rows(model, examples, prior_classes, torch.device("cpu"))
        hard_paths = {
            row["image_path"]
            for row in rows
            if row["truth"] == "specimen_present"
            and row["prediction"] == "empty_nozzle"
        }
        print(f"Found {len(hard_paths)} prior false-empty hard examples.", flush=True)
        return hard_paths
    except Exception as error:
        print(f"Could not mine prior false-empty examples: {error}", flush=True)
        return set()


def labels_reviewed_since_model(checkpoint_path: Path, examples: list[Example]) -> set[str]:
    if not checkpoint_path.exists():
        return set()
    try:
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        trained_at = datetime.fromisoformat(str(checkpoint.get("trained_at") or ""))
    except (OSError, ValueError, TypeError, KeyError):
        return set()
    paths: set[str] = set()
    for example in examples:
        try:
            reviewed_at = datetime.fromisoformat(str(example.record.get("reviewed_at") or ""))
        except (ValueError, TypeError):
            continue
        if reviewed_at > trained_at:
            paths.add(str(example.image_path))
    return paths


def calibrated_nozzle_decision(predictions: list[dict[str, Any]]) -> dict[str, Any]:
    present_probabilities = [
        row["probabilities"]["empty_nozzle"]
        for row in predictions
        if row["truth"] == "specimen_present"
    ]
    threshold = min(0.99, max(0.50, max(present_probabilities, default=0.50) + 0.02))
    empty_rows = [row for row in predictions if row["truth"] == "empty_nozzle"]
    present_rows = [row for row in predictions if row["truth"] == "specimen_present"]
    true_empty_clear = sum(
        row["probabilities"]["empty_nozzle"] >= threshold for row in empty_rows
    )
    false_empty = sum(
        row["probabilities"]["empty_nozzle"] >= threshold for row in present_rows
    )
    return {
        "empty_confidence_threshold": threshold,
        "false_empty_count": false_empty,
        "specimen_frames": len(present_rows),
        "specimen_safety_recall": (
            (len(present_rows) - false_empty) / len(present_rows) if present_rows else 0.0
        ),
        "true_empty_clear_count": true_empty_clear,
        "empty_frames": len(empty_rows),
        "true_empty_clear_rate": true_empty_clear / len(empty_rows) if empty_rows else 0.0,
    }


def nozzle_pair_key(row: dict[str, Any]) -> str:
    path = Path(str(row.get("image_path") or ""))
    match = re.match(
        r"(target_\d+_object_\d+)_\d{8}_\d{6}_(.+)_sample_\d+_bottom(?:_full)?$",
        path.stem,
    )
    if match:
        return f"{path.parent}:{match.group(1)}:{match.group(2)}"
    return str(path)


def calibrated_nozzle_pair_decision(predictions: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in predictions:
        grouped.setdefault(nozzle_pair_key(row), []).append(row)
    pairs: list[dict[str, Any]] = []
    for key, rows in grouped.items():
        labels = {str(row["truth"]) for row in rows}
        if len(labels) != 1:
            continue
        pairs.append({
            "pair_key": key,
            "truth": next(iter(labels)),
            # Live inspection clears only when every frame clears.
            "empty_probability": min(
                float(row["probabilities"]["empty_nozzle"]) for row in rows
            ),
            "frame_count": len(rows),
        })
    present = [row for row in pairs if row["truth"] == "specimen_present"]
    empty = [row for row in pairs if row["truth"] == "empty_nozzle"]
    threshold = min(
        0.99,
        max(0.50, max((row["empty_probability"] for row in present), default=0.50) + 0.02),
    )
    false_empty = sum(row["empty_probability"] >= threshold for row in present)
    true_empty_clear = sum(row["empty_probability"] >= threshold for row in empty)
    return {
        "empty_confidence_threshold": threshold,
        "false_empty_pair_count": false_empty,
        "specimen_pairs": len(present),
        "true_empty_pair_clear_count": true_empty_clear,
        "empty_pairs": len(empty),
        "true_empty_pair_clear_rate": true_empty_clear / len(empty) if empty else 0.0,
        "paired_frame_groups": sum(row["frame_count"] >= 2 for row in pairs),
    }


def evaluate_checkpoint(
    path: Path,
    examples: list[Example],
    expected_classes: list[str],
) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        checkpoint = torch.load(path, map_location="cpu", weights_only=False)
        classes = list(checkpoint.get("classes") or [])
        if classes != expected_classes:
            return {"compatible": False, "reason": "active model classes do not match the candidate"}
        model = model_from_checkpoint(checkpoint)
        predictions = prediction_rows(model, examples, classes, torch.device("cpu"))
        loader = DataLoader(
            QaDataset(
                examples,
                {label: index for index, label in enumerate(classes)},
                qa_eval_transform(model),
                getattr(model, "qa_nozzle_tip_crop_fraction", None),
            ),
            batch_size=16,
            shuffle=False,
            num_workers=0,
        )
        result = {
            "compatible": True,
            "metrics": evaluate(model, loader, torch.device("cpu"), classes),
        }
        if classes == ["empty_nozzle", "specimen_present"]:
            result["decision"] = calibrated_nozzle_decision(predictions)
            result["pair_decision"] = calibrated_nozzle_pair_decision(predictions)
        return result
    except Exception as error:
        return {"compatible": False, "reason": str(error)}


def evaluate(model: nn.Module, loader: DataLoader, device: torch.device, classes: list[str]) -> dict[str, Any]:
    model.eval()
    correct = 0
    total = 0
    confusion = {(truth, pred): 0 for truth in classes for pred in classes}
    with torch.no_grad():
        for images, labels in loader:
            images = images.to(device)
            labels = labels.to(device)
            logits = model(images)
            preds = torch.argmax(logits, dim=1)
            correct += int((preds == labels).sum().item())
            total += int(labels.numel())
            for truth_idx, pred_idx in zip(labels.cpu().tolist(), preds.cpu().tolist()):
                confusion[(classes[truth_idx], classes[pred_idx])] += 1
    class_totals = {
        truth: sum(confusion[(truth, pred)] for pred in classes)
        for truth in classes
    }
    class_correct = {label: confusion[(label, label)] for label in classes}
    per_class_recall = {
        label: class_correct[label] / class_totals[label]
        for label in classes
        if class_totals[label]
    }
    return {
        "total": total,
        "accuracy": (correct / total) if total else 0.0,
        "balanced_accuracy": (
            sum(per_class_recall.values()) / len(per_class_recall)
            if per_class_recall else 0.0
        ),
        "per_class_recall": per_class_recall,
        "per_class_total": {
            label: count for label, count in class_totals.items() if count
        },
        "confusion": {
            f"{truth} -> {pred}": count
            for (truth, pred), count in sorted(confusion.items())
            if count
        },
    }


def write_manifest(path: Path, examples: list[Example]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["image_path", "label", "scan_id", "plate_number", "well", "target_number"])
        writer.writeheader()
        for example in examples:
            writer.writerow({
                "image_path": str(example.image_path),
                "label": example.label,
                "scan_id": example.record.get("scan_id", ""),
                "plate_number": example.record.get("plate_number", ""),
                "well": example.record.get("well", ""),
                "target_number": example.record.get("target_number", ""),
            })


def train_efficientnet_run(
    train_examples: list[Example],
    val_examples: list[Example],
    class_to_index: dict[str, int],
    classes: list[str],
    transform_train,
    transform_eval,
    class_weights: list[float],
    device: torch.device,
    *,
    epochs: int,
    head_epochs: int,
    batch_size: int,
    learning_rate: float,
    seed: int,
    run_number: int,
    center_crop_fraction: float | None,
    well_mask_radius_fraction: float | None,
    initialization_checkpoint: Path | None,
    nozzle_tip_crop_fraction: float | None,
) -> dict[str, Any]:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)

    generator = torch.Generator().manual_seed(seed)
    train_loader = DataLoader(
        QaDataset(train_examples, class_to_index, transform_train, nozzle_tip_crop_fraction),
        batch_size=batch_size,
        shuffle=True,
        num_workers=0,
        generator=generator,
    )
    val_loader = DataLoader(
        QaDataset(val_examples, class_to_index, transform_eval, nozzle_tip_crop_fraction),
        batch_size=batch_size,
        shuffle=False,
        num_workers=0,
    )
    model = build_qa_model("efficientnet_b0", len(classes))
    model.qa_center_crop_fraction = center_crop_fraction
    model.qa_well_mask_radius_fraction = well_mask_radius_fraction
    model.qa_nozzle_tip_crop_fraction = nozzle_tip_crop_fraction
    initialization_source = "debris_backbone"
    warm_started = False
    if initialization_checkpoint is not None and initialization_checkpoint.exists():
        checkpoint = torch.load(initialization_checkpoint, map_location="cpu", weights_only=False)
        if list(checkpoint.get("classes") or []) == classes:
            model.load_state_dict(checkpoint["state_dict"])
            initialized_backbone_tensors = len(model.state_dict())
            initialization_source = str(initialization_checkpoint)
            warm_started = True
        else:
            initialized_backbone_tensors = initialize_efficientnet_backbone(model, DEBRIS_BACKBONE)
    else:
        initialized_backbone_tensors = initialize_efficientnet_backbone(model, DEBRIS_BACKBONE)
    for parameter in model.features.parameters():
        parameter.requires_grad = False
    model.to(device)
    effective_learning_rate = learning_rate * (0.25 if warm_started else 1.0)
    optimizer = torch.optim.AdamW(
        model.classifier.parameters(), lr=effective_learning_rate, weight_decay=0.01
    )
    loss_fn = nn.CrossEntropyLoss(
        weight=torch.tensor(class_weights, dtype=torch.float32, device=device)
    )

    history: list[dict[str, Any]] = []
    best_state = None
    best_score = -1.0
    consecutive_perfect_epochs = 0
    for epoch in range(1, epochs + 1):
        if epoch == head_epochs + 1:
            fine_tune_features = model.features[-6:] if nozzle_tip_crop_fraction is not None else model.features[-3:]
            for parameter in fine_tune_features.parameters():
                parameter.requires_grad = True
            optimizer = torch.optim.AdamW(
                [
                    {"params": model.classifier.parameters(), "lr": effective_learning_rate * 0.20},
                    {"params": fine_tune_features.parameters(), "lr": effective_learning_rate * 0.05},
                ],
                weight_decay=0.01,
            )
        model.train()
        total_loss = 0.0
        total_seen = 0
        for images, labels in train_loader:
            images = images.to(device)
            labels = labels.to(device)
            optimizer.zero_grad(set_to_none=True)
            logits = model(images)
            loss = loss_fn(logits, labels)
            loss.backward()
            optimizer.step()
            total_loss += float(loss.item()) * int(labels.numel())
            total_seen += int(labels.numel())
        val_metrics = evaluate(model, val_loader, device, classes)
        record = {
            "run": run_number,
            "seed": seed,
            "epoch": epoch,
            "phase": "head" if epoch <= head_epochs else "fine_tune",
            "train_loss": (total_loss / total_seen) if total_seen else 0.0,
            "validation_accuracy": val_metrics["accuracy"],
            "balanced_accuracy": val_metrics["balanced_accuracy"],
        }
        history.append(record)
        if val_metrics["balanced_accuracy"] > best_score:
            best_score = val_metrics["balanced_accuracy"]
            best_state = copy.deepcopy(model.state_dict())
        consecutive_perfect_epochs = (
            consecutive_perfect_epochs + 1
            if val_metrics["balanced_accuracy"] >= 0.999999 else 0
        )
        print(
            f"run {run_number} epoch {epoch}/{epochs} phase={record['phase']} "
            f"loss={record['train_loss']:.4f} val_accuracy={record['validation_accuracy']:.3f} "
            f"balanced_accuracy={record['balanced_accuracy']:.3f}",
            flush=True,
        )
        if epoch > head_epochs and consecutive_perfect_epochs >= 2:
            print(
                f"run {run_number} early stop after two consecutive perfect validation epochs",
                flush=True,
            )
            break

    if best_state is not None:
        model.load_state_dict(best_state)
    return {
        "model": model,
        "history": history,
        "best_balanced_accuracy": best_score,
        "initialized_backbone_tensors": initialized_backbone_tensors,
        "initialization_source": initialization_source,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("well", "nozzle"), required=True)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--head-epochs", type=int, default=2)
    parser.add_argument("--skip-hard-mining", action="store_true")
    parser.add_argument("--parent-pid", type=int)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=0.001)
    parser.add_argument("--validation-fraction", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--promote", action="store_true")
    args = parser.parse_args()

    # Leave CPU capacity for OpenPnP motion, cameras, and live QA inference.
    training_threads = max(1, min(4, os.cpu_count() or 1))
    torch.set_num_threads(training_threads)
    torch.set_num_interop_threads(1)
    print(f"QA training CPU threads: {training_threads}", flush=True)

    QA_FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = QA_FEEDBACK_DIR / f"{args.mode}_qa_training.lock"
    lock_handle = lock_path.open("w", encoding="utf-8")
    try:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(
            f"Another {args.mode} QA training process is already running. "
            f"Lock: {lock_path}"
        )
    lock_handle.write(f"pid={os.getpid()}\nstarted={utc_now()}\n")
    lock_handle.flush()

    if args.parent_pid:
        expected_parent_pid = args.parent_pid

        def stop_when_parent_exits() -> None:
            while True:
                time.sleep(2.0)
                if os.getppid() != expected_parent_pid:
                    os.kill(os.getpid(), signal.SIGTERM)
                    return

        threading.Thread(
            target=stop_when_parent_exits,
            name="openpnp-parent-monitor",
            daemon=True,
        ).start()

    examples = load_examples(args.mode)
    if len(examples) < 20:
        raise SystemExit(f"Need at least 20 reviewed {args.mode} QA examples; found {len(examples)}.")
    print(
        f"Loaded {len(examples)} reviewed {args.mode} QA examples; "
        f"starting {args.runs} training run(s).",
        flush=True,
    )

    classes = CLASSES[args.mode]
    class_to_index = {label: index for index, label in enumerate(classes)}
    class_counts = {
        label: sum(1 for example in examples if example.label == label)
        for label in classes
    }
    minimum_per_class = 20
    undersized_classes = {
        label: count for label, count in class_counts.items()
        if count < minimum_per_class
    }
    if undersized_classes:
        details = ", ".join(
            f"{label}={count}" for label, count in undersized_classes.items()
        )
        raise SystemExit(
            f"Need at least {minimum_per_class} reviewed examples of every {args.mode} "
            f"QA class before training; insufficient classes: {details}."
        )
    output_dir = QA_FEEDBACK_DIR / "models"
    candidate_model = output_dir / f"{args.mode}_qa_classifier_candidate.pt"
    active_model = output_dir / f"{args.mode}_qa_classifier.pt"
    mined_hard_paths = (
        previous_false_empty_paths(candidate_model, examples)
        if args.mode == "nozzle" and not args.skip_hard_mining else set()
    )
    if args.mode == "nozzle" and args.skip_hard_mining:
        print(
            "Skipping prior-model hard-example mining; using reviewed labels directly.",
            flush=True,
        )
    newly_reviewed_paths = (
        labels_reviewed_since_model(active_model, examples)
        if args.mode == "nozzle" else set()
    )
    if newly_reviewed_paths:
        print(
            f"Forcing {len(newly_reviewed_paths)} labels reviewed since the active model into training.",
            flush=True,
        )
    train_examples, val_examples = split_examples(
        examples,
        args.validation_fraction,
        args.seed,
        forced_train_paths=mined_hard_paths | newly_reviewed_paths,
    )
    if not train_examples or not val_examples:
        raise SystemExit("Training/validation split is empty.")

    nozzle_tip_crop_fraction = NOZZLE_TIP_CROP_FRACTION if args.mode == "nozzle" else None
    runtime_crop_fraction = (
        0.50 * nozzle_tip_crop_fraction
        if nozzle_tip_crop_fraction is not None else None
    )
    well_mask_fraction = 0.36 if args.mode == "well" else None
    train_operations = []
    if well_mask_fraction is not None:
        train_operations.append(CircularWellMask(well_mask_fraction))
    train_operations.extend([
        transforms.Resize((224, 224)),
        (
            transforms.RandomAffine(
                degrees=180,
                translate=(0.06, 0.06),
                scale=(0.92, 1.08),
                fill=0,
            )
            if args.mode == "nozzle" else
            transforms.RandomRotation(8)
        ),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(brightness=0.20, contrast=0.20, saturation=0.12),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])
    transform_train = transforms.Compose(train_operations)
    eval_operations = []
    if well_mask_fraction is not None:
        eval_operations.append(CircularWellMask(well_mask_fraction))
    eval_operations.extend([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])
    transform_eval = transforms.Compose(eval_operations)

    val_loader = DataLoader(
        QaDataset(
            val_examples,
            class_to_index,
            transform_eval,
            nozzle_tip_crop_fraction,
        ),
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
    )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    train_class_counts = {
        label: sum(1 for example in train_examples if example.label == label)
        for label in classes
    }
    largest_class = max(train_class_counts.values())
    raw_weights = [
        (largest_class / train_class_counts[label]) ** 0.5
        if train_class_counts[label] else 0.0
        for label in classes
    ]
    nonzero_weights = [weight for weight in raw_weights if weight > 0]
    weight_scale = sum(nonzero_weights) / len(nonzero_weights)
    class_weights = [weight / weight_scale for weight in raw_weights]
    run_results = []
    for run_index in range(args.runs):
        run_results.append(train_efficientnet_run(
            train_examples,
            val_examples,
            class_to_index,
            classes,
            transform_train,
            transform_eval,
            class_weights,
            device,
            epochs=args.epochs,
            head_epochs=min(args.head_epochs, args.epochs),
            batch_size=args.batch_size,
            learning_rate=args.learning_rate,
            seed=args.seed + run_index,
            run_number=run_index + 1,
            center_crop_fraction=None,
            well_mask_radius_fraction=well_mask_fraction,
            initialization_checkpoint=(active_model if args.mode == "nozzle" else None),
            nozzle_tip_crop_fraction=nozzle_tip_crop_fraction,
        ))
    selected_run_index = max(
        range(len(run_results)),
        key=lambda index: run_results[index]["best_balanced_accuracy"],
    )
    selected_run = run_results[selected_run_index]
    model = selected_run["model"]
    history = [record for result in run_results for record in result["history"]]
    validation_miss_counts: dict[str, int] = {}
    for result in run_results:
        for row in prediction_rows(result["model"], val_examples, classes, device):
            if row["prediction"] != row["truth"]:
                validation_miss_counts[row["image_path"]] = (
                    validation_miss_counts.get(row["image_path"], 0) + 1
                )
    final_metrics = evaluate(model, val_loader, device, classes)
    output_dir.mkdir(parents=True, exist_ok=True)
    promoted_model = output_dir / f"{args.mode}_qa_classifier.pt"
    report_path = output_dir / f"{args.mode}_qa_classifier_report.json"
    train_manifest = output_dir / f"{args.mode}_qa_train_manifest.csv"
    val_manifest = output_dir / f"{args.mode}_qa_validation_manifest.csv"

    validation_predictions = prediction_rows(model, val_examples, classes, device)
    nozzle_decision = (
        calibrated_nozzle_decision(validation_predictions)
        if args.mode == "nozzle" else None
    )
    nozzle_pair_decision = (
        calibrated_nozzle_pair_decision(validation_predictions)
        if args.mode == "nozzle" else None
    )
    active_evaluation = evaluate_checkpoint(promoted_model, val_examples, classes)
    candidate_recommended = False
    recommendation = "Review validation metrics before promotion."
    post_pick_review_backlog = unreviewed_post_pick_count() if args.mode == "nozzle" else 0
    if nozzle_decision is not None:
        candidate_gate = (
            nozzle_pair_decision["false_empty_pair_count"] == 0
            and nozzle_pair_decision["true_empty_pair_clear_rate"] >= 0.50
            and final_metrics["balanced_accuracy"] >= 0.90
            and post_pick_review_backlog == 0
        )
        if not candidate_gate:
            recommendation = (
                f"Do not promote: review the remaining {post_pick_review_backlog} "
                "post-pick nozzle frames, then audit this candidate."
                if post_pick_review_backlog else
                "Do not promote: the candidate does not yet meet the nozzle safety "
                "and empty-clearance gates."
            )
        elif active_evaluation is None or not active_evaluation.get("compatible"):
            candidate_recommended = True
            recommendation = (
                "Promote: the candidate meets the safety and empty-clearance gates; "
                "there is no compatible active model to outperform."
            )
        else:
            active_decision = active_evaluation["pair_decision"]
            candidate_recommended = (
                nozzle_pair_decision["false_empty_pair_count"]
                    <= active_decision["false_empty_pair_count"]
                and nozzle_pair_decision["true_empty_pair_clear_rate"]
                    > active_decision["true_empty_pair_clear_rate"]
            )
            recommendation = (
                "Promote: the candidate improves empty clearance without increasing false-empty decisions."
                if candidate_recommended else
                "Do not promote: the candidate does not improve safely on the active model."
            )
    else:
        active_metrics = (
            active_evaluation.get("metrics", {})
            if active_evaluation and active_evaluation.get("compatible") else {}
        )
        if not active_metrics:
            candidate_recommended = final_metrics["balanced_accuracy"] >= 0.80
            recommendation = (
                "Promote: the candidate has acceptable balanced validation accuracy and no compatible active model exists."
                if candidate_recommended else
                "Do not promote: balanced validation accuracy is below 80%."
            )
        else:
            candidate_recommended = (
                final_metrics["balanced_accuracy"] > active_metrics.get("balanced_accuracy", 0.0)
            )
            recommendation = (
                "Promote: the candidate improves balanced validation accuracy over the active well QA model."
                if candidate_recommended else
                "Do not promote: the candidate does not improve balanced validation accuracy over the active well QA model."
            )
    false_empty_examples = [
        row for row in validation_predictions
        if row["truth"] == "specimen_present"
        and nozzle_pair_decision is not None
        and row["probabilities"].get("empty_nozzle", 0.0)
            >= nozzle_pair_decision["empty_confidence_threshold"]
    ] if args.mode == "nozzle" else []

    checkpoint = {
        "mode": args.mode,
        "classes": classes,
        "class_counts": class_counts,
        "training_class_weights": {
            label: class_weights[index]
            for index, label in enumerate(classes)
        },
        "model": "EfficientNetB0",
        "architecture": "efficientnet_b0",
        "state_dict": model.cpu().state_dict(),
        "trained_at": utc_now(),
        "image_size": 224,
        "normalization_mean": [0.485, 0.456, 0.406],
        "normalization_std": [0.229, 0.224, 0.225],
        "center_crop_fraction": runtime_crop_fraction,
        "dataset_normalizes_full_nozzle_frame": args.mode == "nozzle",
        "nozzle_framework_version": NOZZLE_FRAMEWORK_VERSION if args.mode == "nozzle" else None,
        "nozzle_tip_crop_fraction": nozzle_tip_crop_fraction,
        "well_mask_radius_fraction": well_mask_fraction,
        "training_rotation_degrees": 180 if args.mode == "nozzle" else 8,
        "training_translation_fraction": 0.06 if args.mode == "nozzle" else 0.0,
        "empty_confidence_threshold": (
            nozzle_pair_decision["empty_confidence_threshold"]
            if nozzle_pair_decision is not None else None
        ),
    }
    torch.save(checkpoint, candidate_model)
    write_manifest(train_manifest, train_examples)
    write_manifest(val_manifest, val_examples)

    report = {
        "mode": args.mode,
        "nozzle_framework_version": (
            NOZZLE_FRAMEWORK_VERSION if args.mode == "nozzle" else None
        ),
        "nozzle_tip_crop_fraction": nozzle_tip_crop_fraction,
        "trained_at": utc_now(),
        "device": str(device),
        "examples_total": len(examples),
        "train_examples": len(train_examples),
        "validation_examples": len(val_examples),
        "classes": classes,
        "class_counts": class_counts,
        "training_class_weights": {
            label: class_weights[index]
            for index, label in enumerate(classes)
        },
        "history": history,
        "training_runs": args.runs,
        "epochs_per_run": args.epochs,
        "head_epochs": min(args.head_epochs, args.epochs),
        "selected_run": selected_run_index + 1,
        "selected_seed": args.seed + selected_run_index,
        "initialized_backbone_tensors": selected_run["initialized_backbone_tensors"],
        "initialization_source": selected_run["initialization_source"],
        "validation": final_metrics,
        "operational_decision": nozzle_decision,
        "operational_pair_decision": nozzle_pair_decision,
        "active_model_evaluation": active_evaluation,
        "promotion_recommended": candidate_recommended,
        "recommendation": recommendation,
        "unreviewed_post_pick_frames": post_pick_review_backlog,
        "training_group_count": len({example_group(example) for example in train_examples}),
        "validation_group_count": len({example_group(example) for example in val_examples}),
        "groups_overlap": bool(
            {example_group(example) for example in train_examples}
            & {example_group(example) for example in val_examples}
        ),
        "mined_prior_false_empty_examples": sorted(mined_hard_paths),
        "newly_reviewed_training_examples": sorted(newly_reviewed_paths),
        "high_confidence_false_empty_examples": false_empty_examples,
        "validation_miss_counts": validation_miss_counts,
        "candidate_model": str(candidate_model),
        "promoted_model": str(promoted_model) if args.promote else "",
        "train_manifest": str(train_manifest),
        "validation_manifest": str(val_manifest),
    }
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.promote:
        shutil.copy2(candidate_model, promoted_model)
    print(f"Saved candidate model: {candidate_model}", flush=True)
    print(f"Saved report: {report_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
