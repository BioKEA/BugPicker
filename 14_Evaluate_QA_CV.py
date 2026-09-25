#!/usr/bin/env python3
"""Evaluate current BugPicker CV QA rules against reviewed QA labels."""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
QA_FEEDBACK_DIR = SCRIPT_DIR / "Data/qa_feedback"
DEFAULT_REPORT_DIR = QA_FEEDBACK_DIR / "reports"
QA_SCRIPT = SCRIPT_DIR / "03_QA_Inspect_Image.py"
LABEL_FILES = {
    "well": QA_FEEDBACK_DIR / "well_qa_labels.jsonl",
    "nozzle": QA_FEEDBACK_DIR / "nozzle_qa_labels.jsonl",
}


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


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


def latest_labels(path: Path) -> list[dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for record in iter_jsonl(path) or []:
        image_path = str(record.get("image_path") or "").strip()
        if image_path:
            latest[image_path] = record
    return [latest[key] for key in sorted(latest)]


def qa_result(mode: str, image_path: Path, out_path: Path) -> dict[str, Any]:
    completed = subprocess.run(
        [
            sys.executable,
            str(QA_SCRIPT),
            "--mode",
            "well" if mode == "well" else "nozzle",
            "--out",
            str(out_path),
            str(image_path),
        ],
        cwd=str(SCRIPT_DIR),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return json.loads(out_path.read_text(encoding="utf-8"))


def predicted_label(mode: str, result: dict[str, Any]) -> str:
    if mode == "well":
        if bool(result.get("well_empty")):
            return "empty_well"
        if bool(result.get("relative_only_well_occupancy")):
            return "uncertain"
        return "single_specimen_in_well"

    if bool(result.get("possible_multiple")):
        return "multiple_specimens_on_nozzle"
    if bool(result.get("bug_present")):
        return "single_specimen_on_nozzle"
    return "empty_nozzle"


def binary_label(mode: str, label: str) -> str:
    if mode == "well":
        if label == "empty_well":
            return "empty"
        if label in {"single_specimen_in_well", "multiple_specimens_in_well"}:
            return "occupied"
        return "uncertain"
    if label == "empty_nozzle":
        return "empty"
    if label in {"single_specimen_on_nozzle", "multiple_specimens_on_nozzle", "bad_pickup_outside_nozzle"}:
        return "occupied"
    return "uncertain"


def evaluate(mode: str, labels: list[dict[str, Any]], report_dir: Path) -> dict[str, Any]:
    report_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    class_counts: Counter[tuple[str, str]] = Counter()
    binary_counts: Counter[tuple[str, str]] = Counter()
    errors: list[dict[str, str]] = []
    temp_dir = report_dir / "tmp"
    temp_dir.mkdir(exist_ok=True)

    for index, record in enumerate(labels):
        image_path = Path(str(record.get("image_path") or ""))
        user_label = str(record.get("user_label") or "").strip()
        if not image_path.exists() or not user_label:
            continue
        try:
            result = qa_result(mode, image_path, temp_dir / f"{mode}_{index:05d}.json")
            cv_label = predicted_label(mode, result)
        except Exception as error:
            errors.append({
                "image_path": str(image_path),
                "error": str(error),
            })
            continue
        class_counts[(user_label, cv_label)] += 1
        true_binary = binary_label(mode, user_label)
        cv_binary = binary_label(mode, cv_label)
        binary_counts[(true_binary, cv_binary)] += 1
        rows.append({
            **record,
            "cv_label_now": cv_label,
            "user_binary_label": true_binary,
            "cv_binary_label_now": cv_binary,
            "cv_bug_present": result.get("bug_present", ""),
            "cv_well_empty": result.get("well_empty", ""),
            "cv_possible_multiple": result.get("possible_multiple", ""),
            "cv_relative_only_well_occupancy": result.get("relative_only_well_occupancy", ""),
        })

    total = len(rows)
    class_correct = sum(count for (truth, pred), count in class_counts.items() if truth == pred)
    binary_scored = sum(
        count for (truth, _pred), count in binary_counts.items()
        if truth != "uncertain"
    )
    binary_correct = sum(
        count for (truth, pred), count in binary_counts.items()
        if truth != "uncertain" and truth == pred
    )
    false_positive = binary_counts[("empty", "occupied")]
    false_negative = binary_counts[("occupied", "empty")]
    uncertain_pred = sum(
        count for (_truth, pred), count in binary_counts.items()
        if pred == "uncertain"
    )

    stamp = utc_stamp()
    detail_csv = report_dir / f"{mode}_qa_cv_eval_{stamp}.csv"
    latest_csv = report_dir / f"{mode}_qa_cv_eval_latest.csv"
    summary_json = report_dir / f"{mode}_qa_cv_eval_{stamp}.json"
    latest_json = report_dir / f"{mode}_qa_cv_eval_latest.json"
    fieldnames = sorted({key for row in rows for key in row.keys()})
    for path in (detail_csv, latest_csv):
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

    summary = {
        "mode": mode,
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "labels_total": len(labels),
        "evaluated_total": total,
        "errors": errors,
        "class_accuracy": (class_correct / total) if total else 0.0,
        "binary_accuracy": (binary_correct / binary_scored) if binary_scored else 0.0,
        "false_positive_empty_predicted_occupied": false_positive,
        "false_negative_occupied_predicted_empty": false_negative,
        "uncertain_predictions": uncertain_pred,
        "class_confusion": {
            f"{truth} -> {pred}": count
            for (truth, pred), count in sorted(class_counts.items())
        },
        "binary_confusion": {
            f"{truth} -> {pred}": count
            for (truth, pred), count in sorted(binary_counts.items())
        },
        "detail_csv": str(detail_csv),
        "latest_csv": str(latest_csv),
        "summary_json": str(summary_json),
        "latest_json": str(latest_json),
    }
    for path in (summary_json, latest_json):
        path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("well", "nozzle", "both"), default="both")
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    args = parser.parse_args()

    modes = ("well", "nozzle") if args.mode == "both" else (args.mode,)
    for mode in modes:
        labels = latest_labels(LABEL_FILES[mode])
        summary = evaluate(mode, labels, args.report_dir)
        print(
            f"{mode}: evaluated={summary['evaluated_total']} "
            f"class_accuracy={summary['class_accuracy']:.3f} "
            f"binary_accuracy={summary['binary_accuracy']:.3f} "
            f"FP={summary['false_positive_empty_predicted_occupied']} "
            f"FN={summary['false_negative_occupied_predicted_empty']} "
            f"report={summary['latest_json']}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
