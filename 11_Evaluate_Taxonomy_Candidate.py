#!/usr/bin/env python3
"""Compare active and candidate BugPicker taxonomy checkpoints on reviewed labels."""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import torch


SCRIPT_DIR = Path(__file__).resolve().parent
RETRAINER_PATH = SCRIPT_DIR / "10_Retrain_Taxonomy_Classifier.py"
spec = importlib.util.spec_from_file_location("taxonomy_retrainer", RETRAINER_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Could not load retrainer module: {RETRAINER_PATH}")
taxonomy_retrainer = importlib.util.module_from_spec(spec)
sys.modules["taxonomy_retrainer"] = taxonomy_retrainer
spec.loader.exec_module(taxonomy_retrainer)

DEFAULT_BASE_MODEL = taxonomy_retrainer.DEFAULT_BASE_MODEL
DEFAULT_CANDIDATE = taxonomy_retrainer.DEFAULT_CANDIDATE
DEFAULT_CACHE = taxonomy_retrainer.DEFAULT_CACHE
DEFAULT_MANIFEST = taxonomy_retrainer.DEFAULT_MANIFEST


def predict_checkpoint(
    checkpoint_path: Path,
    examples: list[Any],
    device: torch.device,
) -> dict[str, dict[str, Any]]:
    model, _, order_names, _ = taxonomy_retrainer.load_checkpoint_model(checkpoint_path, device)
    model.eval()
    grouped: dict[str, list[Any]] = {}
    for example in examples:
        grouped.setdefault(example.specimen_key, []).append(example)

    predictions: dict[str, dict[str, Any]] = {}
    for key, group in sorted(grouped.items()):
        embeddings = torch.stack([item.embedding.float() for item in group]).to(device)
        true_order = group[0].order
        with torch.inference_mode():
            _, logits = model(embeddings)
            probabilities = torch.softmax(logits.float(), dim=-1).mean(dim=0)
            confidence, index = torch.max(probabilities, dim=0)
        predicted_order = order_names[int(index.item())]
        predictions[key] = {
            "plate": group[0].plate,
            "well": group[0].well,
            "image_code": group[0].image_code,
            "true_order": true_order,
            "predicted_order": predicted_order,
            "confidence": float(confidence.item()),
            "correct": predicted_order == true_order,
            "views": "+".join(sorted(item.view for item in group)),
        }
    return predictions


def summarize(predictions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    total = len(predictions)
    correct = sum(1 for item in predictions.values() if item["correct"])
    by_order: dict[str, Counter[str]] = {}
    for item in predictions.values():
        order = str(item["true_order"])
        counter = by_order.setdefault(order, Counter())
        counter["total"] += 1
        if item["correct"]:
            counter["correct"] += 1
    return {
        "total": total,
        "correct": correct,
        "accuracy": correct / total if total else 0.0,
        "by_order": {
            order: {
                "total": counts["total"],
                "correct": counts["correct"],
                "accuracy": counts["correct"] / counts["total"] if counts["total"] else 0.0,
            }
            for order, counts in sorted(by_order.items())
        },
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--active-model", type=Path, default=DEFAULT_BASE_MODEL)
    parser.add_argument("--candidate-model", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--output-dir", type=Path, default=SCRIPT_DIR / "Data/taxonomy_feedback")
    parser.add_argument("--minimum-views", type=int, default=3)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    device = taxonomy_retrainer.select_device(args.device)
    _, _, _, order_to_idx = taxonomy_retrainer.load_checkpoint_model(args.active_model, device)
    specimens, discovery = taxonomy_retrainer.load_reviewed_specimens(
        manifest_path=args.manifest,
        valid_orders=set(order_to_idx),
        minimum_views=args.minimum_views,
    )
    examples = taxonomy_retrainer.get_or_create_embeddings(
        specimens=specimens,
        cache_path=args.cache,
        device=device,
        save_every=64,
    )

    active = predict_checkpoint(args.active_model, examples, device)
    candidate = predict_checkpoint(args.candidate_model, examples, device)
    rows: list[dict[str, Any]] = []
    for key in sorted(active):
        active_item = active[key]
        candidate_item = candidate.get(key, {})
        rows.append({
            "plate": active_item["plate"],
            "well": active_item["well"],
            "image_code": active_item["image_code"],
            "true_order": active_item["true_order"],
            "active_prediction": active_item["predicted_order"],
            "active_confidence": f"{float(active_item['confidence']):.6f}",
            "active_correct": active_item["correct"],
            "candidate_prediction": candidate_item.get("predicted_order", ""),
            "candidate_confidence": f"{float(candidate_item.get('confidence', 0.0)):.6f}",
            "candidate_correct": candidate_item.get("correct", False),
            "views": active_item["views"],
        })

    args.output_dir.mkdir(parents=True, exist_ok=True)
    csv_path = args.output_dir / "taxonomy_candidate_comparison.csv"
    json_path = args.output_dir / "taxonomy_candidate_comparison.json"
    write_csv(csv_path, rows)
    active_summary = summarize(active)
    candidate_summary = summarize(candidate)
    promotion_recommended = candidate_summary["accuracy"] > active_summary["accuracy"]
    recommendation = (
        "Promote: the candidate improves reviewed-specimen accuracy over the active taxonomy model."
        if promotion_recommended else
        "Do not promote: the candidate does not improve reviewed-specimen accuracy over the active taxonomy model."
    )
    summary = {
        "manifest": str(args.manifest),
        "cache": str(args.cache),
        "active_model": str(args.active_model),
        "candidate_model": str(args.candidate_model),
        "discovery": discovery,
        "active": active_summary,
        "candidate": candidate_summary,
        "promotion_recommended": promotion_recommended,
        "recommendation": recommendation,
        "csv": str(csv_path),
    }
    json_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(summary, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
