#!/usr/bin/env python3
"""Classify BugPicker target crops before manual pick/debris review."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_PATH = Path(__file__).resolve()
SCRIPTS_DIR = SCRIPT_PATH.parent
DEFAULT_MODEL_PATH = SCRIPTS_DIR / "Data/insect_debris_classifier.pt"
PREFERRED_PYTHON = SCRIPTS_DIR / ".venv/bin/python"

if Path(sys.executable) != PREFERRED_PYTHON and PREFERRED_PYTHON.exists():
    import os

    os.execv(str(PREFERRED_PYTHON), [str(PREFERRED_PYTHON), str(SCRIPT_PATH), *sys.argv[1:]])

try:
    import cv2
except ModuleNotFoundError as exc:
    raise SystemExit(f"Missing dependency {exc.name!r}; run with {PREFERRED_PYTHON}") from exc

from insect_debris_classifier import InsectDebrisClassifier


def iter_jsonl(path: Path):
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def crop_path_for_record(scan_dir: Path, record: dict[str, Any]) -> Path | None:
    crop = record.get("crop_file")
    if not crop:
        return None
    path = Path(str(crop))
    return path if path.is_absolute() else scan_dir / path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scan_dir", type=Path)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument("--threshold", type=float, default=0.45)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    scan_dir = args.scan_dir.resolve()
    objects_file = scan_dir / "objects.jsonl"
    output_file = scan_dir / "classifier_predictions.jsonl"
    summary_file = scan_dir / "classifier_predictions_summary.json"

    if not objects_file.exists():
        raise SystemExit(f"objects.jsonl not found: {objects_file}")

    classifier = InsectDebrisClassifier(
        args.model,
        threshold=args.threshold,
        device=args.device,
    )

    counts = {
        "total": 0,
        "classified": 0,
        "errors": 0,
        "predicted_insect": 0,
        "predicted_debris": 0,
    }

    with output_file.open("w", encoding="utf-8") as out:
        for record in iter_jsonl(objects_file):
            counts["total"] += 1
            prediction: dict[str, Any] = {
                "object_index": record.get("object_index"),
                "original_object_index": record.get("object_index"),
                "candidate_index": record.get("candidate_index"),
                "frame_index": record.get("frame_index"),
                "crop_file": record.get("crop_file", ""),
                "model_path": str(args.model),
                "threshold": args.threshold,
            }
            crop_path = crop_path_for_record(scan_dir, record)
            try:
                if crop_path is None:
                    raise ValueError("missing crop_file")
                image = cv2.imread(str(crop_path))
                if image is None:
                    raise ValueError(f"could not read crop: {crop_path}")
                result = classifier.classify_bgr(image)
                prediction.update(result)
                counts["classified"] += 1
                if result["class"] == "insect":
                    counts["predicted_insect"] += 1
                else:
                    counts["predicted_debris"] += 1
            except Exception as exc:  # Keep review usable if one crop is bad.
                prediction.update(
                    {
                        "class": "unknown",
                        "would_pick": True,
                        "insect_probability": None,
                        "debris_probability": None,
                        "error": str(exc),
                    }
                )
                counts["errors"] += 1
            out.write(json.dumps(prediction, sort_keys=True) + "\n")

    summary = {
        "scan_dir": str(scan_dir),
        "objects_file": str(objects_file),
        "output_file": str(output_file),
        "model_path": str(args.model),
        "threshold": args.threshold,
        **counts,
    }
    summary_file.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
