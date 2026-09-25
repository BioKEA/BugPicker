#!/usr/bin/env python3
"""Review and label saved BugPicker well/nozzle QA images.

The reviewer mines plate attempt logs for high-value training examples:
manual flips, CV disagreements, relative-only well detections, and ordinary
recent QA images. Labels are appended to Data/qa_feedback/*.jsonl and can be
used to tune the current CV rules or train a future ML QA model.
"""

from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import os
import sys
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_OPENPNP_ROOT = SCRIPT_DIR.parent.parent
QA_FEEDBACK_DIR = SCRIPT_DIR / "Data/qa_feedback"
WELL_LABELS = QA_FEEDBACK_DIR / "well_qa_labels.jsonl"
NOZZLE_LABELS = QA_FEEDBACK_DIR / "nozzle_qa_labels.jsonl"

WELL_LABEL_CHOICES = (
    "empty_well",
    "occupied_well",
)
NOZZLE_LABEL_CHOICES = (
    "empty_nozzle",
    "single_specimen_on_nozzle",
    "multiple_specimens_on_nozzle",
    "bad_pickup_outside_nozzle",
    "uncertain",
)


@dataclass
class Candidate:
    qa_mode: str
    image_path: Path
    priority: int
    reason: str
    suggested_label: str
    prediction: str
    attempt: dict[str, Any]
    model_prediction: str = ""
    model_confidence: float | None = None
    previous_label: str = ""
    model_review_reason: str = ""
    training_miss_count: int | None = None


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


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def latest_labels(label_file: Path) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for record in iter_jsonl(label_file) or []:
        image_path = str(record.get("image_path") or "")
        if image_path:
            latest[str(Path(image_path).resolve())] = record
    return latest


def normalized_training_label(mode: str, label: str) -> str:
    if mode == "nozzle" and label in {
        "single_specimen_on_nozzle",
        "multiple_specimens_on_nozzle",
        "bad_pickup_outside_nozzle",
        "specimen_present",
    }:
        return "specimen_present"
    if mode == "well" and label in {
        "single_specimen_in_well",
        "multiple_specimens_in_well",
        "occupied_well",
    }:
        return "occupied_well"
    return label


def candidate_source(candidate: Candidate) -> str:
    session = str(candidate.attempt.get("capture_session") or "").strip()
    scan_id = str(candidate.attempt.get("scanId") or candidate.attempt.get("scan_id") or "").strip()
    return session or scan_id or candidate.image_path.parent.parent.name


def round_robin_sources(candidates: list[Candidate]) -> list[Candidate]:
    by_source: dict[str, deque[Candidate]] = defaultdict(deque)
    for candidate in candidates:
        by_source[candidate_source(candidate)].append(candidate)
    ordered: list[Candidate] = []
    source_names = deque(sorted(by_source))
    while source_names:
        source = source_names.popleft()
        ordered.append(by_source[source].popleft())
        if by_source[source]:
            source_names.append(source)
    return ordered


def paired_predictions_by_source(candidates: list[Candidate], mode: str) -> list[Candidate]:
    empty_label = "empty_nozzle" if mode == "nozzle" else "empty_well"
    by_source: dict[str, dict[str, deque[Candidate]]] = defaultdict(
        lambda: {"empty": deque(), "occupied": deque()}
    )
    for candidate in candidates:
        bucket = "empty" if candidate.model_prediction == empty_label else "occupied"
        by_source[candidate_source(candidate)][bucket].append(candidate)

    paired: list[Candidate] = []
    leftovers: list[Candidate] = []
    for source in sorted(by_source):
        empty = by_source[source]["empty"]
        occupied = by_source[source]["occupied"]
        if empty and occupied:
            empty_item = empty.popleft()
            occupied_item = occupied.popleft()
            empty_item.model_review_reason = "Never reviewed; predicted empty paired with occupied image from the same run"
            occupied_item.model_review_reason = "Never reviewed; predicted occupied paired with empty image from the same run"
            paired.extend([empty_item, occupied_item])
        leftovers.extend(empty)
        leftovers.extend(occupied)
    return paired + round_robin_sources(leftovers)


def score_with_candidate_model(candidates: list[Candidate], mode: str) -> bool:
    checkpoint_path = QA_FEEDBACK_DIR / "models" / f"{mode}_qa_classifier_candidate.pt"
    cache_path = QA_FEEDBACK_DIR / "models" / f"{mode}_qa_review_scores.json"
    retrainer_path = SCRIPT_DIR / "15_Retrain_QA_Classifier.py"
    if not checkpoint_path.exists() or not retrainer_path.exists():
        print(f"No {mode} QA candidate model is available; using operational priorities.", flush=True)
        return False
    try:
        print(
            f"Preparing candidate-model scores for {len(candidates)} {mode} QA images...",
            flush=True,
        )
        checkpoint_stat = checkpoint_path.stat()
        cache: dict[str, Any] = {}
        if cache_path.exists():
            try:
                cached = json.loads(cache_path.read_text(encoding="utf-8"))
                if (
                    int(cached.get("model_mtime_ns", -1)) == checkpoint_stat.st_mtime_ns
                    and int(cached.get("model_size", -1)) == checkpoint_stat.st_size
                ):
                    cache = dict(cached.get("scores") or {})
            except (OSError, ValueError, TypeError):
                cache = {}
        pending: list[Candidate] = []
        for candidate in candidates:
            key = str(candidate.image_path.resolve())
            cached_score = cache.get(key) or {}
            try:
                image_mtime_ns = candidate.image_path.stat().st_mtime_ns
            except OSError:
                continue
            if int(cached_score.get("image_mtime_ns", -1)) == image_mtime_ns:
                candidate.model_prediction = str(cached_score.get("prediction") or "")
                candidate.model_confidence = float(cached_score["confidence"])
            else:
                pending.append(candidate)
        if not pending:
            print(f"Loaded cached candidate-model scores for {len(candidates)} {mode} QA images.", flush=True)
            return True

        spec = importlib.util.spec_from_file_location("qa_retrainer_for_review", retrainer_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("could not load QA model definitions")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        checkpoint = module.torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        classes = list(checkpoint.get("classes") or [])
        expected_classes = (
            ["empty_well", "occupied_well"]
            if mode == "well" else
            ["empty_nozzle", "specimen_present"]
        )
        if classes != expected_classes:
            print(
                f"Ignoring incompatible {mode} candidate classes {classes}; expected {expected_classes}.",
                flush=True,
            )
            return False
        model = module.model_from_checkpoint(checkpoint)
        model.eval()
        transform = module.qa_eval_transform(model)
        usable: list[tuple[Candidate, Any]] = []
        for candidate in pending:
            try:
                example = module.Example(candidate.image_path, classes[0], {})
                dataset = module.QaDataset([example], {classes[0]: 0}, transform)
                tensor, _label = dataset[0]
                usable.append((candidate, tensor))
            except (OSError, ValueError):
                continue
        print(
            f"Scoring {len(usable)} new or changed images in batches of 32...",
            flush=True,
        )
        with module.torch.inference_mode():
            for start in range(0, len(usable), 32):
                batch = usable[start:start + 32]
                tensors = module.torch.stack([item[1] for item in batch])
                probabilities = module.torch.softmax(model(tensors), dim=1)
                confidence, prediction = module.torch.max(probabilities, dim=1)
                for index, (candidate, _tensor) in enumerate(batch):
                    candidate.model_prediction = classes[int(prediction[index].item())]
                    candidate.model_confidence = float(confidence[index].item())
                    cache[str(candidate.image_path.resolve())] = {
                        "image_mtime_ns": candidate.image_path.stat().st_mtime_ns,
                        "prediction": candidate.model_prediction,
                        "confidence": candidate.model_confidence,
                    }
                print(
                    f"Scored {min(start + len(batch), len(usable))} / {len(usable)} images.",
                    flush=True,
                )
        cache_path.write_text(json.dumps({
            "model_mtime_ns": checkpoint_stat.st_mtime_ns,
            "model_size": checkpoint_stat.st_size,
            "scores": cache,
        }, sort_keys=True), encoding="utf-8")
        print(
            f"Scored {len(usable)} new or changed {mode} QA images with {checkpoint_path.name}; "
            f"saved {len(cache)} cached scores.",
            flush=True,
        )
        return True
    except Exception as error:
        print(f"Could not apply candidate-model prioritization: {error}", flush=True)
        return False


def apply_training_miss_counts(candidates: list[Candidate], mode: str) -> None:
    report_path = QA_FEEDBACK_DIR / "models" / f"{mode}_qa_classifier_report.json"
    if not report_path.exists():
        return
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
        miss_counts = report.get("validation_miss_counts") or {}
        by_path = {str(candidate.image_path.resolve()): candidate for candidate in candidates}
        for image_path, count in miss_counts.items():
            candidate = by_path.get(str(Path(image_path).resolve()))
            if candidate is not None:
                candidate.training_miss_count = int(count)
    except (OSError, ValueError, TypeError):
        return


def model_priority_buckets(
    candidates: list[Candidate],
    reviewed: dict[str, dict[str, Any]],
    mode: str,
) -> tuple[list[Candidate], list[Candidate], list[Candidate], list[Candidate]]:
    disagreements: list[Candidate] = []
    uncertain: list[Candidate] = []
    unseen: list[Candidate] = []
    remaining: list[Candidate] = []
    for candidate in candidates:
        previous = reviewed.get(str(candidate.image_path.resolve()))
        candidate.previous_label = str((previous or {}).get("user_label") or "")
        expected = normalized_training_label(mode, candidate.previous_label)
        confidence = candidate.model_confidence
        if (
            confidence is not None
            and previous
            and expected != "uncertain"
            and candidate.model_prediction != expected
        ):
            candidate.model_review_reason = "Candidate disagrees with saved label; verify possible mislabel or hard example"
            disagreements.append(candidate)
        elif confidence is not None and confidence < 0.75:
            candidate.model_review_reason = "Candidate has low confidence"
            uncertain.append(candidate)
        elif confidence is not None and previous is None:
            candidate.model_review_reason = "Never reviewed; sampled from a different run or session"
            unseen.append(candidate)
        else:
            candidate.model_review_reason = (
                "Image could not be scored by the candidate model"
                if confidence is None else
                "Reviewed and confidently predicted"
            )
            remaining.append(candidate)

    confidence_key = lambda item: (-(item.training_miss_count or 0), -(item.model_confidence or 0.0))
    disagreements.sort(key=confidence_key)
    uncertain.sort(key=lambda item: item.model_confidence if item.model_confidence is not None else 1.0)
    unseen.sort(key=lambda item: item.model_confidence if item.model_confidence is not None else 1.0)
    remaining.sort(key=lambda item: item.model_confidence if item.model_confidence is not None else 1.0)
    return (
        round_robin_sources(disagreements),
        round_robin_sources(uncertain),
        paired_predictions_by_source(unseen, mode),
        round_robin_sources(remaining),
    )


def select_model_priority_queue(
    buckets: tuple[list[Candidate], list[Candidate], list[Candidate], list[Candidate]],
    limit: int,
    include_reviewed: bool,
) -> list[Candidate]:
    disagreements, uncertain, unseen, remaining = buckets
    if not include_reviewed:
        remaining = [item for item in remaining if not item.previous_label]
    if limit <= 0:
        limit = sum(len(bucket) for bucket in (disagreements, uncertain, unseen, remaining))
    quotas = (round(limit * 0.45), round(limit * 0.30), limit - round(limit * 0.45) - round(limit * 0.30))
    selected = disagreements[:quotas[0]] + uncertain[:quotas[1]] + unseen[:quotas[2]]
    selected_paths = {str(item.image_path.resolve()) for item in selected}
    for candidate in disagreements + uncertain + unseen + remaining:
        key = str(candidate.image_path.resolve())
        if len(selected) >= limit:
            break
        if key not in selected_paths:
            selected.append(candidate)
            selected_paths.add(key)
    return selected


def boolish(value: Any) -> bool:
    return value is True or str(value).strip().lower() == "true"


def normalize_plate_folder(path: Path) -> str:
    name = path.name
    return name[2:] if name.startswith("P-") else name


def resolve_scan_image(attempt: dict[str, Any], folder_name: str, scan_dir: Path) -> Path | None:
    name = str(attempt.get(folder_name) or "").strip()
    if not name or not scan_dir.exists():
        return None
    direct = scan_dir / folder_name / name
    if direct.exists():
        return direct
    if folder_name == "wellImage":
        candidates = [
            scan_dir / "qa" / "wells" / name,
            scan_dir / "hires" / name,
        ]
    elif folder_name == "bottomImage":
        candidates = [
            scan_dir / "bottom_inspections" / name,
        ]
    elif folder_name == "hiResImage":
        candidates = [
            scan_dir / "hires" / name,
        ]
    elif folder_name == "topWellImage":
        candidates = [
            scan_dir / "qa" / "wells_top" / name,
        ]
    else:
        candidates = [
            scan_dir / name,
        ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def attempt_scan_dir(openpnp_root: Path, attempt: dict[str, Any]) -> Path:
    raw = str(attempt.get("scanDir") or "").strip()
    if raw:
        return Path(raw)
    scan_id = str(attempt.get("scanId") or "").strip()
    return openpnp_root / "scans" / scan_id


def well_candidate(openpnp_root: Path, attempt: dict[str, Any]) -> Candidate | None:
    scan_dir = attempt_scan_dir(openpnp_root, attempt)
    image_path = resolve_scan_image(attempt, "topWellImage", scan_dir)
    if image_path is None:
        return None

    outcome = str(attempt.get("confirmation") or "").strip().lower()
    bottom_present = boolish(attempt.get("bottom_bug_present"))
    relative_only = boolish(attempt.get("well_relative_only_occupancy"))
    manual_occupied = "manual occupied" in outcome
    qa_empty = outcome == "well qa empty"
    qa_occupied = outcome == "well qa occupied"

    priority = 10
    reason = "ordinary well QA image"
    suggested = "uncertain"
    prediction = "unknown"

    if manual_occupied:
        priority = 100
        reason = "manual review changed well to occupied"
        suggested = "occupied_well"
        prediction = "empty_well"
    elif relative_only:
        priority = 95
        reason = "well QA was relative-only texture/shape"
        suggested = "occupied_well"
        prediction = "occupied_well"
    elif qa_occupied and not bottom_present:
        priority = 90
        reason = "well QA said occupied but bottom QA said empty"
        suggested = "occupied_well"
        prediction = "occupied_well"
    elif qa_empty and bottom_present:
        priority = 85
        reason = "well QA said empty but bottom QA had a specimen"
        suggested = "occupied_well"
        prediction = "empty_well"
    elif qa_empty:
        priority = 35
        reason = "well QA empty"
        suggested = "empty_well"
        prediction = "empty_well"
    elif qa_occupied:
        priority = 30
        reason = "well QA occupied"
        suggested = "occupied_well"
        prediction = "occupied_well"

    return Candidate("well", image_path, priority, reason, suggested, prediction, attempt)


def nozzle_candidate(openpnp_root: Path, attempt: dict[str, Any]) -> Candidate | None:
    scan_dir = attempt_scan_dir(openpnp_root, attempt)
    image_path = resolve_scan_image(attempt, "bottomImage", scan_dir)
    if image_path is None:
        return None

    bottom_present = boolish(attempt.get("bottom_bug_present"))
    possible_multiple = boolish(attempt.get("bottom_possible_multiple"))
    outcome = str(attempt.get("confirmation") or "").strip().lower()

    priority = 20
    reason = "ordinary bottom/nozzle QA image"
    prediction = "single_specimen_on_nozzle" if bottom_present else "empty_nozzle"
    suggested = prediction

    if possible_multiple:
        priority = 100
        reason = "bottom QA flagged possible multiple specimens"
        prediction = "multiple_specimens_on_nozzle"
        suggested = "multiple_specimens_on_nozzle"
    elif bottom_present and outcome == "well qa empty":
        priority = 85
        reason = "bottom QA had specimen but well QA was empty"
        suggested = "single_specimen_on_nozzle"
    elif not bottom_present and outcome == "well qa occupied":
        priority = 80
        reason = "bottom QA empty but well QA was occupied"
        suggested = "uncertain"
    elif not bottom_present:
        priority = 40
        reason = "bottom QA empty"
        suggested = "empty_nozzle"

    return Candidate("nozzle", image_path, priority, reason, suggested, prediction, attempt)


def harvest_candidates(openpnp_root: Path, mode: str) -> list[Candidate]:
    plate_root = openpnp_root / "Plate_insect_images"
    candidates: list[Candidate] = []
    if not plate_root.exists():
        return candidates
    for log_file in sorted(plate_root.glob("P-*/plate_attempts.jsonl")):
        plate = normalize_plate_folder(log_file.parent)
        for attempt in iter_jsonl(log_file) or []:
            attempt.setdefault("plate_number", plate)
            candidate = well_candidate(openpnp_root, attempt) if mode == "well" else nozzle_candidate(openpnp_root, attempt)
            if candidate is not None:
                candidates.append(candidate)
    if mode == "nozzle":
        scans_root = openpnp_root / "scans"
        supplemental_patterns = (
            ("*preflight_before_first_pick*_bottom.png", 95, "archived preflight nozzle image", "empty_nozzle"),
            ("*post_pick*_bottom.png", 94, "archived post-pick nozzle image", "uncertain"),
            ("*post_clean*_bottom.png", 90, "archived post-clean nozzle image", "uncertain"),
            ("*manual_clean_check*_bottom.png", 90, "archived manual-clean nozzle image", "uncertain"),
        )
        for pattern, priority, reason, suggested in supplemental_patterns:
            for image_path in scans_root.glob(f"scan_*/bottom_inspections/{pattern}"):
                scan_dir = image_path.parent.parent
                candidates.append(Candidate(
                    "nozzle",
                    image_path,
                    priority,
                    reason,
                    suggested,
                    "not_evaluated",
                    {
                        "scanId": scan_dir.name,
                        "scanDir": str(scan_dir),
                        "bottomImage": image_path.name,
                    },
                ))
    best_by_image: dict[str, Candidate] = {}
    for candidate in candidates:
        key = str(candidate.image_path.resolve())
        previous = best_by_image.get(key)
        if previous is None or candidate.priority > previous.priority:
            best_by_image[key] = candidate
    return sorted(
        best_by_image.values(),
        key=lambda item: (
            -item.priority,
            str(item.attempt.get("scanId") or ""),
            int(item.attempt.get("targetNumber") or 0),
            str(item.image_path),
        ),
    )


def candidate_to_record(candidate: Candidate) -> dict[str, Any]:
    attempt = candidate.attempt
    return {
        "qa_mode": candidate.qa_mode,
        "image_path": str(candidate.image_path.resolve()),
        "priority": candidate.priority,
        "reason": candidate.reason,
        "suggested_label": candidate.suggested_label,
        "cv_prediction": candidate.prediction,
        "model_prediction": candidate.model_prediction,
        "model_confidence": candidate.model_confidence,
        "previous_label": candidate.previous_label,
        "model_review_reason": candidate.model_review_reason,
        "training_miss_count": candidate.training_miss_count,
        "plate_number": attempt.get("plate_number", ""),
        "well": attempt.get("well", ""),
        "scan_id": attempt.get("scanId", ""),
        "scan_dir": attempt.get("scanDir", ""),
        "target_number": attempt.get("targetNumber", ""),
        "object_index": attempt.get("objectIndex", ""),
        "confirmation": attempt.get("confirmation", ""),
        "bottom_bug_present": attempt.get("bottom_bug_present", ""),
        "bottom_possible_multiple": attempt.get("bottom_possible_multiple", ""),
        "well_relative_only_occupancy": attempt.get("well_relative_only_occupancy", ""),
        "hires_image": attempt.get("hiResImage", ""),
        "bottom_image": attempt.get("bottomImage", ""),
        "well_image": attempt.get("wellImage", ""),
        "top_well_image": attempt.get("topWellImage", ""),
    }


def run_gui(candidates: list[Candidate], mode: str, label_file: Path) -> int:
    try:
        import tkinter as tk
        from tkinter import messagebox, ttk
        from PIL import Image, ImageTk
    except Exception as error:
        raise SystemExit(
            "QA label review needs tkinter and Pillow GUI support. "
            f"Import failed: {error}"
        )

    labels = WELL_LABEL_CHOICES if mode == "well" else NOZZLE_LABEL_CHOICES
    root = tk.Tk()
    root.title(f"BugPicker QA Label Review - {mode}")
    root.geometry("1180x820")

    state = {
        "index": 0,
        "photo": None,
        "saved": 0,
    }

    header = ttk.Label(root, text="", font=("TkDefaultFont", 13, "bold"))
    header.pack(fill="x", padx=10, pady=(8, 2))
    subheader = ttk.Label(root, text="", justify="left")
    subheader.pack(fill="x", padx=10, pady=(0, 8))

    image_label = ttk.Label(root, anchor="center")
    image_label.pack(fill="both", expand=True, padx=10, pady=4)

    button_frame = ttk.Frame(root)
    button_frame.pack(fill="x", padx=10, pady=8)

    status = ttk.Label(root, text="")
    status.pack(fill="x", padx=10, pady=(0, 8))

    def current() -> Candidate | None:
        if state["index"] >= len(candidates):
            return None
        return candidates[state["index"]]

    def show_current() -> None:
        candidate = current()
        if candidate is None:
            header.config(text="Review complete")
            subheader.config(text=f"Saved {state['saved']} labels to {label_file}")
            image_label.config(image="", text="No more candidates.")
            status.config(text="")
            return

        record = candidate_to_record(candidate)
        header.config(
            text=(
                f"{state['index'] + 1}/{len(candidates)}  "
                f"{candidate.qa_mode.upper()}  {candidate.reason}"
            )
        )
        subheader.config(
            text=(
                f"Suggested: {candidate.suggested_label} | CV: {candidate.prediction} | "
                + (
                    f"Model: {candidate.model_prediction} "
                    f"({candidate.model_confidence:.1%}) | Previous: {candidate.previous_label or 'none'} | "
                    + (
                        f"Missed in {candidate.training_miss_count} training run(s)\n"
                        if candidate.training_miss_count is not None else
                        "Training-run miss count: available after next retraining\n"
                    )
                    if candidate.model_confidence is not None else ""
                )
                + (
                    f"Priority: {candidate.model_review_reason}\n"
                    if candidate.model_review_reason else ""
                )
                + (
                f"Plate {record['plate_number']} well {record['well']} | "
                f"{record['scan_id']} target {record['target_number']} object {record['object_index']}\n"
                f"{candidate.image_path}"
                )
            )
        )
        try:
            image = Image.open(candidate.image_path).convert("RGB")
            image.thumbnail((1120, 610), Image.Resampling.LANCZOS)
            state["photo"] = ImageTk.PhotoImage(image)
            image_label.config(image=state["photo"], text="")
        except Exception as error:
            state["photo"] = None
            image_label.config(image="", text=f"Could not open image:\n{error}")
        status.config(
            text=(
                f"Saved {state['saved']} this session. "
                "Shortcuts: number keys label, S skip, Q quit."
            )
        )

    def save_label(label: str) -> None:
        candidate = current()
        if candidate is None:
            return
        record = candidate_to_record(candidate)
        record.update({
            "user_label": label,
            "reviewed_at": utc_now(),
            "review_source": "qa_label_review",
        })
        append_jsonl(label_file, record)
        state["saved"] += 1
        state["index"] += 1
        show_current()

    def skip() -> None:
        state["index"] += 1
        show_current()

    def finish() -> None:
        root.destroy()

    for idx, label in enumerate(labels, start=1):
        button = ttk.Button(
            button_frame,
            text=f"{idx}. {label}",
            command=lambda value=label: save_label(value),
        )
        button.pack(side="left", padx=4)
    ttk.Button(button_frame, text="Skip", command=skip).pack(side="left", padx=14)
    ttk.Button(button_frame, text="Quit", command=finish).pack(side="right", padx=4)

    for idx, label in enumerate(labels, start=1):
        root.bind(str(idx), lambda _event, value=label: save_label(value))
    root.bind("s", lambda _event: skip())
    root.bind("S", lambda _event: skip())
    root.bind("q", lambda _event: finish())
    root.bind("Q", lambda _event: finish())

    if not candidates:
        messagebox.showinfo("BugPicker QA Label Review", "No review candidates found.")
    show_current()
    root.mainloop()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--openpnp-root", type=Path, default=DEFAULT_OPENPNP_ROOT)
    parser.add_argument("--mode", choices=("well", "nozzle"), required=True)
    parser.add_argument("--max-examples", type=int, default=250)
    parser.add_argument("--include-reviewed", action="store_true")
    parser.add_argument("--priority-only", action="store_true")
    parser.add_argument("--model-priority", action="store_true")
    parser.add_argument("--export-candidates", type=Path)
    args = parser.parse_args()

    QA_FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = QA_FEEDBACK_DIR / f"qa_label_review_{args.mode}.lock"
    lock_handle = lock_path.open("w", encoding="utf-8")
    try:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(
            f"Another {args.mode} QA label review is already running. "
            "Close or cancel it before starting another.",
            flush=True,
        )
        return 2
    lock_handle.write(f"pid={os.getpid()}\n")
    lock_handle.flush()

    openpnp_root = args.openpnp_root.resolve()
    label_file = WELL_LABELS if args.mode == "well" else NOZZLE_LABELS
    print(f"Loading {args.mode} QA review records...", flush=True)
    reviewed = latest_labels(label_file)
    candidates = harvest_candidates(openpnp_root, args.mode)
    print(
        f"Found {len(candidates)} candidate images and {len(reviewed)} reviewed labels.",
        flush=True,
    )
    apply_training_miss_counts(candidates, args.mode)
    scoring_candidates = candidates
    if args.model_priority and not args.include_reviewed:
        prior_misses = [
            candidate for candidate in candidates
            if (candidate.training_miss_count or 0) > 0
        ]
        unreviewed = [
            candidate for candidate in candidates
            if str(candidate.image_path.resolve()) not in reviewed
        ]
        unreviewed.sort(
            key=lambda candidate: (
                candidate.priority,
                str(candidate.attempt.get("scanId") or ""),
                str(candidate.image_path),
            ),
            reverse=True,
        )
        scoring_budget = max(100, args.max_examples * 2) if args.max_examples > 0 else 500
        selected_by_path = {
            str(candidate.image_path.resolve()): candidate
            for candidate in prior_misses + unreviewed[:scoring_budget]
        }
        scoring_candidates = list(selected_by_path.values())
        print(
            f"Fast startup: scoring {len(scoring_candidates)} recent unreviewed or prior-miss images; "
            "enable already-reviewed images for a full rescore.",
            flush=True,
        )
    model_priority_applied = (
        args.model_priority
        and score_with_candidate_model(scoring_candidates, args.mode)
    )
    if model_priority_applied:
        buckets = model_priority_buckets(scoring_candidates, reviewed, args.mode)
        candidates = select_model_priority_queue(
            buckets,
            args.max_examples,
            args.include_reviewed,
        )
        print(
            "Model-priority queue: "
            f"{sum(bool(item.previous_label) and 'disagrees' in item.model_review_reason for item in candidates)} disagreements, "
            f"{sum('low confidence' in item.model_review_reason.lower() for item in candidates)} low-confidence, "
            f"{sum(not item.previous_label for item in candidates)} never-reviewed examples.",
            flush=True,
        )
    elif args.priority_only:
        candidates = [candidate for candidate in candidates if candidate.priority >= 80]
    if not model_priority_applied and not args.include_reviewed:
        candidates = [
            candidate for candidate in candidates
            if str(candidate.image_path.resolve()) not in reviewed
        ]
    if not model_priority_applied:
        candidates.sort(
            key=lambda candidate: (
                candidate.priority,
                str(candidate.attempt.get("scanId") or ""),
                str(candidate.image_path),
            ),
            reverse=True,
        )
    if not model_priority_applied and args.max_examples > 0:
        candidates = candidates[:args.max_examples]

    if args.export_candidates:
        args.export_candidates.parent.mkdir(parents=True, exist_ok=True)
        with args.export_candidates.open("w", encoding="utf-8") as handle:
            for candidate in candidates:
                handle.write(json.dumps(candidate_to_record(candidate), sort_keys=True) + "\n")
        print(f"Exported {len(candidates)} candidates to {args.export_candidates}")
        return 0

    print(f"Reviewing {len(candidates)} {args.mode} QA candidate(s). Labels: {label_file}", flush=True)
    return run_gui(candidates, args.mode, label_file)


if __name__ == "__main__":
    raise SystemExit(main())
