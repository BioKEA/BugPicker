#!/usr/bin/env python3
"""02: Segment dark rectangular targets from a Top-camera scan.

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
from typing import Any

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


MIN_AREA_PX = 2500
MAX_AREA_FRACTION = 0.08
MAX_RECT_AREA_FRACTION = 0.10
MAX_SHORT_SIDE_FRACTION = 0.28
MAX_LONG_SIDE_FRACTION = 0.45
MIN_RECTANGULARITY = 0.55
MIN_ASPECT_RATIO = 1.35
MAX_ASPECT_RATIO = 6.0
MAX_INSIDE_MEAN_INTENSITY = 95
MIN_BACKGROUND_CONTRAST = 22
FIXED_DARK_THRESHOLD = 75
CLOSE_KERNEL_SIZE = 9
OPEN_KERNEL_SIZE = 5

BOUNDING_BOX_COLOR = (0, 255, 0)
CENTROID_COLOR = (0, 0, 255)
LABEL_COLOR = (255, 255, 255)
LABEL_BACKGROUND_COLOR = (0, 128, 0)
LINE_THICKNESS = 2
CENTROID_MARK_SIZE = 10


def load_manifest(scan_dir: Path) -> list[dict[str, Any]]:
    manifest_path = scan_dir / "manifest.jsonl"
    records: list[dict[str, Any]] = []
    with manifest_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def make_dark_mask(gray: np.ndarray, threshold: int) -> np.ndarray:
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, mask = cv2.threshold(blurred, threshold, 255, cv2.THRESH_BINARY_INV)

    # Fill light writing/reflection gaps inside dark targets, then remove specks.
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (CLOSE_KERNEL_SIZE, CLOSE_KERNEL_SIZE)),
    )
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (OPEN_KERNEL_SIZE, OPEN_KERNEL_SIZE)),
    )
    return mask


def contour_contrast(gray: np.ndarray, contour: np.ndarray) -> tuple[float, float, float]:
    object_mask = np.zeros(gray.shape, dtype=np.uint8)
    cv2.drawContours(object_mask, [contour], -1, 255, -1)

    dilated_mask = cv2.dilate(
        object_mask,
        cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25)),
        iterations=1,
    )
    ring_mask = cv2.subtract(dilated_mask, object_mask)

    inside_mean = float(cv2.mean(gray, mask=object_mask)[0])
    ring_mean = float(cv2.mean(gray, mask=ring_mask)[0])
    return inside_mean, ring_mean, ring_mean - inside_mean


def detect_dark_rectangles(
    image: np.ndarray,
    *,
    min_area_px: int,
    max_area_fraction: float,
    max_rect_area_fraction: float,
    max_short_side_fraction: float,
    max_long_side_fraction: float,
    min_rectangularity: float,
    min_aspect_ratio: float,
    max_aspect_ratio: float,
    max_inside_mean_intensity: float,
    min_background_contrast: float,
    dark_threshold: int,
) -> list[dict[str, Any]]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mask = make_dark_mask(gray, dark_threshold)

    image_area = image.shape[0] * image.shape[1]
    reference_side = min(image.shape[0], image.shape[1])
    max_area = image_area * max_area_fraction
    max_rect_area = image_area * max_rect_area_fraction
    max_short_side = reference_side * max_short_side_fraction
    max_long_side = reference_side * max_long_side_fraction

    detections: list[dict[str, Any]] = []
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < min_area_px or area > max_area:
            continue

        rect = cv2.minAreaRect(contour)
        (center_x, center_y), (width, height), angle = rect
        rect_area = float(width * height)
        if rect_area <= 0:
            continue

        short_side = float(min(width, height))
        long_side = float(max(width, height))
        if short_side <= 0:
            continue
        if rect_area > max_rect_area:
            continue
        if short_side > max_short_side or long_side > max_long_side:
            continue

        aspect_ratio = long_side / short_side
        if aspect_ratio < min_aspect_ratio or aspect_ratio > max_aspect_ratio:
            continue

        rectangularity = area / rect_area
        if rectangularity < min_rectangularity:
            continue

        mean_intensity, background_mean, contrast = contour_contrast(gray, contour)
        if mean_intensity > max_inside_mean_intensity:
            continue
        if contrast < min_background_contrast:
            continue

        box = cv2.boxPoints(rect)
        box = np.intp(box)
        x, y, w, h = cv2.boundingRect(box)
        score = contrast * rectangularity * min(aspect_ratio, 3.0)

        detections.append(
            {
                "centroid_x_px": float(center_x),
                "centroid_y_px": float(center_y),
                "axis_bbox_x_px": int(x),
                "axis_bbox_y_px": int(y),
                "axis_bbox_width_px": int(w),
                "axis_bbox_height_px": int(h),
                "rotated_box_px": box.astype(float).tolist(),
                "area_px": area,
                "rect_area_px": rect_area,
                "rect_width_px": float(width),
                "rect_height_px": float(height),
                "rect_short_side_px": short_side,
                "rect_long_side_px": long_side,
                "rectangularity": float(rectangularity),
                "aspect_ratio": float(aspect_ratio),
                "mean_intensity": mean_intensity,
                "background_mean_intensity": background_mean,
                "background_contrast": contrast,
                "angle_degrees": float(angle),
                "score": float(score),
            }
        )

    detections.sort(key=lambda item: (item["centroid_y_px"], item["centroid_x_px"]))
    return detections


def object_machine_coordinates(frame: dict[str, Any], centroid_x_px: float, centroid_y_px: float) -> tuple[float, float]:
    image_width = frame["image_width_px"]
    image_height = frame["image_height_px"]
    upp_x = frame["units_per_pixel_x_mm"]
    upp_y = frame["units_per_pixel_y_mm"]

    dx_mm = (centroid_x_px - (image_width / 2.0)) * upp_x
    dy_mm = (centroid_y_px - (image_height / 2.0)) * upp_y
    return frame["x_mm"] + dx_mm, frame["y_mm"] + dy_mm


def crop_detection(image: np.ndarray, detection: dict[str, Any], padding: int) -> np.ndarray:
    x = detection["axis_bbox_x_px"]
    y = detection["axis_bbox_y_px"]
    w = detection["axis_bbox_width_px"]
    h = detection["axis_bbox_height_px"]

    x0 = max(0, x - padding)
    y0 = max(0, y - padding)
    x1 = min(image.shape[1], x + w + padding)
    y1 = min(image.shape[0], y + h + padding)
    return image[y0:y1, x0:x1]


def mark_centroid(image: np.ndarray, center_x: float, center_y: float) -> None:
    x = int(round(center_x))
    y = int(round(center_y))
    cv2.line(
        image,
        (x - CENTROID_MARK_SIZE, y - CENTROID_MARK_SIZE),
        (x + CENTROID_MARK_SIZE, y + CENTROID_MARK_SIZE),
        CENTROID_COLOR,
        LINE_THICKNESS,
    )
    cv2.line(
        image,
        (x - CENTROID_MARK_SIZE, y + CENTROID_MARK_SIZE),
        (x + CENTROID_MARK_SIZE, y - CENTROID_MARK_SIZE),
        CENTROID_COLOR,
        LINE_THICKNESS,
    )


def mark_label(image: np.ndarray, label: int, box: np.ndarray) -> None:
    x = int(min(point[0] for point in box))
    y = int(min(point[1] for point in box))
    y = max(0, y - 6)

    text = str(label)
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 0.8
    thickness = 2
    (text_width, text_height), baseline = cv2.getTextSize(text, font, font_scale, thickness)
    top_left = (max(0, x), max(text_height + baseline + 2, y) - text_height - baseline - 2)
    bottom_right = (top_left[0] + text_width + 8, top_left[1] + text_height + baseline + 6)
    cv2.rectangle(image, top_left, bottom_right, LABEL_BACKGROUND_COLOR, -1)
    cv2.putText(
        image,
        text,
        (top_left[0] + 4, bottom_right[1] - baseline - 3),
        font,
        font_scale,
        LABEL_COLOR,
        thickness,
        cv2.LINE_AA,
    )


def draw_detection(overlay: np.ndarray, label: int, detection: dict[str, Any]) -> None:
    box = np.array(detection["rotated_box_px"], dtype=np.int32)
    cv2.drawContours(overlay, [box], 0, BOUNDING_BOX_COLOR, LINE_THICKNESS)
    mark_label(overlay, label, box)
    mark_centroid(overlay, detection["centroid_x_px"], detection["centroid_y_px"])


def object_record(
    object_index: int,
    frame: dict[str, Any],
    detection: dict[str, Any],
    crop_file: str,
    overlay_file: str,
) -> dict[str, Any]:
    machine_x, machine_y = object_machine_coordinates(
        frame,
        detection["centroid_x_px"],
        detection["centroid_y_px"],
    )

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
        "bbox_x_px": detection["axis_bbox_x_px"],
        "bbox_y_px": detection["axis_bbox_y_px"],
        "bbox_width_px": detection["axis_bbox_width_px"],
        "bbox_height_px": detection["axis_bbox_height_px"],
        "bbox_area_px": detection["area_px"],
        "rotated_box_px_json": json.dumps(detection["rotated_box_px"]),
        "rect_width_px": detection["rect_width_px"],
        "rect_height_px": detection["rect_height_px"],
        "rect_short_side_px": detection["rect_short_side_px"],
        "rect_long_side_px": detection["rect_long_side_px"],
        "rect_area_px": detection["rect_area_px"],
        "centroid_x_px": detection["centroid_x_px"],
        "centroid_y_px": detection["centroid_y_px"],
        "estimated_x_mm": machine_x,
        "estimated_y_mm": machine_y,
        "rectangularity": detection["rectangularity"],
        "aspect_ratio": detection["aspect_ratio"],
        "mean_intensity": detection["mean_intensity"],
        "background_mean_intensity": detection["background_mean_intensity"],
        "background_contrast": detection["background_contrast"],
        "angle_degrees": detection["angle_degrees"],
        "score": detection["score"],
    }


def csv_fields() -> list[str]:
    return [
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
        "rotated_box_px_json",
        "rect_width_px",
        "rect_height_px",
        "rect_short_side_px",
        "rect_long_side_px",
        "rect_area_px",
        "centroid_x_px",
        "centroid_y_px",
        "estimated_x_mm",
        "estimated_y_mm",
        "rectangularity",
        "aspect_ratio",
        "mean_intensity",
        "background_mean_intensity",
        "background_contrast",
        "angle_degrees",
        "score",
    ]


def run(args: argparse.Namespace) -> None:
    scan_dir = args.scan_dir
    frames = load_manifest(scan_dir)
    if args.max_frames is not None:
        frames = frames[: args.max_frames]

    objects_dir = scan_dir / "objects"
    overlays_dir = scan_dir / "overlays"
    objects_dir.mkdir(exist_ok=True)
    overlays_dir.mkdir(exist_ok=True)

    objects_path = scan_dir / "objects.jsonl"
    csv_path = scan_dir / "objects.csv"
    object_index = 0

    with objects_path.open("w", encoding="utf-8") as objects_file, csv_path.open(
        "w", encoding="utf-8", newline=""
    ) as csv_file:
        csv_writer = csv.DictWriter(csv_file, fieldnames=csv_fields())
        csv_writer.writeheader()

        for frame in frames:
            image_path = scan_dir / frame["file_name"]
            image = cv2.imread(str(image_path))
            if image is None:
                print(f"Skipping unreadable image: {image_path}", file=sys.stderr)
                continue

            overlay = image.copy()
            detections = detect_dark_rectangles(
                image,
                min_area_px=args.min_area,
                max_area_fraction=args.max_area_fraction,
                max_rect_area_fraction=args.max_rect_area_fraction,
                max_short_side_fraction=args.max_short_side_fraction,
                max_long_side_fraction=args.max_long_side_fraction,
                min_rectangularity=args.min_rectangularity,
                min_aspect_ratio=args.min_aspect_ratio,
                max_aspect_ratio=args.max_aspect_ratio,
                max_inside_mean_intensity=args.max_inside_mean_intensity,
                min_background_contrast=args.min_background_contrast,
                dark_threshold=args.dark_threshold,
            )
            overlay_name = f"frame_{frame['frame_index']:05d}_overlay.png"
            overlay_file = f"overlays/{overlay_name}"

            for frame_detection_index, detection in enumerate(detections, start=1):
                crop = crop_detection(image, detection, args.crop_padding)
                object_name = f"object_{object_index:06d}_frame_{frame['frame_index']:05d}.png"
                crop_path = objects_dir / object_name
                cv2.imwrite(str(crop_path), crop)

                record = object_record(
                    object_index=object_index,
                    frame=frame,
                    detection=detection,
                    crop_file=f"objects/{object_name}",
                    overlay_file=overlay_file,
                )
                objects_file.write(json.dumps(record, sort_keys=True) + "\n")
                csv_writer.writerow(record)

                draw_detection(overlay, frame_detection_index, detection)
                object_index += 1

            cv2.imwrite(str(overlays_dir / overlay_name), overlay)

    print(f"Segmented {object_index} candidate objects")
    print(f"Wrote {csv_path}")
    print(f"Wrote {objects_path}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("scan_dir", type=Path)
    parser.add_argument("--min-area", type=int, default=MIN_AREA_PX)
    parser.add_argument("--max-area-fraction", type=float, default=MAX_AREA_FRACTION)
    parser.add_argument("--max-rect-area-fraction", type=float, default=MAX_RECT_AREA_FRACTION)
    parser.add_argument("--max-short-side-fraction", type=float, default=MAX_SHORT_SIDE_FRACTION)
    parser.add_argument("--max-long-side-fraction", type=float, default=MAX_LONG_SIDE_FRACTION)
    parser.add_argument("--min-rectangularity", type=float, default=MIN_RECTANGULARITY)
    parser.add_argument("--min-aspect-ratio", type=float, default=MIN_ASPECT_RATIO)
    parser.add_argument("--max-aspect-ratio", type=float, default=MAX_ASPECT_RATIO)
    parser.add_argument("--max-inside-mean-intensity", type=float, default=MAX_INSIDE_MEAN_INTENSITY)
    parser.add_argument("--min-background-contrast", type=float, default=MIN_BACKGROUND_CONTRAST)
    parser.add_argument("--dark-threshold", type=int, default=FIXED_DARK_THRESHOLD)
    parser.add_argument("--crop-padding", type=int, default=12)
    parser.add_argument("--max-frames", type=int, default=None)
    args = parser.parse_args()

    run(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
