#!/usr/bin/env python3
"""08: Classify completed BugPicker plate specimens from saved multi-view images."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from plate_xlsx_export import synchronize_workbook, DEFAULT_TEMPLATE
from taxonomy_classifier import TaxonomyClassifier

IMAGE_KINDS = ("scan", "hires", "bottom", "well")
INVALID_IMAGE_CODES = {"", "nan", "none", "null", "<blank>", "blank"}

AI_COLUMNS = [
    "AI Order",
    "AI Order Confidence",
    "AI Order Top 3",
    "AI Species",
    "AI Species Confidence",
    "AI Species Top 3",
    "AI Taxonomy Model",
    "AI Taxonomy Fusion",
    "AI Taxonomy Views",
    "AI Taxonomy Status",
    "AI Taxonomy Error",
    "AI Taxonomy Timestamp",
    "Taxonomy Review Status",
    "Taxonomy Reviewed Order",
    "Taxonomy Image Consistency",
    "Taxonomy Reviewed At",
]

CONSISTENCY_OPTIONS = [
    "Same specimen across images",
    "Different specimen in one or more non-well images",
    "Multiple specimens in one or more non-well images",
    "Multiple specimens in well",
    "Unclear / cannot determine",
    "Bad or missing image",
]
DEFAULT_IMAGE_CONSISTENCY = CONSISTENCY_OPTIONS[0]
CONSISTENCY_NOTE_PREFIX = "Taxonomy image consistency: "


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_plate(value: str) -> str:
    plate = "".join(ch for ch in value.strip().upper() if ch.isalnum() or ch in "_-")
    if not plate:
        raise ValueError("Plate number must not be blank")
    return plate


def normalize_image_code(value: Any) -> str:
    if value is None:
        return ""
    image_code = str(value).strip()
    if image_code.lower() in INVALID_IMAGE_CODES:
        return ""
    return image_code


def find_image_paths(image_dir: Path, image_code: str) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for kind in IMAGE_KINDS:
        path = image_dir / f"{image_code}_{kind}.png"
        if path.exists():
            result[kind] = path
    return result


def format_top3(items: list[dict[str, Any]]) -> str:
    return " | ".join(f"{item['name']}:{float(item['confidence']):.6f}" for item in items)


def parse_top3(value: str) -> list[str]:
    names = []
    for item in str(value or "").split("|"):
        name = item.strip().split(":", 1)[0].strip()
        if name:
            names.append(name)
    return names


def mock_prediction(image_code: str, views: list[str]) -> dict[str, Any]:
    orders = ["Diptera", "Hemiptera", "Hymenoptera", "Coleoptera"]
    digest = hashlib.sha256(image_code.encode("utf-8")).digest()
    index = digest[0] % len(orders)
    order = orders[index]
    confidence = 0.80 + ((digest[1] % 16) / 100.0)
    other = [value for value in orders if value != order][:2]
    top3 = [
        {"name": order, "confidence": confidence},
        {"name": other[0], "confidence": (1.0 - confidence) * 0.65},
        {"name": other[1], "confidence": (1.0 - confidence) * 0.35},
    ]
    return {
        "model": "mock_taxonomy",
        "kind": "mock",
        "fusion": "mock_four_view",
        "checkpoint": "",
        "views_used": views,
        "order": order,
        "order_confidence": confidence,
        "order_top3": top3,
        "species": "mock species",
        "species_confidence": confidence * 0.85,
        "species_top3": [{"name": "mock species", "confidence": confidence * 0.85}],
    }


def atomic_write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        with temp_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        temp_path.replace(path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def ensure_columns(fieldnames: list[str]) -> list[str]:
    if "Order" not in fieldnames:
        fieldnames.append("Order")
    if "Notes" not in fieldnames:
        fieldnames.append("Notes")
    for column in AI_COLUMNS:
        if column not in fieldnames:
            fieldnames.append(column)
    return fieldnames


def apply_consistency_note(row: dict[str, str], consistency: str) -> None:
    existing_parts = [
        part.strip()
        for part in str(row.get("Notes") or "").split(";")
        if part.strip() and not part.strip().startswith(CONSISTENCY_NOTE_PREFIX)
    ]
    if consistency and consistency != DEFAULT_IMAGE_CONSISTENCY:
        existing_parts.append(CONSISTENCY_NOTE_PREFIX + consistency)
    row["Notes"] = "; ".join(existing_parts)


def apply_prediction_to_row(row: dict[str, str], prediction: dict[str, Any]) -> None:
    row["AI Order"] = str(prediction["order"])
    row["AI Order Confidence"] = f"{float(prediction['order_confidence']):.6f}"
    row["AI Order Top 3"] = format_top3(prediction["order_top3"])
    row["AI Species"] = str(prediction.get("species", ""))
    row["AI Species Confidence"] = f"{float(prediction.get('species_confidence', 0.0)):.6f}"
    row["AI Species Top 3"] = format_top3(prediction.get("species_top3", []))
    row["AI Taxonomy Model"] = str(prediction["model"])
    row["AI Taxonomy Fusion"] = str(prediction["fusion"])
    row["AI Taxonomy Views"] = "+".join(prediction["views_used"])
    row["AI Taxonomy Status"] = "classified"
    row["AI Taxonomy Error"] = ""
    row["AI Taxonomy Timestamp"] = utc_now()


def write_reports(report_dir: Path, run_records: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    report_dir.mkdir(parents=True, exist_ok=True)
    with (report_dir / "taxonomy_predictions_last_run.jsonl").open("w", encoding="utf-8") as handle:
        for record in run_records:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
    with (report_dir / "taxonomy_predictions_history.jsonl").open("a", encoding="utf-8") as handle:
        for record in run_records:
            history_record = dict(record)
            history_record["recorded_at"] = utc_now()
            handle.write(json.dumps(history_record, sort_keys=True) + "\n")
    (report_dir / "taxonomy_predictions_summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def load_order_names(classifier: TaxonomyClassifier | None, rows: list[dict[str, str]]) -> list[str]:
    names: set[str] = set()
    if classifier is not None:
        names.update(str(name) for name in classifier.order_names)
    for row in rows:
        names.update(parse_top3(row.get("AI Order Top 3", "")))
        for column in ("AI Order", "Order"):
            value = str(row.get(column) or "").strip()
            if value:
                names.add(value)
    return sorted(names)


def review_predictions(
    plate: str,
    image_dir: Path,
    report_dir: Path,
    rows: list[dict[str, str]],
    row_indices: list[int],
    order_names: list[str],
) -> int:
    try:
        import tkinter as tk
        from tkinter import ttk
        from PIL import Image, ImageTk
    except Exception as exc:
        raise RuntimeError(
            "Train taxonomy mode needs tkinter and Pillow GUI support. "
            "Use --mode auto or install python3-tk."
        ) from exc

    decisions: list[dict[str, Any]] = []
    root = tk.Tk()
    root.title(f"BugPicker Taxonomy Review - P-{plate}")
    root.geometry("1280x900")

    title_var = tk.StringVar()
    prediction_var = tk.StringVar()
    order_var = tk.StringVar()
    consistency_var = tk.StringVar(value=DEFAULT_IMAGE_CONSISTENCY)

    header = ttk.Frame(root, padding=8)
    header.pack(fill="x")
    ttk.Label(header, textvariable=title_var, font=("TkDefaultFont", 14, "bold")).pack(anchor="w")
    ttk.Label(header, textvariable=prediction_var).pack(anchor="w")

    image_frame = ttk.Frame(root, padding=8)
    image_frame.pack(fill="both", expand=True)
    image_labels: dict[str, ttk.Label] = {}
    image_refs: dict[str, Any] = {}
    for idx, kind in enumerate(IMAGE_KINDS):
        cell = ttk.Frame(image_frame, relief="groove", padding=4)
        cell.grid(row=idx // 2, column=idx % 2, sticky="nsew", padx=4, pady=4)
        ttk.Label(cell, text=kind).pack(anchor="w")
        label = ttk.Label(cell)
        label.pack(fill="both", expand=True)
        image_labels[kind] = label
    image_frame.columnconfigure(0, weight=1)
    image_frame.columnconfigure(1, weight=1)
    image_frame.rowconfigure(0, weight=1)
    image_frame.rowconfigure(1, weight=1)

    controls = ttk.Frame(root, padding=8)
    controls.pack(fill="x")
    ttk.Label(controls, text="Order").grid(row=0, column=0, sticky="w")
    order_box = ttk.Combobox(controls, textvariable=order_var, values=order_names, width=36)
    order_box.grid(row=0, column=1, sticky="ew", padx=6)
    ttk.Label(controls, text="Image consistency").grid(row=1, column=0, sticky="w")
    consistency_box = ttk.Combobox(
        controls,
        textvariable=consistency_var,
        values=CONSISTENCY_OPTIONS,
        width=52,
        state="readonly",
    )
    consistency_box.grid(row=1, column=1, sticky="ew", padx=6)
    controls.columnconfigure(1, weight=1)

    current = {"index": 0, "saved": False}

    def scaled_photo(path: Path) -> Any:
        image = Image.open(path).convert("RGB")
        image.thumbnail((570, 320), Image.Resampling.LANCZOS)
        return ImageTk.PhotoImage(image)

    def load_current() -> None:
        current["saved"] = False
        row_index = row_indices[current["index"]]
        row = rows[row_index]
        well = str(row.get("Well Number") or "").strip()
        image_code = normalize_image_code(row.get("Image Code"))
        title_var.set(f"{current['index'] + 1} of {len(row_indices)}    Well {well}    {image_code}")
        prediction_var.set(
            f"AI Order: {row.get('AI Order', '')} "
            f"({row.get('AI Order Confidence', '')})    Top 3: {row.get('AI Order Top 3', '')}"
        )
        order_var.set(str(row.get("AI Order") or row.get("Order") or ""))
        consistency_var.set(str(row.get("Taxonomy Image Consistency") or DEFAULT_IMAGE_CONSISTENCY))
        paths = find_image_paths(image_dir, image_code)
        for kind, label in image_labels.items():
            if kind in paths:
                photo = scaled_photo(paths[kind])
                image_refs[kind] = photo
                label.configure(image=photo, text="")
            else:
                image_refs[kind] = None
                label.configure(image="", text=f"Missing {kind} image")

    def save_decision() -> None:
        row_index = row_indices[current["index"]]
        row = rows[row_index]
        selected_order = str(order_var.get() or "").strip()
        consistency = str(consistency_var.get() or "").strip()
        now = utc_now()
        row["Taxonomy Review Status"] = "validated" if selected_order else "no_order"
        row["Taxonomy Reviewed Order"] = selected_order
        row["Taxonomy Image Consistency"] = consistency
        row["Taxonomy Reviewed At"] = now
        apply_consistency_note(row, consistency)
        if selected_order:
            row["Order"] = selected_order
        decision = {
            "plate": plate,
            "well": str(row.get("Well Number") or "").strip(),
            "image_code": normalize_image_code(row.get("Image Code")),
            "ai_order": row.get("AI Order", ""),
            "reviewed_order": selected_order,
            "image_consistency": consistency,
            "reviewed_at": now,
        }
        decisions.append(decision)
        with (report_dir / "taxonomy_review_decisions.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(decision, sort_keys=True) + "\n")
        current["saved"] = True

    def next_item() -> None:
        if not current["saved"]:
            save_decision()
        if current["index"] + 1 >= len(row_indices):
            root.destroy()
            return
        current["index"] += 1
        load_current()

    def previous_item() -> None:
        if current["index"] > 0:
            current["index"] -= 1
            load_current()

    button_bar = ttk.Frame(root, padding=8)
    button_bar.pack(fill="x")
    ttk.Button(button_bar, text="Back", command=previous_item).pack(side="left")
    ttk.Button(button_bar, text="Save", command=save_decision).pack(side="right")
    ttk.Button(button_bar, text="Save and Next", command=next_item).pack(side="right", padx=8)

    load_current()
    root.mainloop()
    return len(decisions)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--openpnp-root", type=Path, required=True)
    parser.add_argument("--plate", required=True)
    parser.add_argument("--mode", choices=("train", "auto"), default="train")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--mock", action="store_true", help="Exercise integration without loading BioCLIP/checkpoints")
    args = parser.parse_args()

    root = args.openpnp_root.resolve()
    plate = normalize_plate(args.plate)
    csv_path = root / "Plate_spreadsheets" / f"{plate}.csv"
    image_dir = root / "Plate_insect_images" / f"P-{plate}"
    report_dir = root / "Plate_taxonomy" / f"P-{plate}"
    if not csv_path.exists():
        raise SystemExit(f"Plate CSV not found: {csv_path}")
    if not image_dir.exists():
        raise SystemExit(f"Plate image directory not found: {image_dir}")

    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = ensure_columns(list(reader.fieldnames or []))
        rows = [dict(row) for row in reader]

    classifier = None if args.mock else TaxonomyClassifier()
    processed = 0
    skipped = 0
    errors = 0
    review_indices: list[int] = []
    run_records: list[dict[str, Any]] = []

    for row_index, row in enumerate(rows):
        image_code = normalize_image_code(row.get("Image Code"))
        well = str(row.get("Well Number") or "").strip()
        if not image_code:
            skipped += 1
            continue
        if (
            not args.force
            and args.mode == "train"
            and str(row.get("Taxonomy Review Status") or "").strip().lower() == "validated"
        ):
            skipped += 1
            continue
        if (
            not args.force
            and args.mode == "auto"
            and str(row.get("Order") or "").strip()
            and str(row.get("AI Taxonomy Status") or "").strip().lower() == "classified"
        ):
            skipped += 1
            continue

        image_paths = find_image_paths(image_dir, image_code)
        try:
            if not image_paths:
                raise FileNotFoundError(f"No plate specimen images found for {image_code}")
            prediction = (
                mock_prediction(image_code, sorted(image_paths))
                if args.mock
                else classifier.classify(image_paths)  # type: ignore[union-attr]
            )
            apply_prediction_to_row(row, prediction)
            if args.mode == "auto":
                row["Order"] = str(prediction["order"])
                row["Taxonomy Review Status"] = "auto"
                row["Taxonomy Reviewed Order"] = str(prediction["order"])
                row["Taxonomy Image Consistency"] = "not manually reviewed"
                row["Taxonomy Reviewed At"] = utc_now()
            else:
                review_indices.append(row_index)
            processed += 1
            run_records.append({"plate": plate, "well": well, "image_code": image_code, **prediction})
            print(
                f"{image_code}: {prediction['order']} "
                f"({float(prediction['order_confidence']):.2%}) "
                f"views={'+'.join(prediction['views_used'])} model={prediction['model']}",
                flush=True,
            )
        except Exception as exc:
            errors += 1
            row["AI Taxonomy Status"] = "error"
            row["AI Taxonomy Error"] = str(exc)
            row["AI Taxonomy Timestamp"] = utc_now()
            run_records.append({
                "plate": plate,
                "well": well,
                "image_code": image_code,
                "status": "error",
                "error": str(exc),
            })
            print(f"ERROR {image_code}: {exc}", flush=True)

    report_dir.mkdir(parents=True, exist_ok=True)
    reviewed = 0
    if args.mode == "train" and review_indices:
        reviewed = review_predictions(
            plate=plate,
            image_dir=image_dir,
            report_dir=report_dir,
            rows=rows,
            row_indices=review_indices,
            order_names=load_order_names(classifier, rows),
        )

    atomic_write_csv(csv_path, fieldnames, rows)
    xlsx_path = csv_path.with_suffix(".xlsx")
    xlsx_error = ""
    try:
        xlsx_result = synchronize_workbook(csv_path, DEFAULT_TEMPLATE, xlsx_path)
        print(
            f"Updated formatted plate workbook: {xlsx_result['xlsx']} "
            f"({xlsx_result['rows']} rows)",
            flush=True,
        )
    except Exception as exc:
        xlsx_error = str(exc)
        print(f"ERROR updating formatted plate workbook: {exc}", flush=True)
    summary = {
        "plate": plate,
        "csv_path": str(csv_path),
        "image_dir": str(image_dir),
        "report_dir": str(report_dir),
        "mode": args.mode,
        "mock": bool(args.mock),
        "processed": processed,
        "skipped": skipped,
        "errors": errors,
        "reviewed": reviewed,
        "rows": len(rows),
        "xlsx_path": str(xlsx_path),
        "xlsx_error": xlsx_error,
    }
    write_reports(report_dir, run_records, summary)
    print(json.dumps(summary, sort_keys=True), flush=True)
    return 0 if errors == 0 and not xlsx_error else 1


if __name__ == "__main__":
    raise SystemExit(main())
