#!/usr/bin/env python3
"""Audit a completed BugPicker plate CSV against its review image folder."""

from __future__ import annotations

import argparse
import csv
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


IMAGE_KINDS = ("scan", "hires", "bottom", "well")
RESERVED_WELL = "H12"
FILLABLE_WELL_COUNT = 95


def normalize_plate(value: str) -> str:
    plate = "".join(ch for ch in value.strip().upper() if ch.isalnum() or ch in "_-")
    if not plate:
        raise ValueError("Plate number must not be blank")
    return plate


def well_names() -> list[str]:
    return [f"{row}{column}" for row in "ABCDEFGH" for column in range(1, 13)]


def status_marks_unavailable(status: str) -> bool:
    normalized = "".join(ch for ch in status.strip().lower() if ch.isalnum())
    return normalized in {
        "empty",
        "emptyaftermanualreview",
        "unfilled",
        "failed",
        "failedpick",
        "failedplace",
        "ignore",
        "available",
    }


def attempt_image_path(attempt: dict, kind: str) -> Path | None:
    scan_dir = Path(str(attempt.get("scanDir") or ""))
    if not scan_dir:
        return None
    if kind == "scan":
        names = [attempt.get("sourceScanImage")]
        parents = [scan_dir]
    elif kind == "hires":
        names = [attempt.get("hiResImage")]
        parents = [scan_dir / "hires", scan_dir]
    elif kind == "bottom":
        names = [attempt.get("bottomImage")]
        parents = [scan_dir / "bottom_inspections", scan_dir]
    elif kind == "well":
        names = [attempt.get("wellImage"), attempt.get("topWellImage")]
        parents = [scan_dir / "qa" / "wells", scan_dir / "qa" / "wells_top", scan_dir]
    else:
        return None
    for name in names:
        if not name:
            continue
        for parent in parents:
            candidate = parent / str(name)
            if candidate.exists():
                return candidate
    return None


def load_latest_complete_attempts(attempt_log: Path, plate: str) -> dict[str, dict]:
    latest: dict[str, dict] = {}
    if not attempt_log.exists():
        return latest
    for line in attempt_log.read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            attempt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if normalize_plate(str(attempt.get("plate_number") or plate)) != plate:
            continue
        well = str(attempt.get("well") or "").strip().upper()
        if well not in well_names() or well == RESERVED_WELL:
            continue
        if all(attempt_image_path(attempt, kind) is not None for kind in IMAGE_KINDS):
            latest[well] = attempt
    return latest


def recover_well_from_attempt(plate: str, image_dir: Path, row: dict, attempt: dict) -> dict:
    well = row["Well Number"].strip().upper()
    copied: list[str] = []
    for kind in IMAGE_KINDS:
        source = attempt_image_path(attempt, kind)
        if source is None:
            continue
        destination = image_dir / f"IMG-DNA-{plate}-{well}_{kind}.png"
        shutil.copy2(source, destination)
        copied.append(kind)
    row["Scan ID"] = str(attempt.get("scanId") or "")
    row["Target Number"] = str(attempt.get("targetNumber") or "")
    row["Object Index"] = str(attempt.get("objectIndex") or "")
    row["Source Scan Image"] = str(attempt.get("sourceScanImage") or "")
    row["HiRes Image"] = str(attempt.get("hiResImage") or "")
    row["Bottom Image"] = str(attempt.get("bottomImage") or "")
    row["Well Image"] = str(attempt.get("wellImage") or attempt.get("topWellImage") or "")
    row["Plating Confirmation"] = "manual recovered from plate attempt log"
    return {
        "well": well,
        "scan_id": row["Scan ID"],
        "target_number": row["Target Number"],
        "object_index": row["Object Index"],
        "copied_images": copied,
    }


def audit_plate(openpnp_root: Path, plate_number: str, repair_missing: bool = False) -> dict:
    plate = normalize_plate(plate_number)
    csv_path = openpnp_root / "Plate_spreadsheets" / f"{plate}.csv"
    image_dir = openpnp_root / "Plate_insect_images" / f"P-{plate}"
    audit_dir = openpnp_root / "Plate_audits" / f"P-{plate}"
    if not csv_path.exists():
        raise FileNotFoundError(f"Plate CSV not found: {csv_path}")
    if not image_dir.exists():
        raise FileNotFoundError(f"Plate image folder not found: {image_dir}")

    with csv_path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])

    recovered_wells: list[dict] = []
    if repair_missing:
        latest_attempts = load_latest_complete_attempts(image_dir / "plate_attempts.jsonl", plate)
        for row in rows:
            well = row.get("Well Number", "").strip().upper()
            if not well or well == RESERVED_WELL or status_marks_unavailable(row.get("Notes", "")):
                continue
            missing_kinds = [
                kind
                for kind in IMAGE_KINDS
                if not (image_dir / f"IMG-DNA-{plate}-{well}_{kind}.png").exists()
            ]
            missing_metadata = (
                not row.get("Scan ID")
                or not row.get("Target Number")
                or not row.get("Source Scan Image")
            )
            if (missing_kinds or missing_metadata) and well in latest_attempts:
                recovered_wells.append(
                    recover_well_from_attempt(plate, image_dir, row, latest_attempts[well])
                )
        if recovered_wells:
            with csv_path.open("w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(rows)

    occupied: dict[str, dict] = {}
    duplicate_wells: list[str] = []
    invalid_rows: list[dict] = []
    unavailable_rows: list[int] = []
    blank_well_rows: list[int] = []

    for row_number, row in enumerate(rows, start=2):
        if status_marks_unavailable(row.get("Notes", "")):
            unavailable_rows.append(row_number)
            continue
        well = row.get("Well Number", "").strip().upper()
        if not well:
            blank_well_rows.append(row_number)
            continue
        if well == RESERVED_WELL:
            invalid_rows.append(
                {"row": row_number, "well": well, "reason": "reserved negative-control well"}
            )
            continue
        if well not in well_names():
            invalid_rows.append({"row": row_number, "well": well, "reason": "invalid well"})
            continue
        if well in occupied:
            duplicate_wells.append(well)
        occupied[well] = row

    missing_or_unoccupied_wells: list[str] = []
    missing_images: list[dict] = []
    missing_trace_metadata: list[str] = []

    for well in well_names():
        if well == RESERVED_WELL:
            continue
        row = occupied.get(well)
        if row is None:
            missing_or_unoccupied_wells.append(well)
            continue
        missing_kinds = [
            kind
            for kind in IMAGE_KINDS
            if not (image_dir / f"IMG-DNA-{plate}-{well}_{kind}.png").exists()
        ]
        if missing_kinds:
            missing_images.append({"well": well, "missing": missing_kinds})
        if not row.get("Scan ID") or not row.get("Target Number") or not row.get("Source Scan Image"):
            missing_trace_metadata.append(well)

    passed = (
        len(occupied) >= FILLABLE_WELL_COUNT
        and not duplicate_wells
        and not invalid_rows
        and not blank_well_rows
        and not missing_or_unoccupied_wells
        and not missing_images
        and not missing_trace_metadata
    )

    return {
        "plate_number": plate,
        "audited_at": datetime.now(timezone.utc).isoformat(),
        "fillable_wells_expected": FILLABLE_WELL_COUNT,
        "occupied_wells_found": len(occupied),
        "reserved_negative_control_well": RESERVED_WELL,
        "passed": passed,
        "duplicate_wells": duplicate_wells,
        "invalid_well_rows": invalid_rows,
        "blank_well_rows": blank_well_rows,
        "missing_or_unoccupied_wells": missing_or_unoccupied_wells,
        "unavailable_csv_rows": unavailable_rows,
        "missing_images": missing_images,
        "missing_trace_metadata": missing_trace_metadata,
        "recovered_wells": recovered_wells,
        "csv_path": str(csv_path),
        "image_dir": str(image_dir),
        "audit_dir": str(audit_dir),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plate_number", help="Plate number, for example AA0030")
    parser.add_argument(
        "--openpnp-root",
        default=str(Path.home() / ".openpnp2"),
        help="OpenPnP config root containing Plate_spreadsheets, Plate_insect_images, and Plate_audits",
    )
    parser.add_argument(
        "--write-report",
        action="store_true",
        help="Write plate_audit_latest.json and a timestamped plate_audit_*.json into Plate_audits/P-<plate>",
    )
    parser.add_argument(
        "--repair-missing",
        action="store_true",
        help="Recover missing images and trace metadata from the latest complete attempt for each occupied well",
    )
    args = parser.parse_args()

    report = audit_plate(Path(args.openpnp_root), args.plate_number, repair_missing=args.repair_missing)
    print(json.dumps(report, indent=2))
    if args.write_report:
        audit_dir = Path(report["audit_dir"])
        audit_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        for path in (audit_dir / f"plate_audit_{stamp}.json", audit_dir / "plate_audit_latest.json"):
            path.write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
