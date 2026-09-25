#!/usr/bin/env python3
"""10: Retrain the BugPicker taxonomy Order head from reviewed plate labels.

This script mirrors the insect/debris retraining workflow:

- Human-reviewed Order labels come from Data/taxonomy_feedback/taxonomy_training_manifest.jsonl.
- Specimen images come from Plate_insect_images/P-<plate>/.
- BioCLIP stays frozen.
- The hierarchical classifier's shared layer and species head stay frozen.
- Only the direct Order head is fine-tuned.
- A candidate checkpoint is written by default.
- --promote backs up and replaces Data/taxonomy_classifier.pt.

The BioCLIP embedding cache is incremental, so subsequent retraining runs only
need to embed new or changed specimen images.
"""

from __future__ import annotations

import argparse
import json
import random
import shutil
import tempfile
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
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

from taxonomy_classifier import BIOCLIP_MODEL, HierarchicalClassifier


# ============================================================
# PATHS
# ============================================================

SCRIPT_DIR = Path(__file__).resolve().parent

# Support both layouts used by BugPicker:
#   project/scripts/BugPicker/<this file>
#   project/<this file>
if SCRIPT_DIR.name == "BugPicker" and SCRIPT_DIR.parent.name == "scripts":
    PROJECT_ROOT = SCRIPT_DIR.parents[1]
else:
    PROJECT_ROOT = SCRIPT_DIR

DEFAULT_PLATE_IMAGE_DIR = PROJECT_ROOT / "Plate_insect_images"
DEFAULT_BASE_MODEL = SCRIPT_DIR / "Data/taxonomy_classifier.pt"
DEFAULT_CANDIDATE = SCRIPT_DIR / "Data/taxonomy_classifier_candidate.pt"
DEFAULT_FEEDBACK_DIR = SCRIPT_DIR / "Data/taxonomy_feedback"
DEFAULT_MANIFEST = DEFAULT_FEEDBACK_DIR / "taxonomy_training_manifest.jsonl"
DEFAULT_CACHE = DEFAULT_FEEDBACK_DIR / "taxonomy_embedding_cache.pt"
DEFAULT_REPORT = DEFAULT_FEEDBACK_DIR / "taxonomy_retrain_report.csv"

IMAGE_KINDS = ("scan", "well", "bottom", "hires")
INVALID_LABELS = {"", "nan", "none", "null", "<blank>", "blank", "unknown", "unidentified"}


# ============================================================
# DATA STRUCTURES
# ============================================================

@dataclass(frozen=True)
class SpecimenRecord:
    plate: str
    well: str
    image_code: str
    order: str
    image_paths: dict[str, Path]


@dataclass(frozen=True)
class EmbeddedView:
    specimen_key: str
    plate: str
    well: str
    image_code: str
    order: str
    view: str
    image_path: str
    embedding: torch.Tensor


class ViewEmbeddingDataset(Dataset):
    def __init__(
        self,
        examples: list[EmbeddedView],
        order_to_idx: dict[str, int],
    ) -> None:
        self.examples = examples
        self.order_to_idx = order_to_idx

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, index: int):
        example = self.examples[index]
        return example.embedding.float(), self.order_to_idx[example.order]


# ============================================================
# HELPERS
# ============================================================

def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def normalize_order(value: Any) -> str:
    text = normalize_text(value)
    if text.lower() in INVALID_LABELS:
        return ""
    text = text.rstrip("?").strip()
    if not text:
        return ""
    return text


def normalize_plate(value: Any) -> str:
    text = normalize_text(value).upper()
    return "".join(ch for ch in text if ch.isalnum() or ch in "_-")


def select_device(requested: str) -> torch.device:
    requested = requested.strip().lower()
    if requested != "auto":
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def specimen_key(record: SpecimenRecord) -> str:
    return f"{record.plate}:{record.image_code}"


def image_signature(path: Path) -> str:
    stat = path.stat()
    return f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}"


def atomic_torch_save(payload: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    Path(temp_name).unlink(missing_ok=True)
    try:
        torch.save(payload, temp_name)
        Path(temp_name).replace(path)
    finally:
        try:
            Path(temp_name).unlink(missing_ok=True)
        finally:
            try:
                import os
                os.close(fd)
            except OSError:
                pass


def write_report(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    import csv

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


# ============================================================
# DISCOVER REVIEWED SPECIMENS
# ============================================================

def iter_jsonl(path: Path):
    if not path.exists():
        return
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def load_reviewed_specimens(
    manifest_path: Path,
    valid_orders: set[str],
    minimum_views: int,
) -> tuple[list[SpecimenRecord], dict[str, int]]:
    records: dict[str, SpecimenRecord] = {}
    stats = {
        "rows": 0,
        "missing_order": 0,
        "unsupported_order": 0,
        "missing_image_code": 0,
        "insufficient_views": 0,
        "non_same_specimen": 0,
        "usable_specimens": 0,
    }

    for row in iter_jsonl(manifest_path) or []:
        stats["rows"] += 1
        consistency = normalize_text(row.get("image_consistency"))
        if consistency and consistency != "Same specimen across images":
            stats["non_same_specimen"] += 1
            continue

        order = normalize_order(row.get("order"))
        if not order:
            stats["missing_order"] += 1
            continue
        if order not in valid_orders:
            stats["unsupported_order"] += 1
            continue

        plate = normalize_plate(row.get("plate"))
        image_code = normalize_text(row.get("image_code"))
        if image_code.lower() in INVALID_LABELS:
            image_code = ""
        if not image_code:
            stats["missing_image_code"] += 1
            continue

        raw_paths = row.get("image_paths")
        if not isinstance(raw_paths, dict):
            raw_paths = {}
        paths: dict[str, Path] = {}
        for kind in IMAGE_KINDS:
            value = raw_paths.get(kind)
            if not value:
                continue
            path = Path(str(value))
            if path.exists():
                paths[kind] = path.resolve()
        if len(paths) < minimum_views:
            stats["insufficient_views"] += 1
            continue

        record = SpecimenRecord(
            plate=plate,
            well=normalize_text(row.get("well")),
            image_code=image_code,
            order=order,
            image_paths=paths,
        )
        records[specimen_key(record)] = record

    result = list(records.values())
    result.sort(key=lambda item: (item.plate, item.image_code))
    stats["usable_specimens"] = len(result)
    return result, stats


# ============================================================
# EMBEDDING CACHE
# ============================================================

def load_cache(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        payload = torch.load(path, map_location="cpu", weights_only=False)
    except Exception as exc:
        print(f"WARNING: Could not read embedding cache {path}: {exc}", flush=True)
        return {}

    if isinstance(payload, dict) and "entries" in payload:
        entries = payload["entries"]
        if isinstance(entries, dict):
            return entries
    if isinstance(payload, dict):
        return payload
    return {}


def save_cache(path: Path, entries: dict[str, dict[str, Any]]) -> None:
    payload = {
        "model_name": BIOCLIP_MODEL,
        "created_at_unix": time.time(),
        "entries": entries,
    }
    atomic_torch_save(payload, path)


def load_bioclip(device: torch.device):
    print(f"Loading frozen BioCLIP model: {BIOCLIP_MODEL}", flush=True)
    model, _, preprocess = open_clip.create_model_and_transforms(BIOCLIP_MODEL)
    model = model.to(device).eval()
    for parameter in model.parameters():
        parameter.requires_grad = False
    return model, preprocess


def get_or_create_embeddings(
    specimens: list[SpecimenRecord],
    cache_path: Path,
    device: torch.device,
    save_every: int,
) -> list[EmbeddedView]:
    cache = load_cache(cache_path)
    embedded_views: list[EmbeddedView] = []

    needed: list[tuple[SpecimenRecord, str, Path, str]] = []
    reused = 0

    for specimen in specimens:
        key = specimen_key(specimen)
        for view, path in sorted(specimen.image_paths.items()):
            signature = image_signature(path)
            cache_key = f"{key}:{view}"
            cached = cache.get(cache_key)
            if (
                isinstance(cached, dict)
                and cached.get("signature") == signature
                and cached.get("model_name") == BIOCLIP_MODEL
                and torch.is_tensor(cached.get("embedding"))
            ):
                embedding = cached["embedding"].detach().cpu().float()
                embedded_views.append(
                    EmbeddedView(
                        specimen_key=key,
                        plate=specimen.plate,
                        well=specimen.well,
                        image_code=specimen.image_code,
                        order=specimen.order,
                        view=view,
                        image_path=str(path),
                        embedding=embedding,
                    )
                )
                reused += 1
            else:
                needed.append((specimen, view, path, signature))

    print(
        f"Embedding cache: reused={reused:,} new_or_changed={len(needed):,}",
        flush=True,
    )

    if not needed:
        return embedded_views

    bioclip, preprocess = load_bioclip(device)
    completed_since_save = 0

    for index, (specimen, view, path, signature) in enumerate(needed, start=1):
        try:
            with Image.open(path) as image:
                tensor = preprocess(image.convert("RGB")).unsqueeze(0).to(device)

            with torch.inference_mode():
                embedding = bioclip.encode_image(tensor).float()
                embedding = F.normalize(embedding, p=2, dim=-1).squeeze(0).cpu()

            key = specimen_key(specimen)
            cache_key = f"{key}:{view}"
            cache[cache_key] = {
                "signature": signature,
                "model_name": BIOCLIP_MODEL,
                "specimen_key": key,
                "plate": specimen.plate,
                "well": specimen.well,
                "image_code": specimen.image_code,
                "order": specimen.order,
                "view": view,
                "image_path": str(path),
                "embedding": embedding.to(torch.float16),
            }

            embedded_views.append(
                EmbeddedView(
                    specimen_key=key,
                    plate=specimen.plate,
                    well=specimen.well,
                    image_code=specimen.image_code,
                    order=specimen.order,
                    view=view,
                    image_path=str(path),
                    embedding=embedding,
                )
            )
            completed_since_save += 1

        except Exception as exc:
            print(f"WARNING: Failed to embed {path}: {exc}", flush=True)

        if completed_since_save >= save_every:
            save_cache(cache_path, cache)
            completed_since_save = 0
            print(f"Saved embedding cache after {index:,}/{len(needed):,} new views", flush=True)

    save_cache(cache_path, cache)
    print(f"Saved embedding cache: {cache_path}", flush=True)
    return embedded_views


# ============================================================
# SPLIT BY SPECIMEN
# ============================================================

def stratified_specimen_split(
    specimens: list[SpecimenRecord],
    validation_fraction: float,
    seed: int,
) -> tuple[set[str], set[str]]:
    by_order: dict[str, list[str]] = defaultdict(list)
    for specimen in specimens:
        by_order[specimen.order].append(specimen_key(specimen))

    rng = random.Random(seed)
    train_keys: set[str] = set()
    val_keys: set[str] = set()

    for order, keys in sorted(by_order.items()):
        keys = list(keys)
        rng.shuffle(keys)

        if len(keys) <= 1:
            train_keys.update(keys)
            continue

        val_count = max(1, int(round(len(keys) * validation_fraction)))
        val_count = min(val_count, len(keys) - 1)
        val_keys.update(keys[:val_count])
        train_keys.update(keys[val_count:])

    return train_keys, val_keys


# ============================================================
# EVALUATION
# ============================================================

def evaluate_views(
    model: HierarchicalClassifier,
    loader: DataLoader,
    device: torch.device,
) -> dict[str, int | float]:
    model.eval()
    total = 0
    correct = 0
    with torch.inference_mode():
        for embeddings, labels in loader:
            embeddings = embeddings.to(device)
            labels = labels.to(device)
            _, logits = model(embeddings)
            predictions = logits.argmax(dim=1)
            total += int(labels.numel())
            correct += int((predictions == labels).sum().item())
    return {
        "view_total": total,
        "view_correct": correct,
        "view_accuracy": correct / total if total else 0.0,
    }


def evaluate_specimens(
    model: HierarchicalClassifier,
    examples: list[EmbeddedView],
    order_to_idx: dict[str, int],
    device: torch.device,
) -> dict[str, int | float]:
    grouped: dict[str, list[EmbeddedView]] = defaultdict(list)
    for example in examples:
        grouped[example.specimen_key].append(example)

    total = 0
    correct = 0
    for key in sorted(grouped):
        group = grouped[key]
        embeddings = torch.stack([item.embedding.float() for item in group]).to(device)
        true_index = order_to_idx[group[0].order]
        with torch.inference_mode():
            _, logits = model(embeddings)
            probabilities = torch.softmax(logits.float(), dim=-1).mean(dim=0)
            prediction = int(probabilities.argmax().item())
        total += 1
        correct += int(prediction == true_index)

    return {
        "specimen_total": total,
        "specimen_correct": correct,
        "specimen_accuracy": correct / total if total else 0.0,
    }


# ============================================================
# CHECKPOINT HELPERS
# ============================================================

def load_checkpoint_model(
    checkpoint_path: Path,
    device: torch.device,
) -> tuple[HierarchicalClassifier, dict[str, Any], list[str], dict[str, int]]:
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    if not isinstance(checkpoint, dict) or "model_state_dict" not in checkpoint:
        raise TypeError(
            "taxonomy_classifier.pt must be a dictionary containing model_state_dict."
        )

    species_names = list(checkpoint["species_names"])
    order_names = list(checkpoint["all_orders"])
    order_to_idx = {str(name): index for index, name in enumerate(order_names)}

    model = HierarchicalClassifier(
        embedding_dim=int(checkpoint.get("embedding_dim", 768)),
        hidden_dim=int(checkpoint.get("hidden_dim", 512)),
        num_species=len(species_names),
        num_orders=len(order_names),
        dropout=float(checkpoint.get("dropout", 0.30)),
    )
    model.load_state_dict(checkpoint["model_state_dict"])
    model.to(device)

    # Only the direct Order head is trainable.
    for parameter in model.parameters():
        parameter.requires_grad = False
    for parameter in model.order_head.parameters():
        parameter.requires_grad = True

    return model, checkpoint, order_names, order_to_idx


def save_candidate(
    path: Path,
    model: HierarchicalClassifier,
    base_checkpoint: dict[str, Any],
    metadata: dict[str, Any],
) -> None:
    output = dict(base_checkpoint)
    output["model_state_dict"] = {
        key: value.detach().cpu()
        for key, value in model.state_dict().items()
    }
    output["taxonomy_retraining"] = metadata
    output["created_at_unix"] = time.time()
    atomic_torch_save(output, path)


# ============================================================
# MAIN
# ============================================================

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--plate-image-dir", type=Path, default=DEFAULT_PLATE_IMAGE_DIR)
    parser.add_argument("--base-model", type=Path, default=DEFAULT_BASE_MODEL)
    parser.add_argument("--output", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--validation-fraction", type=float, default=0.20)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--minimum-views", type=int, default=3)
    parser.add_argument("--cache-save-every", type=int, default=32)
    parser.add_argument("--promote", action="store_true", help="Back up and replace the active taxonomy classifier after training.")
    args = parser.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = select_device(args.device)

    print(f"Device: {device}", flush=True)
    if device.type == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}", flush=True)

    if not args.base_model.exists():
        raise SystemExit(f"Base taxonomy model not found: {args.base_model}")
    if not args.manifest.exists():
        raise SystemExit(f"Taxonomy training manifest not found: {args.manifest}")

    model, base_checkpoint, order_names, order_to_idx = load_checkpoint_model(
        args.base_model, device
    )
    valid_orders = set(order_to_idx)

    specimens, discovery_stats = load_reviewed_specimens(
        manifest_path=args.manifest,
        valid_orders=valid_orders,
        minimum_views=args.minimum_views,
    )

    print(json.dumps({"discovery": discovery_stats}, sort_keys=True), flush=True)

    if len(specimens) < 20:
        raise SystemExit(
            f"Need at least 20 reviewed taxonomy specimens; found {len(specimens)}."
        )

    specimen_class_counts = Counter(specimen.order for specimen in specimens)
    if len(specimen_class_counts) < 2:
        raise SystemExit(
            f"Need at least 2 represented Order classes; found {dict(specimen_class_counts)}"
        )

    print("Reviewed specimens by Order:", flush=True)
    for order, count in sorted(specimen_class_counts.items()):
        print(f"  {order:<24} {count:>6,}", flush=True)

    embedded_views = get_or_create_embeddings(
        specimens=specimens,
        cache_path=args.cache,
        device=device,
        save_every=max(1, args.cache_save_every),
    )

    if not embedded_views:
        raise SystemExit("No usable BioCLIP embeddings were produced.")

    train_keys, val_keys = stratified_specimen_split(
        specimens=specimens,
        validation_fraction=args.validation_fraction,
        seed=args.seed,
    )

    train_examples = [item for item in embedded_views if item.specimen_key in train_keys]
    val_examples = [item for item in embedded_views if item.specimen_key in val_keys]

    if not train_examples or not val_examples:
        raise SystemExit(
            f"Training/validation split is empty: train_views={len(train_examples)} val_views={len(val_examples)}"
        )

    train_dataset = ViewEmbeddingDataset(train_examples, order_to_idx)
    val_dataset = ViewEmbeddingDataset(val_examples, order_to_idx)
    all_dataset = ViewEmbeddingDataset(embedded_views, order_to_idx)

    train_loader = DataLoader(train_dataset, batch_size=args.batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=args.batch_size, shuffle=False)
    all_loader = DataLoader(all_dataset, batch_size=args.batch_size, shuffle=False)

    train_specimen_counts = Counter(
        item.order for item in specimens if specimen_key(item) in train_keys
    )

    class_weights = torch.zeros(len(order_names), dtype=torch.float32, device=device)
    total_train_specimens = max(1, sum(train_specimen_counts.values()))
    represented_train_classes = max(1, len(train_specimen_counts))
    for order, count in train_specimen_counts.items():
        class_weights[order_to_idx[order]] = total_train_specimens / (
            represented_train_classes * max(1, count)
        )

    criterion = nn.CrossEntropyLoss(weight=class_weights)
    optimizer = torch.optim.AdamW(
        model.order_head.parameters(),
        lr=args.learning_rate,
    )

    print(
        f"Training specimens={len(train_keys):,} validation specimens={len(val_keys):,} "
        f"training views={len(train_examples):,} validation views={len(val_examples):,}",
        flush=True,
    )

    rows: list[dict[str, Any]] = []
    best_val_accuracy = -1.0
    best_state: dict[str, torch.Tensor] | None = None
    start = time.time()

    for epoch in range(1, args.epochs + 1):
        model.train()
        running_loss = 0.0
        batch_count = 0

        for embeddings, labels in train_loader:
            embeddings = embeddings.to(device)
            labels = labels.to(device)

            optimizer.zero_grad(set_to_none=True)
            _, logits = model(embeddings)
            loss = criterion(logits, labels)
            loss.backward()
            optimizer.step()

            running_loss += float(loss.item())
            batch_count += 1

        view_metrics = evaluate_views(model, val_loader, device)
        specimen_metrics = evaluate_specimens(model, val_examples, order_to_idx, device)

        row = {
            "epoch": epoch,
            "epoch_total": args.epochs,
            "training_loss": running_loss / max(1, batch_count),
            **view_metrics,
            **specimen_metrics,
        }
        rows.append(row)
        print(json.dumps(row, sort_keys=True), flush=True)

        if float(specimen_metrics["specimen_accuracy"]) > best_val_accuracy:
            best_val_accuracy = float(specimen_metrics["specimen_accuracy"])
            best_state = {
                key: value.detach().cpu().clone()
                for key, value in model.state_dict().items()
            }

    if best_state is None:
        raise SystemExit("Training produced no checkpoint state.")

    model.load_state_dict(best_state)
    model.to(device).eval()

    final_view_metrics = evaluate_views(model, all_loader, device)
    final_specimen_metrics = evaluate_specimens(
        model, embedded_views, order_to_idx, device
    )

    metadata = {
        "base_model": str(args.base_model),
        "manifest": str(args.manifest),
        "plate_image_dir": str(args.plate_image_dir),
        "embedding_cache": str(args.cache),
        "bio_clip_model": BIOCLIP_MODEL,
        "training_mode": "direct_order_head_only",
        "frozen_components": ["bioclip", "shared", "species_head"],
        "trainable_components": ["order_head"],
        "specimen_count": len(specimens),
        "embedded_view_count": len(embedded_views),
        "specimen_class_counts": dict(sorted(specimen_class_counts.items())),
        "training_specimen_count": len(train_keys),
        "validation_specimen_count": len(val_keys),
        "validation_fraction": args.validation_fraction,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "learning_rate": args.learning_rate,
        "seed": args.seed,
        "best_validation_specimen_accuracy": best_val_accuracy,
        "final_view_metrics": final_view_metrics,
        "final_specimen_metrics": final_specimen_metrics,
        "created_at_unix": time.time(),
    }

    save_candidate(args.output, model, base_checkpoint, metadata)
    write_report(args.report, rows)

    # Sanity-load the candidate using the same architecture/metadata expectations.
    sanity_checkpoint = torch.load(args.output, map_location="cpu", weights_only=False)
    sanity_model = HierarchicalClassifier(
        embedding_dim=int(sanity_checkpoint.get("embedding_dim", 768)),
        hidden_dim=int(sanity_checkpoint.get("hidden_dim", 512)),
        num_species=len(sanity_checkpoint["species_names"]),
        num_orders=len(sanity_checkpoint["all_orders"]),
        dropout=float(sanity_checkpoint.get("dropout", 0.30)),
    )
    sanity_model.load_state_dict(sanity_checkpoint["model_state_dict"])

    promoted = False
    backup_path = ""
    if args.promote:
        backup = args.base_model.with_suffix(
            args.base_model.suffix + f".backup_{int(time.time())}"
        )
        if args.base_model.exists():
            shutil.copy2(args.base_model, backup)
            backup_path = str(backup)
        shutil.copy2(args.output, args.base_model)
        promoted = True

    summary = {
        "output": str(args.output),
        "report": str(args.report),
        "cache": str(args.cache),
        "specimens": len(specimens),
        "embedded_views": len(embedded_views),
        "class_counts": dict(sorted(specimen_class_counts.items())),
        "best_validation_specimen_accuracy": best_val_accuracy,
        "final_view_metrics": final_view_metrics,
        "final_specimen_metrics": final_specimen_metrics,
        "elapsed_seconds": round(time.time() - start, 1),
        "promoted": promoted,
        "backup": backup_path,
    }
    print(json.dumps(summary, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
