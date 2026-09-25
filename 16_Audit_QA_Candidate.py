#!/usr/bin/env python3
"""Re-evaluate a trained nozzle candidate using labels added after training."""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
MODELS_DIR = SCRIPT_DIR / "Data/qa_feedback/models"


def load_trainer():
    path = SCRIPT_DIR / "15_Retrain_QA_Classifier.py"
    spec = importlib.util.spec_from_file_location("qa_trainer_for_audit", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load QA trainer definitions.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def fixed_pair_metrics(module, predictions, threshold: float) -> dict:
    grouped = {}
    for row in predictions:
        grouped.setdefault(module.nozzle_pair_key(row), []).append(row)
    pairs = []
    for key, rows in grouped.items():
        labels = {row["truth"] for row in rows}
        if len(labels) != 1:
            continue
        pairs.append({
            "key": key,
            "truth": next(iter(labels)),
            "score": min(row["probabilities"]["empty_nozzle"] for row in rows),
        })
    present = [row for row in pairs if row["truth"] == "specimen_present"]
    empty = [row for row in pairs if row["truth"] == "empty_nozzle"]
    return {
        "threshold": threshold,
        "specimen_pairs": len(present),
        "false_empty_pair_count": sum(row["score"] >= threshold for row in present),
        "empty_pairs": len(empty),
        "true_empty_pair_clear_count": sum(row["score"] >= threshold for row in empty),
    }


def main() -> int:
    module = load_trainer()
    candidate_path = MODELS_DIR / "nozzle_qa_classifier_candidate.pt"
    active_path = MODELS_DIR / "nozzle_qa_classifier.pt"
    report_path = MODELS_DIR / "nozzle_qa_classifier_report.json"
    if not candidate_path.exists() or not report_path.exists():
        raise SystemExit("No nozzle QA candidate and report are available to audit.")

    candidate_checkpoint = module.torch.load(
        candidate_path, map_location="cpu", weights_only=False
    )
    backlog = module.unreviewed_post_pick_count()
    if backlog:
        raise SystemExit(
            f"Review the remaining {backlog} post-pick nozzle frames before auditing."
        )

    trained_at = datetime.fromisoformat(str(candidate_checkpoint["trained_at"]))
    examples = module.load_examples("nozzle")
    audit_examples = []
    for example in examples:
        try:
            reviewed_at = datetime.fromisoformat(str(example.record.get("reviewed_at") or ""))
        except (TypeError, ValueError):
            continue
        if reviewed_at > trained_at:
            audit_examples.append(example)

    if not audit_examples:
        raise SystemExit("No new reviewed nozzle labels were found after candidate training.")

    classes = ["empty_nozzle", "specimen_present"]
    candidate_model = module.model_from_checkpoint(candidate_checkpoint)
    candidate_predictions = module.prediction_rows(
        candidate_model, audit_examples, classes, module.torch.device("cpu")
    )
    candidate_metrics = fixed_pair_metrics(
        module,
        candidate_predictions,
        float(candidate_checkpoint["empty_confidence_threshold"]),
    )

    active_metrics = None
    if active_path.exists():
        active_checkpoint = module.torch.load(active_path, map_location="cpu", weights_only=False)
        active_model = module.model_from_checkpoint(active_checkpoint)
        active_predictions = module.prediction_rows(
            active_model, audit_examples, classes, module.torch.device("cpu")
        )
        active_metrics = fixed_pair_metrics(
            module,
            active_predictions,
            float(active_checkpoint["empty_confidence_threshold"]),
        )

    report = json.loads(report_path.read_text(encoding="utf-8"))
    base_candidate = report.get("operational_pair_decision") or {}
    base_active = (report.get("active_model_evaluation") or {}).get("pair_decision") or {}
    base_improves = (
        base_candidate.get("false_empty_pair_count", 1) <= base_active.get("false_empty_pair_count", 0)
        and base_candidate.get("true_empty_pair_clear_rate", 0.0)
            > base_active.get("true_empty_pair_clear_rate", 0.0)
    )
    recommended = candidate_metrics["false_empty_pair_count"] == 0 and base_improves
    recommendation = (
        "Promote: the candidate improves held-out pair clearance and passed the post-training backlog audit."
        if recommended else
        "Do not promote: the candidate did not pass the post-training safety and improvement audit."
    )
    report["post_training_audit"] = {
        "audited_at": module.utc_now(),
        "new_reviewed_examples": len(audit_examples),
        "candidate": candidate_metrics,
        "active": active_metrics,
    }
    report["unreviewed_post_pick_frames"] = 0
    report["promotion_recommended"] = recommended
    report["recommendation"] = recommendation
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(recommendation)
    print(json.dumps(report["post_training_audit"], indent=2, sort_keys=True))
    print(f"Updated report: {report_path}")
    return 0 if recommended else 2


if __name__ == "__main__":
    raise SystemExit(main())
