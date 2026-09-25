#!/usr/bin/env python3
"""Update BugPicker model training datasets from reviewed feedback."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_OPENPNP_ROOT = SCRIPT_DIR.parent.parent
DEBRIS_FEEDBACK = SCRIPT_DIR / "Data/classifier_feedback/insect_debris_feedback.jsonl"
DEBRIS_LEDGER = SCRIPT_DIR / "Data/classifier_feedback/debris_training_ledger.jsonl"
TAXONOMY_FEEDBACK_DIR = SCRIPT_DIR / "Data/taxonomy_feedback"
TAXONOMY_LEDGER = TAXONOMY_FEEDBACK_DIR / "taxonomy_training_ledger.jsonl"
TAXONOMY_MANIFEST = TAXONOMY_FEEDBACK_DIR / "taxonomy_training_manifest.jsonl"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def iter_jsonl(path: Path):
    if not path.exists():
        return
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def append_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    if not records:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, sort_keys=True) + "\n")


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, sort_keys=True) + "\n")


def record_key(parts: list[Any]) -> str:
    payload = "\x1f".join(str(part) for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_ledger_keys(path: Path) -> set[str]:
    keys: set[str] = set()
    for record in iter_jsonl(path) or []:
        key = str(record.get("training_key") or "").strip()
        if key:
            keys.add(key)
    return keys


def update_debris_ledger() -> dict[str, Any]:
    seen = load_ledger_keys(DEBRIS_LEDGER)
    new_records: list[dict[str, Any]] = []
    usable_total = 0
    for record in iter_jsonl(DEBRIS_FEEDBACK) or []:
        decision = str(record.get("decision") or "").strip().lower()
        if decision not in {"specimen", "debris"}:
            continue
        image_path = str(record.get("copied_crop_file") or record.get("crop_file") or "").strip()
        if not image_path:
            continue
        usable_total += 1
        key = record_key([
            "debris",
            image_path,
            decision,
            record.get("reviewed_at", ""),
        ])
        if key in seen:
            continue
        seen.add(key)
        new_records.append({
            "training_key": key,
            "kind": "debris",
            "label": decision,
            "debris_subtype": (
                str(record.get("debris_subtype") or "").strip()
                if decision == "debris"
                else ""
            ),
            "image_path": image_path,
            "scan_id": record.get("scan_id", ""),
            "object_index": record.get("object_index", ""),
            "reviewed_at": record.get("reviewed_at", ""),
            "ingested_at": utc_now(),
        })
    append_jsonl(DEBRIS_LEDGER, new_records)
    return {
        "usable_total": usable_total,
        "new_examples": len(new_records),
        "ledger": str(DEBRIS_LEDGER),
    }


def taxonomy_decision_files(openpnp_root: Path) -> list[Path]:
    taxonomy_root = openpnp_root / "Plate_taxonomy"
    if not taxonomy_root.exists():
        return []
    return sorted(taxonomy_root.glob("P-*/taxonomy_review_decisions.jsonl"))


def taxonomy_image_paths(openpnp_root: Path, plate: str, image_code: str) -> dict[str, str]:
    image_dir = openpnp_root / "Plate_insect_images" / f"P-{plate}"
    paths: dict[str, str] = {}
    for kind in ("scan", "hires", "bottom", "well"):
        path = image_dir / f"{image_code}_{kind}.png"
        if path.exists():
            paths[kind] = str(path)
    return paths


def update_taxonomy_manifest(openpnp_root: Path) -> dict[str, Any]:
    seen = load_ledger_keys(TAXONOMY_LEDGER)
    manifest_by_specimen: dict[str, dict[str, Any]] = {}
    ledger_records: list[dict[str, Any]] = []
    usable_seen: set[str] = set()
    skipped_consistency = 0
    for file_path in taxonomy_decision_files(openpnp_root):
        for record in iter_jsonl(file_path) or []:
            reviewed_order = str(record.get("reviewed_order") or "").strip()
            consistency = str(record.get("image_consistency") or "").strip()
            plate = str(record.get("plate") or "").strip().upper()
            image_code = str(record.get("image_code") or "").strip()
            if not reviewed_order or not plate or not image_code:
                continue
            if consistency != "Same specimen across images":
                skipped_consistency += 1
                continue
            image_paths = taxonomy_image_paths(openpnp_root, plate, image_code)
            if "well" not in image_paths:
                continue
            specimen_id = f"{plate}:{record.get('well', '')}:{image_code}"
            usable_seen.add(specimen_id)
            key = record_key([
                "taxonomy",
                plate,
                record.get("well", ""),
                image_code,
                reviewed_order,
            ])
            manifest = {
                "training_key": key,
                "kind": "taxonomy",
                "plate": plate,
                "well": record.get("well", ""),
                "image_code": image_code,
                "order": reviewed_order,
                "ai_order": record.get("ai_order", ""),
                "image_consistency": consistency,
                "image_paths": image_paths,
                "reviewed_at": record.get("reviewed_at", ""),
                "ingested_at": utc_now(),
                "source_decision_file": str(file_path),
            }
            previous = manifest_by_specimen.get(specimen_id)
            if previous is None or str(manifest["reviewed_at"]) >= str(previous.get("reviewed_at", "")):
                manifest_by_specimen[specimen_id] = manifest

    manifest_records = [
        manifest_by_specimen[key]
        for key in sorted(manifest_by_specimen)
    ]
    for manifest in manifest_records:
        key = str(manifest["training_key"])
        if key in seen:
            continue
        seen.add(key)
        ledger_records.append({
            "training_key": key,
            "kind": "taxonomy",
            "plate": manifest.get("plate", ""),
            "well": manifest.get("well", ""),
            "image_code": manifest.get("image_code", ""),
            "order": manifest.get("order", ""),
            "reviewed_at": manifest.get("reviewed_at", ""),
            "ingested_at": utc_now(),
        })
    write_jsonl(TAXONOMY_MANIFEST, manifest_records)
    append_jsonl(TAXONOMY_LEDGER, ledger_records)
    return {
        "usable_total": len(usable_seen),
        "manifest_examples": len(manifest_records),
        "new_examples": len(ledger_records),
        "skipped_consistency": skipped_consistency,
        "manifest": str(TAXONOMY_MANIFEST),
        "ledger": str(TAXONOMY_LEDGER),
    }


def run_command(command: list[str], cwd: Path) -> dict[str, Any]:
    print("Running: " + " ".join(command), flush=True)
    started = time.monotonic()
    last_summary: dict[str, Any] | None = None
    try:
        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None
        for line in process.stdout:
            print(line, end="", flush=True)
            try:
                candidate = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict):
                last_summary = candidate
        returncode = process.wait()
        error = ""
    except OSError as exc:
        returncode = 127
        error = str(exc)
        print(f"Unable to run command: {exc}", file=sys.stderr, flush=True)
    return {
        "command": command,
        "returncode": returncode,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "summary": last_summary or {},
        "error": error,
    }


def format_duration(seconds: float) -> str:
    total_seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m {seconds}s"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


def command_name(command: dict[str, Any]) -> str:
    for part in command.get("command", []):
        if str(part).endswith(".py"):
            return Path(str(part)).name
    return " ".join(str(part) for part in command.get("command", []))


def promotion_candidates(commands: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for command in commands:
        if command.get("returncode") != 0:
            continue
        name = command_name(command)
        metrics = command.get("summary") or {}
        if name == "06_Retrain_Insect_Debris_Classifier.py":
            candidates.append({
                "name": "Debris classifier",
                "candidate_model": metrics.get("candidate_model", metrics.get("output", "")),
                "active_model": metrics.get("active_model", ""),
                "promotion_recommended": bool(metrics.get("promotion_recommended")),
                "recommendation": metrics.get("recommendation", "No recommendation available."),
            })
        elif name == "11_Evaluate_Taxonomy_Candidate.py":
            candidates.append({
                "name": "Taxonomy Order head",
                "candidate_model": metrics.get("candidate_model", ""),
                "active_model": metrics.get("active_model", ""),
                "promotion_recommended": bool(metrics.get("promotion_recommended")),
                "recommendation": metrics.get("recommendation", "No recommendation available."),
            })
        elif name == "12_Finetune_Taxonomy_BioCLIP_Backbone.py":
            candidates.append({
                "name": "Taxonomy BioCLIP backbone",
                "candidate_model": metrics.get("candidate_model", metrics.get("output", "")),
                "active_model": metrics.get("active_model", ""),
                "promotion_recommended": bool(metrics.get("promotion_recommended")),
                "recommendation": metrics.get("recommendation", "No recommendation available."),
            })
    return [item for item in candidates if item["candidate_model"] and item["active_model"]]


def format_text_report(summary: dict[str, Any]) -> str:
    debris = summary["debris"]
    taxonomy = summary["taxonomy"]
    lines = [
        "BugPicker Model Update Report",
        "=" * 31,
        f"Status: {summary['status']}",
        f"Started: {summary['started_at']}",
        f"Completed: {summary['completed_at']}",
        f"Duration: {format_duration(summary['elapsed_seconds'])}",
        "",
        "Dataset update",
        f"- Debris: {debris['usable_total']} usable; {debris['new_examples']} newly ingested",
        (
            f"- Taxonomy: {taxonomy['usable_total']} usable; "
            f"{taxonomy['new_examples']} newly ingested; "
            f"{taxonomy['skipped_consistency']} skipped for image inconsistency"
        ),
    ]
    if not summary["commands"]:
        lines.extend(["", "Training", "- No training jobs selected"])
    else:
        lines.extend(["", "Training jobs"])
        for command in summary["commands"]:
            status = "completed" if command["returncode"] == 0 else f"failed (exit {command['returncode']})"
            lines.append(
                f"- {command_name(command)}: {status}; "
                f"{format_duration(command['elapsed_seconds'])}"
            )
            metrics = command.get("summary") or {}
            example_count = metrics.get("example_count", metrics.get("specimens"))
            if example_count is not None:
                lines.append(f"  Training examples/specimens: {example_count}")
            class_counts = metrics.get("class_counts") or {}
            if class_counts:
                counts = ", ".join(
                    f"{label}={count}" for label, count in sorted(class_counts.items())
                )
                lines.append(f"  Class counts: {counts}")
            final_metrics = metrics.get("final_metrics") or metrics.get("final_specimen_metrics") or {}
            accuracy = final_metrics.get("accuracy", final_metrics.get("specimen_accuracy"))
            if accuracy is not None:
                correct = final_metrics.get("correct", final_metrics.get("specimen_correct"))
                total = final_metrics.get("total", final_metrics.get("specimen_total"))
                result_count = f" ({correct}/{total})" if correct is not None and total is not None else ""
                lines.append(f"  Accuracy: {float(accuracy):.1%}{result_count}")
            if "false_debris" in final_metrics:
                lines.append(
                    f"  Errors: false debris={final_metrics['false_debris']}, "
                    f"false specimen={final_metrics.get('false_insect', 0)}"
                )
            validation_accuracy = metrics.get("best_validation_specimen_accuracy")
            if validation_accuracy is not None:
                lines.append(f"  Best validation accuracy: {float(validation_accuracy):.1%}")
            active = metrics.get("active") or {}
            candidate = metrics.get("candidate") or {}
            if active and candidate:
                lines.append(
                    f"  Active vs candidate: {float(active.get('accuracy', 0)):.1%} "
                    f"vs {float(candidate.get('accuracy', 0)):.1%} "
                    f"({float(candidate.get('accuracy', 0)) - float(active.get('accuracy', 0)):+.1%})"
                )
            if "promoted" in metrics:
                lines.append(f"  Promoted for use: {'yes' if metrics['promoted'] else 'no'}")
            if metrics.get("recommendation"):
                lines.append(f"  Recommendation: {metrics['recommendation']}")
            if command.get("error"):
                lines.append(f"  Error: {command['error']}")
    lines.extend(["", f"JSON report: {summary['report_json']}", f"Text report: {summary['report_text']}"])
    return "\n".join(lines) + "\n"


def main() -> int:
    started_at = utc_now()
    started_monotonic = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--openpnp-root", type=Path, default=DEFAULT_OPENPNP_ROOT)
    parser.add_argument("--run-debris", action="store_true")
    parser.add_argument("--run-taxonomy", action="store_true")
    parser.add_argument("--run-taxonomy-backbone", action="store_true")
    parser.add_argument("--promote-debris", action="store_true")
    parser.add_argument("--promote-taxonomy", action="store_true")
    parser.add_argument("--promote-taxonomy-backbone", action="store_true")
    parser.add_argument("--debris-epochs", type=int, default=8)
    parser.add_argument("--taxonomy-epochs", type=int, default=8)
    parser.add_argument("--taxonomy-backbone-epochs", type=int, default=2)
    parser.add_argument("--taxonomy-command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    openpnp_root = args.openpnp_root.resolve()
    report_dir = SCRIPT_DIR / "Data/model_update_reports"
    report_dir.mkdir(parents=True, exist_ok=True)

    debris = update_debris_ledger()
    taxonomy = update_taxonomy_manifest(openpnp_root)
    commands: list[dict[str, Any]] = []

    if args.run_debris:
        command = [
            sys.executable,
            str(SCRIPT_DIR / "06_Retrain_Insect_Debris_Classifier.py"),
            "--epochs",
            str(args.debris_epochs),
        ]
        if args.promote_debris:
            command.append("--promote")
        commands.append(run_command(command, SCRIPT_DIR))

    if args.run_taxonomy:
        if args.taxonomy_command:
            commands.append(run_command(args.taxonomy_command, SCRIPT_DIR))
        else:
            command = [
                sys.executable,
                str(SCRIPT_DIR / "10_Retrain_Taxonomy_Classifier.py"),
                "--epochs",
                str(args.taxonomy_epochs),
            ]
            if args.promote_taxonomy:
                command.append("--promote")
            commands.append(run_command(command, SCRIPT_DIR))
            if not args.promote_taxonomy:
                commands.append(run_command([
                    sys.executable,
                    str(SCRIPT_DIR / "11_Evaluate_Taxonomy_Candidate.py"),
                ], SCRIPT_DIR))

    if args.run_taxonomy_backbone:
        command = [
            sys.executable,
            str(SCRIPT_DIR / "12_Finetune_Taxonomy_BioCLIP_Backbone.py"),
            "--epochs",
            str(args.taxonomy_backbone_epochs),
        ]
        if args.promote_taxonomy_backbone:
            command.append("--promote")
        commands.append(run_command(command, SCRIPT_DIR))

    failed = [command for command in commands if command.get("returncode") not in (0, None)]
    completed_at = utc_now()
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    report_path = report_dir / f"model_update_{timestamp}.json"
    text_report_path = report_dir / f"model_update_{timestamp}.txt"
    latest_path = report_dir / "model_update_latest.json"
    latest_text_path = report_dir / "model_update_latest.txt"
    summary = {
        "status": "failed" if failed else "completed",
        "started_at": started_at,
        "completed_at": completed_at,
        "updated_at": completed_at,
        "elapsed_seconds": round(time.monotonic() - started_monotonic, 3),
        "openpnp_root": str(openpnp_root),
        "debris": debris,
        "taxonomy": taxonomy,
        "commands": commands,
        "promotion_candidates": promotion_candidates(commands),
        "report_json": str(report_path),
        "report_text": str(text_report_path),
    }
    for path in (report_path, latest_path):
        path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    text_report = format_text_report(summary)
    for path in (text_report_path, latest_text_path):
        path.write_text(text_report, encoding="utf-8")
    print(json.dumps(summary, sort_keys=True), flush=True)

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
