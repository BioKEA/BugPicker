#!/usr/bin/env python3
"""02: Segment candidate objects from a Top-camera scan.

Usage:
    python3 scripts/02_Segment_Scan_Objects.py scans/scan_YYYYMMDD_HHMMSS

Outputs:
    <scan_dir>/objects/*.png
    <scan_dir>/overlays/*.png
    <scan_dir>/objects.csv
    <scan_dir>/objects.jsonl
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

try:
    import cv2
    import numpy as np
except ModuleNotFoundError as exc:
    missing = exc.name
    print(
        f"Missing Python package '{missing}'. Install dependencies with:\n"
        f"  python3 -m pip install -r requirements.txt",
        file=sys.stderr,
    )
    raise SystemExit(2) from exc


def load_manifest(scan_dir: Path) -> list[dict]:
    manifest_path = scan_dir / "manifest.jsonl"
    records: list[dict] = []
    with manifest_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def segment_image(image: np.ndarray, min_area: int, max_area_ratio: float) -> list[tuple[int, int, int, int, float]]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    background = cv2.medianBlur(gray, 51)
    normalized = cv2.absdiff(gray, background)
    normalized = cv2.normalize(normalized, None, 0, 255, cv2.NORM_MINMAX)

    _, threshold = cv2.threshold(normalized, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    threshold = cv2.morphologyEx(threshold, cv2.MORPH_OPEN, kernel, iterations=1)
    threshold = cv2.morphologyEx(threshold, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(threshold, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    image_area = image.shape[0] * image.shape[1]
    max_area = image_area * max_area_ratio

    boxes: list[tuple[int, int, int, int, float]] = []
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < min_area or area > max_area:
            continue

        x, y, w, h = cv2.boundingRect(contour)
        if w < 4 or h < 4:
            continue

        boxes.append((x, y, w, h, area))

    boxes.sort(key=lambda box: (box[1], box[0]))
    return boxes


def object_machine_coordinates(frame: dict, box: tuple[int, int, int, int, float]) -> tuple[float, float]:
    x, y, w, h, _ = box
    image_width = frame["image_width_px"]
    image_height = frame["image_height_px"]
    upp_x = frame["units_per_pixel_x_mm"]
    upp_y = frame["units_per_pixel_y_mm"]

    object_center_x_px = x + (w / 2.0)
    object_center_y_px = y + (h / 2.0)
    dx_mm = (object_center_x_px - (image_width / 2.0)) * upp_x
    dy_mm = (object_center_y_px - (image_height / 2.0)) * upp_y

    return frame["x_mm"] + dx_mm, frame["y_mm"] + dy_mm


def object_record(
    object_index: int,
    frame: dict,
    box: tuple[int, int, int, int, float],
    crop_file: str,
    overlay_file: str,
) -> dict:
    x, y, w, h, area = box
    centroid_x_px = x + (w / 2.0)
    centroid_y_px = y + (h / 2.0)
    machine_x, machine_y = object_machine_coordinates(frame, box)

    return {
        "object_index": object_index,
        "frame_index": frame["frame_index"],
        "camera": frame.get("camera", "Top"),
        "source_file": frame["file_name"],
        "crop_file": crop_file,
        "overlay_file": overlay_file,
        "frame_x_mm": frame["x_mm"],
        "frame_y_mm": frame["y_mm"],
        "image_width_px": frame["image_width_px"],
        "image_height_px": frame["image_height_px"],
        "units_per_pixel_x_mm": frame["units_per_pixel_x_mm"],
        "units_per_pixel_y_mm": frame["units_per_pixel_y_mm"],
        "bbox_x_px": x,
        "bbox_y_px": y,
        "bbox_width_px": w,
        "bbox_height_px": h,
        "bbox_area_px": area,
        "centroid_x_px": centroid_x_px,
        "centroid_y_px": centroid_y_px,
        "estimated_x_mm": machine_x,
        "estimated_y_mm": machine_y,
    }


def draw_detection_label(overlay: np.ndarray, object_index: int, box: tuple[int, int, int, int, float]) -> None:
    x, y, w, h, _ = box
    centroid_x = int(round(x + (w / 2.0)))
    label = str(object_index)
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 0.55
    thickness = 2
    label_size, baseline = cv2.getTextSize(label, font, font_scale, thickness)
    label_x = max(0, min(overlay.shape[1] - label_size[0] - 4, centroid_x - (label_size[0] // 2)))
    label_y = max(label_size[1] + baseline + 4, y - 8)

    cv2.rectangle(
        overlay,
        (label_x - 3, label_y - label_size[1] - baseline - 3),
        (label_x + label_size[0] + 3, label_y + baseline + 3),
        (0, 128, 0),
        -1,
    )
    cv2.putText(overlay, label, (label_x, label_y), font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)
    cv2.circle(overlay, (centroid_x, int(round(y + (h / 2.0)))), 4, (0, 255, 255), -1)


def run(scan_dir: Path, min_area: int, max_area_ratio: float, crop_padding: int) -> None:
    frames = load_manifest(scan_dir)
    objects_dir = scan_dir / "objects"
    overlays_dir = scan_dir / "overlays"
    objects_dir.mkdir(exist_ok=True)
    overlays_dir.mkdir(exist_ok=True)

    objects_path = scan_dir / "objects.jsonl"
    csv_path = scan_dir / "objects.csv"
    object_index = 0
    csv_fields = [
        "object_index",
        "frame_index",
        "camera",
        "source_file",
        "crop_file",
        "overlay_file",
        "frame_x_mm",
        "frame_y_mm",
        "image_width_px",
        "image_height_px",
        "units_per_pixel_x_mm",
        "units_per_pixel_y_mm",
        "bbox_x_px",
        "bbox_y_px",
        "bbox_width_px",
        "bbox_height_px",
        "bbox_area_px",
        "centroid_x_px",
        "centroid_y_px",
        "estimated_x_mm",
        "estimated_y_mm",
    ]

    with objects_path.open("w", encoding="utf-8") as objects_file, csv_path.open(
        "w", encoding="utf-8", newline=""
    ) as csv_file:
        csv_writer = csv.DictWriter(csv_file, fieldnames=csv_fields)
        csv_writer.writeheader()

        for frame in frames:
            image_path = scan_dir / frame["file_name"]
            image = cv2.imread(str(image_path))
            if image is None:
                print(f"Skipping unreadable image: {image_path}", file=sys.stderr)
                continue

            overlay = image.copy()
            boxes = segment_image(image, min_area=min_area, max_area_ratio=max_area_ratio)
            overlay_name = f"frame_{frame['frame_index']:05d}_overlay.png"
            overlay_file = f"overlays/{overlay_name}"

            for box in boxes:
                x, y, w, h, area = box
                x0 = max(0, x - crop_padding)
                y0 = max(0, y - crop_padding)
                x1 = min(image.shape[1], x + w + crop_padding)
                y1 = min(image.shape[0], y + h + crop_padding)
                crop = image[y0:y1, x0:x1]

                object_name = f"object_{object_index:06d}_frame_{frame['frame_index']:05d}.png"
                crop_path = objects_dir / object_name
                cv2.imwrite(str(crop_path), crop)

                record = object_record(
                    object_index=object_index,
                    frame=frame,
                    box=box,
                    crop_file=f"objects/{object_name}",
                    overlay_file=overlay_file,
                )
                objects_file.write(json.dumps(record, sort_keys=True) + "\n")
                csv_writer.writerow(record)

                cv2.rectangle(overlay, (x, y), (x + w, y + h), (0, 255, 0), 2)
                draw_detection_label(overlay, object_index, box)
                object_index += 1

            cv2.imwrite(str(overlays_dir / overlay_name), overlay)

    print(f"Segmented {object_index} candidate objects")
    print(f"Wrote {csv_path}")
    print(f"Wrote {objects_path}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("scan_dir", type=Path)
    parser.add_argument("--min-area", type=int, default=80)
    parser.add_argument("--max-area-ratio", type=float, default=0.20)
    parser.add_argument("--crop-padding", type=int, default=12)
    args = parser.parse_args()

    run(
        scan_dir=args.scan_dir,
        min_area=args.min_area,
        max_area_ratio=args.max_area_ratio,
        crop_padding=args.crop_padding,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
