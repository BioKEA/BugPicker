#!/usr/bin/env python3
"""02: Segment dark bug silhouettes from a Top-camera scan.

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
import time
from datetime import datetime
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
if SCRIPT_PATH.parent.name == "BugPicker" and SCRIPT_PATH.parent.parent.name == "scripts":
    PROJECT_ROOT = SCRIPT_PATH.parents[2]
else:
    PROJECT_ROOT = SCRIPT_PATH.parents[1]
SCRIPTS_DIR = SCRIPT_PATH.parent
PREFERRED_PYTHON = PROJECT_ROOT / ".venv/bin/python"

try:
    import cv2
    import numpy as np
except ModuleNotFoundError as exc:
    missing = exc.name
    if Path(sys.executable).resolve() != PREFERRED_PYTHON.resolve() and PREFERRED_PYTHON.exists():
        import os

        os.execv(str(PREFERRED_PYTHON), [str(PREFERRED_PYTHON), str(SCRIPT_PATH), *sys.argv[1:]])

    install_command = (
        f"{sys.executable} -m pip install -r {SCRIPTS_DIR / 'requirements.txt'}"
        if (SCRIPTS_DIR / "requirements.txt").exists()
        else f"{sys.executable} -m pip install numpy opencv-python"
    )
    print(
        f"Missing Python package {missing!r} for interpreter:\n"
        f"  {sys.executable}\n"
        f"Install dependencies with:\n"
        f"  {install_command}\n"
        f"Or run with the OpenPnP venv:\n"
        f"  {PREFERRED_PYTHON} {SCRIPT_PATH} <scan_dir>",
        file=sys.stderr,
    )
    raise SystemExit(2) from exc


MIN_AREA_PX = 80
MAX_AREA_FRACTION = 0.03
MAX_RECT_AREA_FRACTION = 0.02
MAX_SHORT_SIDE_FRACTION = 0.12
MAX_LONG_SIDE_FRACTION = 0.18
MIN_RECTANGULARITY = 0.02
MIN_ASPECT_RATIO = 0.20
MAX_ASPECT_RATIO = 5.00
MAX_INSIDE_MEAN_INTENSITY = 165
MIN_BACKGROUND_CONTRAST = 25
FIXED_DARK_THRESHOLD = 70
RESISTOR_MIN_AREA_PX = 180
RESISTOR_MAX_AREA_FRACTION = 0.01
RESISTOR_MAX_RECT_AREA_FRACTION = 0.012
RESISTOR_MAX_SHORT_SIDE_FRACTION = 0.08
RESISTOR_MAX_LONG_SIDE_FRACTION = 0.16
RESISTOR_MIN_RECTANGULARITY = 0.55
RESISTOR_MIN_ASPECT_RATIO = 1.15
RESISTOR_MAX_ASPECT_RATIO = 6.00
RESISTOR_MAX_INSIDE_MEAN_INTENSITY = 115
RESISTOR_MIN_BACKGROUND_CONTRAST = 22
CLOSE_KERNEL_SIZE = 13
OPEN_KERNEL_SIZE = 2
PINK_MIN_SATURATION = 60
PINK_MIN_VALUE = 135
PINK_DILATE_KERNEL_SIZE = 15
PINK_RED_DOMINANCE = 12
PINK_MIN_HUE = 135
BUG_MIN_FILL_RATIO = 0.04
IMAGE_EDGE_REJECT_MARGIN_PX = 40
COLOR_PRESENT_SATURATION_P99 = 20
COLOR_MIN_AREA_PX = 1500
COLOR_MAX_AXIS_ASPECT_RATIO = 3.5
COLOR_MAX_INSIDE_MEAN_INTENSITY = 170
COLOR_MIN_RECTANGULARITY = 0.20
COLOR_MAX_SHORT_SIDE_FRACTION = 0.42
COLOR_MAX_LONG_SIDE_FRACTION = 0.48
COLOR_MIN_BACKGROUND_CONTRAST = -15
COLOR_MIN_USEFUL_CONTRAST = 8
COLOR_MAX_LOW_CONTRAST_MEAN_INTENSITY = 140
BUG_OUTLINE_MIN_AREA_PX = 3000
BUG_OUTLINE_MAX_INSIDE_MEAN_INTENSITY = 170
BUG_OUTLINE_MIN_ABS_CONTRAST = 10
BUG_BRIGHT_MIN_AREA_PX = 1500
BUG_BRIGHT_RESIDUAL_THRESHOLD = 13
BUG_BRIGHT_MIN_ABS_CONTRAST = 12
BUG_BODY_COLOR_MIN_AREA_PX = 1200
BUG_BODY_COLOR_MIN_ABS_CONTRAST = 7
GLOBAL_DEDUPE_DISTANCE_MM = 3.0
CONTEXT_PADDING_PX = 900
COORDINATE_TRANSFORM_VERSION = "image_y_inverted_v2"
GRAYSCALE_MIN_AREA_PX = 1000
GRAYSCALE_MIN_AXIS_ASPECT_RATIO = 1.9
GRAYSCALE_MAX_INSIDE_MEAN_INTENSITY = 55
GRAYSCALE_MIN_RECTANGULARITY = 0.55
EDGE_MIN_AREA_PX = 1200
EDGE_MIN_RECTANGULARITY = 0.42
EDGE_MIN_ASPECT_RATIO = 1.20
EDGE_MAX_ASPECT_RATIO = 5.00
EDGE_MIN_ABS_CONTRAST = 6
EDGE_CANNY_LOW = 18
EDGE_CANNY_HIGH = 55

BOUNDING_BOX_COLOR = (0, 255, 0)
DUPLICATE_BOX_COLOR = (0, 165, 255)
CENTROID_COLOR = (0, 0, 255)
LABEL_COLOR = (255, 255, 255)
LABEL_BACKGROUND_COLOR = (0, 128, 0)
DUPLICATE_LABEL_BACKGROUND_COLOR = (0, 100, 220)
LINE_THICKNESS = 2
CENTROID_MARK_SIZE = 10
CONTROL_DIR = PROJECT_ROOT / "control"
DETECTION_STATUS_FILE = CONTROL_DIR / "detection_status.json"
DETECTION_PREVIEW_FILE = CONTROL_DIR / "latest_detection_overlay.png"
TRAINING_TRAY_CALIBRATION_FILE = SCRIPTS_DIR / "training_tray_calibration.json"
CONTROL_TRAINING_TRAY_CALIBRATION_FILE = CONTROL_DIR / "training_tray_calibration.json"
PREVIEW_MAX_WIDTH = 520
PREVIEW_MAX_HEIGHT = 293

DEFAULT_TRAINING_TRAY_CALIBRATION: dict[str, float] = {
    "x_left_mm": 361.0,
    "x_right_mm": 411.0,
    "y_top_mm": 208.0,
    "y_bottom_mm": 319.0,
    "camera_x_offset_mm": -23.0,
    "camera_y_offset_mm": 64.0,
    "x_step_mm": 8.0,
    "y_step_mm": 5.0,
}


def write_detection_status(scan_dir: Path, status: str, **values: Any) -> None:
    CONTROL_DIR.mkdir(exist_ok=True)
    payload: dict[str, Any] = {
        "status": status,
        "scan_dir": str(scan_dir),
        "updated_at": datetime.now().isoformat(),
    }
    payload.update(values)
    DETECTION_STATUS_FILE.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def write_segmentation_complete(
    scan_dir: Path,
    object_count: int,
    processed_count: int,
    candidate_count: int,
    duplicate_count: int,
    summary_file: str | None,
    detector: str,
    calibration: dict[str, Any],
) -> None:
    complete_path = scan_dir / "segmentation_complete.json"
    payload = {
        "status": "completed",
        "scan_dir": str(scan_dir),
        "object_count": object_count,
        "detector": detector,
        "candidate_count": candidate_count,
        "duplicate_count": duplicate_count,
        "summary_file": summary_file,
        "training_tray_calibration_source": calibration.get("source"),
        "processed_frame_count": processed_count,
        "updated_at": datetime.now().isoformat(),
    }
    complete_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def load_training_tray_calibration(calibration_path: Path | None = None) -> dict[str, Any]:
    calibration: dict[str, Any] = dict(DEFAULT_TRAINING_TRAY_CALIBRATION)
    source = "built-in defaults"
    candidates = []
    if calibration_path is not None:
        candidates.append(calibration_path)
    candidates.extend([TRAINING_TRAY_CALIBRATION_FILE, CONTROL_TRAINING_TRAY_CALIBRATION_FILE])

    for candidate in candidates:
        if not candidate.exists():
            continue
        data = json.loads(candidate.read_text(encoding="utf-8"))
        for key, fallback in DEFAULT_TRAINING_TRAY_CALIBRATION.items():
            value = data.get(key, fallback)
            try:
                calibration[key] = float(value)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Calibration value is not numeric: {key}={value!r}") from exc
        source = str(candidate)
        break

    calibration["source"] = source
    return calibration


def normalize_manifest_frame(frame: dict[str, Any], calibration: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(frame)
    camera_x_offset = float(calibration["camera_x_offset_mm"])
    camera_y_offset = float(calibration["camera_y_offset_mm"])

    if "x_mm" not in normalized and "requested_x_mm" in normalized:
        normalized["x_mm"] = float(normalized["requested_x_mm"]) + camera_x_offset
    if "y_mm" not in normalized and "requested_y_mm" in normalized:
        normalized["y_mm"] = float(normalized["requested_y_mm"]) + camera_y_offset
    if "requested_x_mm" not in normalized and "x_mm" in normalized:
        normalized["requested_x_mm"] = float(normalized["x_mm"]) - camera_x_offset
    if "requested_y_mm" not in normalized and "y_mm" in normalized:
        normalized["requested_y_mm"] = float(normalized["y_mm"]) - camera_y_offset

    normalized["training_tray_calibration_source"] = calibration.get("source")
    normalized["training_tray_x_left_mm"] = calibration["x_left_mm"]
    normalized["training_tray_x_right_mm"] = calibration["x_right_mm"]
    normalized["training_tray_y_top_mm"] = calibration["y_top_mm"]
    normalized["training_tray_y_bottom_mm"] = calibration["y_bottom_mm"]
    normalized["training_camera_x_offset_mm"] = camera_x_offset
    normalized["training_camera_y_offset_mm"] = camera_y_offset
    return normalized


def load_manifest(scan_dir: Path, calibration: dict[str, Any]) -> list[dict[str, Any]]:
    manifest_path = scan_dir / "manifest.jsonl"
    records: list[dict[str, Any]] = []
    if not manifest_path.exists():
        return records
    with manifest_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(normalize_manifest_frame(json.loads(line), calibration))
            except json.JSONDecodeError:
                continue
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


def make_pink_mask(image: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hue = hsv[:, :, 0]
    saturation = hsv[:, :, 1]
    value = hsv[:, :, 2]
    blue = image[:, :, 0].astype(np.int16)
    green = image[:, :, 1].astype(np.int16)
    red = image[:, :, 2].astype(np.int16)

    red_dominant_pink = (
        (saturation >= PINK_MIN_SATURATION)
        & (value >= PINK_MIN_VALUE)
        & (hue >= PINK_MIN_HUE)
        & (red - np.maximum(green, blue) >= PINK_RED_DOMINANCE)
    )
    pink_pixels = red_dominant_pink
    mask = (pink_pixels.astype(np.uint8)) * 255
    mask = cv2.dilate(
        mask,
        cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (PINK_DILATE_KERNEL_SIZE, PINK_DILATE_KERNEL_SIZE),
        ),
        iterations=1,
    )
    return mask


def make_bug_mask(image: np.ndarray, threshold: int) -> tuple[np.ndarray, np.ndarray]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    color_present = float(np.percentile(saturation, 99)) >= COLOR_PRESENT_SATURATION_P99
    if color_present:
        dark_pixels = (blurred < max(threshold, 165)) & (saturation > 25)
        very_dark_pixels = blurred < 100
        dark_mask = ((dark_pixels | very_dark_pixels).astype(np.uint8)) * 255
    else:
        _, dark_mask = cv2.threshold(blurred, threshold, 255, cv2.THRESH_BINARY_INV)
    pink_mask = make_pink_mask(image)
    mask = cv2.bitwise_and(dark_mask, cv2.bitwise_not(pink_mask))
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (OPEN_KERNEL_SIZE, OPEN_KERNEL_SIZE)),
    )
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (CLOSE_KERNEL_SIZE, CLOSE_KERNEL_SIZE)),
    )
    return gray, mask


def make_edge_mask(gray: np.ndarray) -> np.ndarray:
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, EDGE_CANNY_LOW, EDGE_CANNY_HIGH)
    edges = cv2.dilate(
        edges,
        cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9)),
        iterations=1,
    )
    edges = cv2.morphologyEx(
        edges,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (21, 21)),
    )
    edges = cv2.morphologyEx(
        edges,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)),
    )
    return edges


def make_bright_object_mask(gray: np.ndarray) -> np.ndarray:
    local_background = cv2.GaussianBlur(gray, (0, 0), 45)
    bright_residual = cv2.subtract(gray, local_background)
    mask = ((bright_residual > BUG_BRIGHT_RESIDUAL_THRESHOLD) & (gray < 245)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
    )
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (31, 31)),
    )
    return mask


def make_body_color_mask(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hue = hsv[:, :, 0]
    saturation = hsv[:, :, 1]
    value = hsv[:, :, 2]
    local_background = cv2.GaussianBlur(gray, (0, 0), 45)
    darker_than_background = gray < (local_background - 10)
    warm_body = ((hue < 35) | (hue > 145)) & (saturation > 15) & (value < 230)
    colored_body = (saturation > 22) & (value < 220) & (gray < 205)
    mask = ((warm_body | colored_body | darker_than_background) & (gray < 230)).astype(np.uint8) * 255
    mask = cv2.bitwise_and(mask, cv2.bitwise_not(make_pink_mask(image)))
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
    )
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (19, 19)),
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


def axis_iou(first: dict[str, Any], second: dict[str, Any]) -> float:
    ax0 = first["axis_bbox_x_px"]
    ay0 = first["axis_bbox_y_px"]
    ax1 = ax0 + first["axis_bbox_width_px"]
    ay1 = ay0 + first["axis_bbox_height_px"]
    bx0 = second["axis_bbox_x_px"]
    by0 = second["axis_bbox_y_px"]
    bx1 = bx0 + second["axis_bbox_width_px"]
    by1 = by0 + second["axis_bbox_height_px"]

    ix0 = max(ax0, bx0)
    iy0 = max(ay0, by0)
    ix1 = min(ax1, bx1)
    iy1 = min(ay1, by1)
    intersection = max(0, ix1 - ix0) * max(0, iy1 - iy0)
    if intersection == 0:
        return 0.0

    first_area = max(0, ax1 - ax0) * max(0, ay1 - ay0)
    second_area = max(0, bx1 - bx0) * max(0, by1 - by0)
    union = first_area + second_area - intersection
    return intersection / union if union else 0.0


def same_detection(first: dict[str, Any], second: dict[str, Any]) -> bool:
    dx = first["centroid_x_px"] - second["centroid_x_px"]
    dy = first["centroid_y_px"] - second["centroid_y_px"]
    center_distance = (dx * dx + dy * dy) ** 0.5
    return center_distance < 90 or axis_iou(first, second) > 0.20


def deduplicate_detections(detections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    for detection in sorted(detections, key=lambda item: item["score"], reverse=True):
        if not any(same_detection(detection, existing) for existing in kept):
            kept.append(detection)
    kept.sort(key=lambda item: (item["centroid_y_px"], item["centroid_x_px"]))
    return kept


def reject_image_edge_detections(
    detections: list[dict[str, Any]],
    image_shape: tuple[int, int],
    margin_px: int = IMAGE_EDGE_REJECT_MARGIN_PX,
) -> list[dict[str, Any]]:
    image_height, image_width = image_shape[:2]
    kept = []
    for detection in detections:
        x = detection["axis_bbox_x_px"]
        y = detection["axis_bbox_y_px"]
        w = detection["axis_bbox_width_px"]
        h = detection["axis_bbox_height_px"]
        if x <= margin_px or y <= margin_px:
            continue
        if x + w >= image_width - margin_px or y + h >= image_height - margin_px:
            continue
        kept.append(detection)
    return kept


def detect_rectangles_from_mask(
    gray: np.ndarray,
    mask: np.ndarray,
    *,
    method: str,
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
    min_abs_contrast: float = 0,
    require_dark: bool = True,
) -> list[dict[str, Any]]:
    image_area = gray.shape[0] * gray.shape[1]
    reference_side = min(gray.shape[0], gray.shape[1])
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
        abs_contrast = abs(contrast)
        if require_dark and mean_intensity > max_inside_mean_intensity:
            continue
        if require_dark and contrast < min_background_contrast:
            continue
        if abs_contrast < min_abs_contrast:
            continue

        box = cv2.boxPoints(rect)
        box = np.intp(box)
        x, y, w, h = cv2.boundingRect(box)
        score = max(contrast, abs_contrast) * rectangularity * min(aspect_ratio, 3.0)

        detections.append(
            {
                "detection_method": method,
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
                "absolute_background_contrast": abs_contrast,
                "angle_degrees": float(angle),
                "score": float(score),
            }
        )

    detections.sort(key=lambda item: (item["centroid_y_px"], item["centroid_x_px"]))
    return detections


def detect_rectangles(
    gray: np.ndarray,
    dark_mask: np.ndarray,
    edge_mask: np.ndarray,
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
) -> list[dict[str, Any]]:
    dark_detections = detect_rectangles_from_mask(
        gray,
        dark_mask,
        method="dark_mask",
        min_area_px=min_area_px,
        max_area_fraction=max_area_fraction,
        max_rect_area_fraction=max_rect_area_fraction,
        max_short_side_fraction=max_short_side_fraction,
        max_long_side_fraction=max_long_side_fraction,
        min_rectangularity=min_rectangularity,
        min_aspect_ratio=min_aspect_ratio,
        max_aspect_ratio=max_aspect_ratio,
        max_inside_mean_intensity=max_inside_mean_intensity,
        min_background_contrast=min_background_contrast,
    )
    edge_detections = detect_rectangles_from_mask(
        gray,
        edge_mask,
        method="edge_mask",
        min_area_px=EDGE_MIN_AREA_PX,
        max_area_fraction=0.08,
        max_rect_area_fraction=0.10,
        max_short_side_fraction=0.30,
        max_long_side_fraction=0.50,
        min_rectangularity=EDGE_MIN_RECTANGULARITY,
        min_aspect_ratio=EDGE_MIN_ASPECT_RATIO,
        max_aspect_ratio=EDGE_MAX_ASPECT_RATIO,
        max_inside_mean_intensity=255,
        min_background_contrast=0,
        min_abs_contrast=EDGE_MIN_ABS_CONTRAST,
        require_dark=False,
    )
    return deduplicate_detections(dark_detections + edge_detections)


def detect_bugs(
    image: np.ndarray,
    gray: np.ndarray,
    mask: np.ndarray,
    *,
    min_area_px: int,
    max_area_fraction: float,
    max_short_side_fraction: float,
    max_long_side_fraction: float,
    min_rectangularity: float,
    min_aspect_ratio: float,
    max_aspect_ratio: float,
    max_inside_mean_intensity: float,
    min_background_contrast: float,
) -> list[dict[str, Any]]:
    image_area = gray.shape[0] * gray.shape[1]
    reference_side = min(gray.shape[0], gray.shape[1])
    saturation_p99 = float(np.percentile(cv2.cvtColor(image, cv2.COLOR_BGR2HSV)[:, :, 1], 99))
    color_present = saturation_p99 >= COLOR_PRESENT_SATURATION_P99
    effective_min_area_px = max(min_area_px, COLOR_MIN_AREA_PX) if color_present else max(
        min_area_px,
        GRAYSCALE_MIN_AREA_PX,
    )
    effective_min_aspect_ratio = min_aspect_ratio if color_present else max(
        min_aspect_ratio,
        GRAYSCALE_MIN_AXIS_ASPECT_RATIO,
    )
    effective_max_aspect_ratio = (
        min(max_aspect_ratio, COLOR_MAX_AXIS_ASPECT_RATIO)
        if color_present
        else max_aspect_ratio
    )
    effective_min_rectangularity = max(
        min_rectangularity,
        COLOR_MIN_RECTANGULARITY if color_present else GRAYSCALE_MIN_RECTANGULARITY,
    )
    effective_max_inside_mean = (
        min(max_inside_mean_intensity, COLOR_MAX_INSIDE_MEAN_INTENSITY)
        if color_present
        else min(max_inside_mean_intensity, GRAYSCALE_MAX_INSIDE_MEAN_INTENSITY)
    )
    effective_min_background_contrast = (
        min(min_background_contrast, COLOR_MIN_BACKGROUND_CONTRAST)
        if color_present
        else min_background_contrast
    )
    effective_max_short_side_fraction = (
        max(max_short_side_fraction, COLOR_MAX_SHORT_SIDE_FRACTION)
        if color_present
        else max_short_side_fraction
    )
    effective_max_long_side_fraction = (
        max(max_long_side_fraction, COLOR_MAX_LONG_SIDE_FRACTION)
        if color_present
        else max_long_side_fraction
    )
    max_area = image_area * max_area_fraction
    max_short_side = reference_side * effective_max_short_side_fraction
    max_long_side = reference_side * effective_max_long_side_fraction

    detections: list[dict[str, Any]] = []
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < effective_min_area_px or area > max_area:
            continue

        x, y, w, h = cv2.boundingRect(contour)
        if (
            x <= IMAGE_EDGE_REJECT_MARGIN_PX
            or y <= IMAGE_EDGE_REJECT_MARGIN_PX
            or x + w >= gray.shape[1] - IMAGE_EDGE_REJECT_MARGIN_PX
            or y + h >= gray.shape[0] - IMAGE_EDGE_REJECT_MARGIN_PX
        ):
            continue

        short_side = float(min(w, h))
        long_side = float(max(w, h))
        if short_side <= 0:
            continue
        axis_aspect_ratio = long_side / short_side
        if axis_aspect_ratio < effective_min_aspect_ratio or axis_aspect_ratio > effective_max_aspect_ratio:
            continue
        if short_side > max_short_side or long_side > max_long_side:
            continue

        bbox_area = float(w * h)
        fill_ratio = area / bbox_area if bbox_area else 0.0
        if fill_ratio < BUG_MIN_FILL_RATIO:
            continue

        moments = cv2.moments(contour)
        if abs(moments["m00"]) < 0.000001:
            continue
        center_x = moments["m10"] / moments["m00"]
        center_y = moments["m01"] / moments["m00"]

        mean_intensity, background_mean, contrast = contour_contrast(gray, contour)
        if mean_intensity > effective_max_inside_mean:
            continue
        if contrast < effective_min_background_contrast:
            continue
        if (
            color_present
            and contrast < COLOR_MIN_USEFUL_CONTRAST
            and mean_intensity > COLOR_MAX_LOW_CONTRAST_MEAN_INTENSITY
        ):
            continue

        rect = cv2.minAreaRect(contour)
        (_, _), (rect_width, rect_height), angle = rect
        rect_area = float(rect_width * rect_height)
        if rect_area <= 0:
            continue
        rect_short_side = float(min(rect_width, rect_height))
        rect_long_side = float(max(rect_width, rect_height))
        aspect_ratio = rect_long_side / rect_short_side if rect_short_side else 0.0
        rectangularity = area / rect_area
        if rectangularity < effective_min_rectangularity:
            continue
        box = cv2.boxPoints(rect)
        box = np.intp(box)
        score = contrast * area * min(fill_ratio * 4.0, 1.0)

        detections.append(
            {
                "detection_method": "bug_dark_color_mask",
                "centroid_x_px": float(center_x),
                "centroid_y_px": float(center_y),
                "axis_bbox_x_px": int(x),
                "axis_bbox_y_px": int(y),
                "axis_bbox_width_px": int(w),
                "axis_bbox_height_px": int(h),
                "rotated_box_px": box.astype(float).tolist(),
                "area_px": area,
                "rect_area_px": rect_area,
                "rect_width_px": float(rect_width),
                "rect_height_px": float(rect_height),
                "rect_short_side_px": rect_short_side,
                "rect_long_side_px": rect_long_side,
                "rectangularity": float(rectangularity),
                "aspect_ratio": float(aspect_ratio),
                "mean_intensity": mean_intensity,
                "background_mean_intensity": background_mean,
                "background_contrast": contrast,
                "absolute_background_contrast": abs(contrast),
                "angle_degrees": float(angle),
                "score": float(score),
            }
        )

    outline_detections = detect_rectangles_from_mask(
        gray,
        make_edge_mask(gray),
        method="bug_outline_mask",
        min_area_px=BUG_OUTLINE_MIN_AREA_PX,
        max_area_fraction=max_area_fraction,
        max_rect_area_fraction=max_area_fraction,
        max_short_side_fraction=effective_max_short_side_fraction,
        max_long_side_fraction=effective_max_long_side_fraction,
        min_rectangularity=max(0.40, min_rectangularity),
        min_aspect_ratio=1.15,
        max_aspect_ratio=min(max_aspect_ratio, 5.0),
        max_inside_mean_intensity=BUG_OUTLINE_MAX_INSIDE_MEAN_INTENSITY,
        min_background_contrast=0,
        min_abs_contrast=BUG_OUTLINE_MIN_ABS_CONTRAST,
        require_dark=True,
    )
    outline_detections = reject_image_edge_detections(outline_detections, gray.shape)

    bright_detections = detect_rectangles_from_mask(
        gray,
        make_bright_object_mask(gray),
        method="bug_bright_mask",
        min_area_px=BUG_BRIGHT_MIN_AREA_PX,
        max_area_fraction=max_area_fraction,
        max_rect_area_fraction=max_area_fraction,
        max_short_side_fraction=effective_max_short_side_fraction,
        max_long_side_fraction=effective_max_long_side_fraction,
        min_rectangularity=max(0.35, min_rectangularity),
        min_aspect_ratio=1.15,
        max_aspect_ratio=max(max_aspect_ratio, 6.0),
        max_inside_mean_intensity=255,
        min_background_contrast=0,
        min_abs_contrast=BUG_BRIGHT_MIN_ABS_CONTRAST,
        require_dark=False,
    )
    bright_detections = reject_image_edge_detections(bright_detections, gray.shape)

    body_color_detections = detect_rectangles_from_mask(
        gray,
        make_body_color_mask(image),
        method="bug_body_color_mask",
        min_area_px=BUG_BODY_COLOR_MIN_AREA_PX,
        max_area_fraction=max(max_area_fraction, 0.055),
        max_rect_area_fraction=max(max_area_fraction, 0.080),
        max_short_side_fraction=max(effective_max_short_side_fraction, 0.50),
        max_long_side_fraction=max(effective_max_long_side_fraction, 0.65),
        min_rectangularity=0.10,
        min_aspect_ratio=0.65,
        max_aspect_ratio=max(max_aspect_ratio, 6.0),
        max_inside_mean_intensity=220,
        min_background_contrast=-25,
        min_abs_contrast=BUG_BODY_COLOR_MIN_ABS_CONTRAST,
        require_dark=False,
    )
    body_color_detections = reject_image_edge_detections(body_color_detections, gray.shape)

    return deduplicate_detections(detections + outline_detections + bright_detections + body_color_detections)


def image_point_to_machine_coordinates(
    frame: dict[str, Any],
    centroid_x_px: float,
    centroid_y_px: float,
    frame_center_x: float,
    frame_center_y: float,
) -> tuple[float, float]:
    image_width = frame["image_width_px"]
    image_height = frame["image_height_px"]
    upp_x = frame["units_per_pixel_x_mm"]
    upp_y = frame["units_per_pixel_y_mm"]

    dx_mm = (centroid_x_px - (image_width / 2.0)) * upp_x
    dy_mm = (centroid_y_px - (image_height / 2.0)) * upp_y
    return frame_center_x + dx_mm, frame_center_y - dy_mm


def object_machine_coordinates(frame: dict[str, Any], centroid_x_px: float, centroid_y_px: float) -> tuple[float, float]:
    return image_point_to_machine_coordinates(
        frame,
        centroid_x_px,
        centroid_y_px,
        frame["x_mm"],
        frame["y_mm"],
    )


def body_biased_pick_point(image: np.ndarray, detection: dict[str, Any]) -> tuple[float, float]:
    """Choose a pick point near the insect body, not the wing-heavy silhouette center."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1].astype(np.float32)
    value = hsv[:, :, 2]

    polygon = np.array(detection["rotated_box_px"], dtype=np.int32)
    detection_mask = np.zeros(gray.shape, dtype=np.uint8)
    cv2.fillPoly(detection_mask, [polygon], 255)

    body_pixels = (
        (detection_mask > 0)
        & (
            (gray < 150)
            | ((saturation > 45) & (value < 230))
        )
        & ~((gray > 175) & (saturation < 35))
    )
    if int(np.count_nonzero(body_pixels)) < 20:
        return float(detection["centroid_x_px"]), float(detection["centroid_y_px"])

    weights = (
        np.maximum(0, 190 - gray.astype(np.float32))
        + (saturation * 0.8)
    )
    weights = np.where(body_pixels, weights, 0.0)
    total_weight = float(weights.sum())
    if total_weight <= 0:
        return float(detection["centroid_x_px"]), float(detection["centroid_y_px"])

    core_pixels = (
        (detection_mask > 0)
        & (
            (gray < 135)
            | ((saturation > 60) & (value < 215))
        )
        & ~((gray > 165) & (saturation < 45))
    )
    core_mask = core_pixels.astype(np.uint8)
    core_mask = cv2.morphologyEx(
        core_mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
    )
    body_mask = core_mask if int(np.count_nonzero(core_mask)) >= 20 else body_pixels.astype(np.uint8)
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(body_mask, 8)
    best_label = 0
    best_score = 0.0
    detection_x = float(detection["centroid_x_px"])
    detection_y = float(detection["centroid_y_px"])
    for label in range(1, component_count):
        area = float(stats[label, cv2.CC_STAT_AREA])
        if area < 20.0:
            continue
        component_pixels = labels == label
        component_weight = float(weights[component_pixels].sum())
        if component_weight <= 0:
            continue
        yy_component, xx_component = np.nonzero(component_pixels)
        component_x = float((xx_component * weights[component_pixels]).sum() / component_weight)
        component_y = float((yy_component * weights[component_pixels]).sum() / component_weight)
        distance_px = ((component_x - detection_x) ** 2 + (component_y - detection_y) ** 2) ** 0.5
        score = component_weight / (1.0 + max(0.0, distance_px - 180.0) * 0.01)
        if score > best_score:
            best_score = score
            best_label = label

    if best_label:
        component_mask = (labels == best_label).astype(np.uint8)
        distance_to_edge = cv2.distanceTransform(component_mask, cv2.DIST_L2, 5)
        body_strength = distance_to_edge * 8.0 + (weights * component_mask)
        _, _, _, max_location = cv2.minMaxLoc(body_strength.astype(np.float32))
        pick_x = float(max_location[0])
        pick_y = float(max_location[1])
        return pick_x, pick_y

    yy, xx = np.indices(gray.shape)
    pick_x = float((xx * weights).sum() / total_weight)
    pick_y = float((yy * weights).sum() / total_weight)
    return pick_x, pick_y


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


def detection_quality(record: dict[str, Any]) -> float:
    edge_penalty = 0.0
    image_width = float(record.get("image_width_px") or 0)
    image_height = float(record.get("image_height_px") or 0)
    bbox_x = float(record.get("bbox_x_px") or 0)
    bbox_y = float(record.get("bbox_y_px") or 0)
    bbox_width = float(record.get("bbox_width_px") or 0)
    bbox_height = float(record.get("bbox_height_px") or 0)
    if image_width > 0 and image_height > 0 and bbox_width > 0 and bbox_height > 0:
        edge_clearance = min(
            bbox_x,
            bbox_y,
            image_width - (bbox_x + bbox_width),
            image_height - (bbox_y + bbox_height),
        )
        edge_penalty = max(0.0, 120.0 - edge_clearance) * 20000.0
    return float(record.get("score") or 0.0) + (float(record.get("bbox_area_px") or 0.0) * 80.0) - edge_penalty


def assign_duplicate_metadata(records: list[dict[str, Any]], minimum_distance_mm: float) -> list[dict[str, Any]]:
    unique: list[dict[str, Any]] = []
    duplicate_pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for candidate_index, record in enumerate(records):
        record["candidate_index"] = candidate_index
        record["is_duplicate"] = False
        record["duplicate_of_object_index"] = None
        record["duplicate_distance_mm"] = None

    for record in sorted(records, key=detection_quality, reverse=True):
        duplicate_of: dict[str, Any] | None = None
        duplicate_distance: float | None = None
        for kept in unique:
            dx = float(record["pick_x_mm"]) - float(kept["pick_x_mm"])
            dy = float(record["pick_y_mm"]) - float(kept["pick_y_mm"])
            distance = (dx * dx + dy * dy) ** 0.5
            if distance < minimum_distance_mm:
                duplicate_of = kept
                duplicate_distance = distance
                break
        if duplicate_of is None:
            unique.append(record)
        else:
            record["is_duplicate"] = True
            record["duplicate_distance_mm"] = duplicate_distance
            duplicate_pairs.append((record, duplicate_of))

    unique.sort(key=lambda item: (int(item["frame_index"]), int(item["object_index"])))
    for object_index, record in enumerate(unique):
        record["object_index"] = object_index
        record["is_duplicate"] = False
        record["duplicate_of_object_index"] = None
        record["duplicate_distance_mm"] = None

    for duplicate, kept in duplicate_pairs:
        duplicate["duplicate_of_object_index"] = kept["object_index"]
    return unique


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


def mark_label(
    image: np.ndarray,
    label: str,
    box: np.ndarray,
    background_color: tuple[int, int, int] = LABEL_BACKGROUND_COLOR,
) -> None:
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
    cv2.rectangle(image, top_left, bottom_right, background_color, -1)
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


def draw_record(overlay: np.ndarray, record: dict[str, Any]) -> None:
    box = np.array(json.loads(record["rotated_box_px_json"]), dtype=np.int32)
    if bool(record.get("is_duplicate")):
        cv2.drawContours(overlay, [box], 0, DUPLICATE_BOX_COLOR, LINE_THICKNESS)
        mark_label(overlay, "Duplicate", box, DUPLICATE_LABEL_BACKGROUND_COLOR)
    else:
        cv2.drawContours(overlay, [box], 0, BOUNDING_BOX_COLOR, LINE_THICKNESS)
        mark_label(overlay, "Target " + str(int(record["object_index"]) + 1), box)
    mark_centroid(overlay, float(record["centroid_x_px"]), float(record["centroid_y_px"]))


def draw_record_on_context(context: np.ndarray, record: dict[str, Any], context_padding: int) -> None:
    bbox_x = int(record["bbox_x_px"])
    bbox_y = int(record["bbox_y_px"])
    bbox_width = int(record["bbox_width_px"])
    bbox_height = int(record["bbox_height_px"])
    source_width = int(record["image_width_px"])
    source_height = int(record["image_height_px"])
    x0 = max(0, bbox_x - context_padding)
    y0 = max(0, bbox_y - context_padding)
    x1 = min(source_width, bbox_x + bbox_width + context_padding)
    y1 = min(source_height, bbox_y + bbox_height + context_padding)

    actual_width = max(1, x1 - x0)
    actual_height = max(1, y1 - y0)
    scale_x = context.shape[1] / actual_width
    scale_y = context.shape[0] / actual_height

    original_box = np.array(json.loads(record["rotated_box_px_json"]), dtype=np.float32)
    box = original_box.copy()
    box[:, 0] = (box[:, 0] - x0) * scale_x
    box[:, 1] = (box[:, 1] - y0) * scale_y
    box = np.intp(box)

    centroid_x = (float(record["centroid_x_px"]) - x0) * scale_x
    centroid_y = (float(record["centroid_y_px"]) - y0) * scale_y

    if bool(record.get("is_duplicate")):
        cv2.drawContours(context, [box], 0, DUPLICATE_BOX_COLOR, LINE_THICKNESS)
        mark_label(context, "Duplicate", box, DUPLICATE_LABEL_BACKGROUND_COLOR)
    else:
        cv2.drawContours(context, [box], 0, BOUNDING_BOX_COLOR, LINE_THICKNESS)
        mark_label(context, "Target " + str(int(record["object_index"]) + 1), box)
    mark_centroid(context, centroid_x, centroid_y)


def write_detection_preview(
    scan_dir: Path,
    frame: dict[str, Any],
    overlay: np.ndarray,
    overlay_path: Path,
    frame_records: list[dict[str, Any]],
    all_records: list[dict[str, Any]],
) -> None:
    CONTROL_DIR.mkdir(exist_ok=True)

    height, width = overlay.shape[:2]
    scale = min(PREVIEW_MAX_WIDTH / width, PREVIEW_MAX_HEIGHT / height)
    preview = cv2.resize(
        overlay,
        (max(1, int(width * scale)), max(1, int(height * scale))),
        interpolation=cv2.INTER_AREA,
    )
    cv2.imwrite(str(DETECTION_PREVIEW_FILE), preview)

    strongest = max(frame_records, key=lambda item: float(item["score"]))
    unique_count = sum(1 for record in all_records if not bool(record.get("is_duplicate")))
    duplicate_count = sum(1 for record in all_records if bool(record.get("is_duplicate")))
    frame_duplicate_count = sum(1 for record in frame_records if bool(record.get("is_duplicate")))
    write_detection_status(
        scan_dir,
        "detected",
        frame_index=frame["frame_index"],
        source_file=frame["file_name"],
        overlay_file=str(overlay_path),
        preview_file=str(DETECTION_PREVIEW_FILE),
        detections_in_frame=len(frame_records),
        duplicates_in_frame=frame_duplicate_count,
        unique_object_count=unique_count,
        duplicate_count=duplicate_count,
        label="Duplicate"
        if bool(strongest.get("is_duplicate"))
        else "Target " + str(int(strongest["object_index"]) + 1),
        duplicate_of_object_index=strongest.get("duplicate_of_object_index"),
        centroid_x_px=strongest["centroid_x_px"],
        centroid_y_px=strongest["centroid_y_px"],
        score=strongest["score"],
    )


def draw_records_for_frame(scan_dir: Path, frame_records: list[dict[str, Any]]) -> np.ndarray | None:
    if not frame_records:
        return None

    source_path = scan_dir / str(frame_records[0]["source_file"])
    image = cv2.imread(str(source_path))
    if image is None:
        return None

    for record in sorted(frame_records, key=lambda item: bool(item.get("is_duplicate"))):
        draw_record(image, record)
    return image


def object_record(
    object_index: int,
    frame: dict[str, Any],
    image: np.ndarray,
    detection: dict[str, Any],
    crop_file: str,
    context_file: str,
    overlay_file: str,
) -> dict[str, Any]:
    pick_centroid_x, pick_centroid_y = body_biased_pick_point(image, detection)
    machine_x, machine_y = object_machine_coordinates(
        frame,
        pick_centroid_x,
        pick_centroid_y,
    )
    requested_machine_x, requested_machine_y = image_point_to_machine_coordinates(
        frame,
        pick_centroid_x,
        pick_centroid_y,
        frame.get("requested_x_mm", frame["x_mm"]),
        frame.get("requested_y_mm", frame["y_mm"]),
    )

    return {
        "object_index": object_index,
        "candidate_index": object_index,
        "frame_index": frame["frame_index"],
        "camera": frame.get("camera", "Top"),
        "detector": detection.get("detector", ""),
        "coordinate_transform_version": COORDINATE_TRANSFORM_VERSION,
        "source_file": frame["file_name"],
        "crop_file": crop_file,
        "context_file": context_file,
        "overlay_file": overlay_file,
        "frame_x_mm": frame["x_mm"],
        "frame_y_mm": frame["y_mm"],
        "frame_requested_x_mm": frame.get("requested_x_mm"),
        "frame_requested_y_mm": frame.get("requested_y_mm"),
        "training_tray_calibration_source": frame.get("training_tray_calibration_source"),
        "training_tray_x_left_mm": frame.get("training_tray_x_left_mm"),
        "training_tray_x_right_mm": frame.get("training_tray_x_right_mm"),
        "training_tray_y_top_mm": frame.get("training_tray_y_top_mm"),
        "training_tray_y_bottom_mm": frame.get("training_tray_y_bottom_mm"),
        "training_camera_x_offset_mm": frame.get("training_camera_x_offset_mm"),
        "training_camera_y_offset_mm": frame.get("training_camera_y_offset_mm"),
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
        "detection_method": detection["detection_method"],
        "rect_width_px": detection["rect_width_px"],
        "rect_height_px": detection["rect_height_px"],
        "rect_short_side_px": detection["rect_short_side_px"],
        "rect_long_side_px": detection["rect_long_side_px"],
        "rect_area_px": detection["rect_area_px"],
        "centroid_x_px": detection["centroid_x_px"],
        "centroid_y_px": detection["centroid_y_px"],
        "pick_centroid_x_px": pick_centroid_x,
        "pick_centroid_y_px": pick_centroid_y,
        "estimated_x_mm": machine_x,
        "estimated_y_mm": machine_y,
        "pick_x_mm": machine_x,
        "pick_y_mm": machine_y,
        "requested_frame_estimated_x_mm": requested_machine_x,
        "requested_frame_estimated_y_mm": requested_machine_y,
        "requested_to_recorded_delta_x_mm": requested_machine_x - machine_x,
        "requested_to_recorded_delta_y_mm": requested_machine_y - machine_y,
        "rectangularity": detection["rectangularity"],
        "aspect_ratio": detection["aspect_ratio"],
        "mean_intensity": detection["mean_intensity"],
        "background_mean_intensity": detection["background_mean_intensity"],
        "background_contrast": detection["background_contrast"],
        "absolute_background_contrast": detection["absolute_background_contrast"],
        "angle_degrees": detection["angle_degrees"],
        "score": detection["score"],
    }


def csv_fields() -> list[str]:
    return [
        "object_index",
        "candidate_index",
        "is_duplicate",
        "duplicate_of_object_index",
        "duplicate_distance_mm",
        "frame_index",
        "camera",
        "detector",
        "coordinate_transform_version",
        "source_file",
        "crop_file",
        "context_file",
        "overlay_file",
        "frame_x_mm",
        "frame_y_mm",
        "frame_requested_x_mm",
        "frame_requested_y_mm",
        "training_tray_calibration_source",
        "training_tray_x_left_mm",
        "training_tray_x_right_mm",
        "training_tray_y_top_mm",
        "training_tray_y_bottom_mm",
        "training_camera_x_offset_mm",
        "training_camera_y_offset_mm",
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
        "detection_method",
        "rect_width_px",
        "rect_height_px",
        "rect_short_side_px",
        "rect_long_side_px",
        "rect_area_px",
        "centroid_x_px",
        "centroid_y_px",
        "pick_centroid_x_px",
        "pick_centroid_y_px",
        "estimated_x_mm",
        "estimated_y_mm",
        "pick_x_mm",
        "pick_y_mm",
        "requested_frame_estimated_x_mm",
        "requested_frame_estimated_y_mm",
        "requested_to_recorded_delta_x_mm",
        "requested_to_recorded_delta_y_mm",
        "rectangularity",
        "aspect_ratio",
        "mean_intensity",
        "background_mean_intensity",
        "background_contrast",
        "absolute_background_contrast",
        "angle_degrees",
        "score",
    ]


def detect_resistors(
    gray: np.ndarray,
    dark_threshold: int,
) -> list[dict[str, Any]]:
    dark_mask = make_dark_mask(gray, dark_threshold)
    edge_mask = make_edge_mask(gray)
    detections = detect_rectangles(
        gray,
        dark_mask,
        edge_mask,
        min_area_px=RESISTOR_MIN_AREA_PX,
        max_area_fraction=RESISTOR_MAX_AREA_FRACTION,
        max_rect_area_fraction=RESISTOR_MAX_RECT_AREA_FRACTION,
        max_short_side_fraction=RESISTOR_MAX_SHORT_SIDE_FRACTION,
        max_long_side_fraction=RESISTOR_MAX_LONG_SIDE_FRACTION,
        min_rectangularity=RESISTOR_MIN_RECTANGULARITY,
        min_aspect_ratio=RESISTOR_MIN_ASPECT_RATIO,
        max_aspect_ratio=RESISTOR_MAX_ASPECT_RATIO,
        max_inside_mean_intensity=RESISTOR_MAX_INSIDE_MEAN_INTENSITY,
        min_background_contrast=RESISTOR_MIN_BACKGROUND_CONTRAST,
    )
    for detection in detections:
        detection["detection_method"] = "resistor_" + str(detection["detection_method"])
    return detections


def process_frame(
    scan_dir: Path,
    frame: dict[str, Any],
    object_index: int,
    objects_dir: Path,
    overlays_dir: Path,
    objects_file: Any,
    csv_writer: csv.DictWriter,
    all_records: list[dict[str, Any]],
    args: argparse.Namespace,
) -> int:
    image_path = scan_dir / frame["file_name"]
    image = cv2.imread(str(image_path))
    if image is None:
        print(f"Skipping unreadable image: {image_path}", file=sys.stderr)
        return object_index

    if args.detector == "bug":
        gray, mask = make_bug_mask(image, args.dark_threshold)
        detections = detect_bugs(
            image,
            gray,
            mask,
            min_area_px=args.min_area,
            max_area_fraction=args.max_area_fraction,
            max_short_side_fraction=args.max_short_side_fraction,
            max_long_side_fraction=args.max_long_side_fraction,
            min_rectangularity=args.min_rectangularity,
            min_aspect_ratio=args.min_aspect_ratio,
            max_aspect_ratio=args.max_aspect_ratio,
            max_inside_mean_intensity=args.max_inside_mean_intensity,
            min_background_contrast=args.min_background_contrast,
        )
    else:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        detections = detect_resistors(gray, args.dark_threshold)
    for detection in detections:
        detection["detector"] = args.detector
    overlay_name = f"frame_{frame['frame_index']:05d}_overlay.png"
    overlay_file = f"overlays/{overlay_name}"
    overlay_path = overlays_dir / overlay_name
    frame_records: list[dict[str, Any]] = []

    for frame_detection_index, detection in enumerate(detections, start=1):
        crop = crop_detection(image, detection, args.crop_padding)
        context = crop_detection(image, detection, CONTEXT_PADDING_PX)
        object_name = f"object_{object_index:06d}_frame_{frame['frame_index']:05d}.png"
        context_name = f"context_{object_index:06d}_frame_{frame['frame_index']:05d}.png"
        crop_path = objects_dir / object_name
        context_path = objects_dir / context_name
        cv2.imwrite(str(crop_path), crop)
        cv2.imwrite(str(context_path), context)

        record = object_record(
            object_index=object_index,
            frame=frame,
            image=image,
            detection=detection,
            crop_file=f"objects/{object_name}",
            context_file=f"objects/{context_name}",
            overlay_file=overlay_file,
        )
        all_records.append(record)
        frame_records.append(record)
        objects_file.write(json.dumps(record, sort_keys=True) + "\n")
        objects_file.flush()
        csv_writer.writerow(record)

        object_index += 1

    if frame_records:
        assign_duplicate_metadata(all_records, GLOBAL_DEDUPE_DISTANCE_MM)
        overlay = draw_records_for_frame(scan_dir, frame_records)
        if overlay is not None:
            cv2.imwrite(str(overlay_path), overlay)
            write_detection_preview(scan_dir, frame, overlay, overlay_path, frame_records, all_records)
    else:
        cv2.imwrite(str(overlay_path), image)

    return object_index


def write_all_candidates(scan_dir: Path, records: list[dict[str, Any]]) -> None:
    candidates_path = scan_dir / "all_candidates.jsonl"
    with candidates_path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, sort_keys=True) + "\n")


def regenerate_overlay_images(scan_dir: Path, records: list[dict[str, Any]]) -> None:
    records_by_frame: dict[int, list[dict[str, Any]]] = {}
    for record in records:
        records_by_frame.setdefault(int(record["frame_index"]), []).append(record)

    for frame_index, frame_records in records_by_frame.items():
        source_path = scan_dir / str(frame_records[0]["source_file"])
        image = cv2.imread(str(source_path))
        if image is None:
            continue
        for record in sorted(frame_records, key=lambda item: bool(item.get("is_duplicate"))):
            draw_record(image, record)
        overlay_path = scan_dir / str(frame_records[0]["overlay_file"])
        cv2.imwrite(str(overlay_path), image)


def write_summary_image(scan_dir: Path, records: list[dict[str, Any]]) -> str | None:
    if not records:
        return None

    thumb_width = 360
    thumb_height = 260
    sorted_records = sorted(
        records,
        key=lambda item: (
            bool(item.get("is_duplicate")),
            int(item["object_index"]) if not bool(item.get("is_duplicate")) else int(item.get("duplicate_of_object_index") or 999999),
            int(item["frame_index"]),
            int(item["candidate_index"]),
        ),
    )
    cols = min(4, max(1, len(sorted_records)))
    rows = int(np.ceil(len(sorted_records) / cols))
    summary = np.full((rows * thumb_height, cols * thumb_width, 3), 245, np.uint8)

    for index, record in enumerate(sorted_records):
        image_path = scan_dir / str(record.get("context_file") or record.get("crop_file"))
        image = cv2.imread(str(image_path))
        if image is None:
            image = np.full((thumb_height, thumb_width, 3), 255, np.uint8)
        else:
            draw_record_on_context(image, record, CONTEXT_PADDING_PX)
        height, width = image.shape[:2]
        scale = min((thumb_width - 12) / width, (thumb_height - 40) / height)
        resized = cv2.resize(
            image,
            (max(1, int(width * scale)), max(1, int(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
        tile = np.full((thumb_height, thumb_width, 3), 255, np.uint8)
        x0 = (thumb_width - resized.shape[1]) // 2
        y0 = 34 + ((thumb_height - 40 - resized.shape[0]) // 2)
        tile[y0 : y0 + resized.shape[0], x0 : x0 + resized.shape[1]] = resized
        if bool(record.get("is_duplicate")):
            label = "Duplicate of Target " + str(int(record.get("duplicate_of_object_index") or 0) + 1)
            label_background = DUPLICATE_LABEL_BACKGROUND_COLOR
        else:
            label = "Target " + str(int(record["object_index"]) + 1)
            label_background = LABEL_BACKGROUND_COLOR
        cv2.rectangle(tile, (0, 0), (thumb_width, 32), label_background, -1)
        cv2.putText(
            tile,
            label,
            (10, 23),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.75,
            LABEL_COLOR,
            2,
            cv2.LINE_AA,
        )
        row = index // cols
        col = index % cols
        summary[row * thumb_height : (row + 1) * thumb_height, col * thumb_width : (col + 1) * thumb_width] = tile

    summary_file = "detection_summary.png"
    cv2.imwrite(str(scan_dir / summary_file), summary)
    return summary_file


def rewrite_unique_records(scan_dir: Path, records: list[dict[str, Any]]) -> tuple[int, int, str | None]:
    unique_records = assign_duplicate_metadata(records, GLOBAL_DEDUPE_DISTANCE_MM)
    objects_path = scan_dir / "objects.jsonl"
    csv_path = scan_dir / "objects.csv"
    duplicate_count = sum(1 for record in records if bool(record.get("is_duplicate")))
    write_all_candidates(scan_dir, records)
    regenerate_overlay_images(scan_dir, records)
    summary_file = write_summary_image(scan_dir, records)

    with objects_path.open("w", encoding="utf-8") as objects_file, csv_path.open(
        "w", encoding="utf-8", newline=""
    ) as csv_file:
        csv_writer = csv.DictWriter(csv_file, fieldnames=csv_fields())
        csv_writer.writeheader()
        for record in unique_records:
            objects_file.write(json.dumps(record, sort_keys=True) + "\n")
            csv_writer.writerow(record)

    return len(unique_records), duplicate_count, summary_file


def scan_is_done(scan_dir: Path, processed_frames: int) -> bool:
    status_path = CONTROL_DIR / "scan_status.json"
    if not status_path.exists():
        return False

    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False

    if status.get("scan_id") != scan_dir.name:
        return False
    if status.get("status") not in {"scan_complete", "completed", "halted"}:
        return False

    try:
        expected_frames = int(status.get("frame_index", 0))
    except (TypeError, ValueError):
        expected_frames = 0
    return processed_frames >= expected_frames


def run(args: argparse.Namespace) -> None:
    scan_dir = args.scan_dir
    calibration = load_training_tray_calibration(args.training_tray_calibration)

    objects_dir = scan_dir / "objects"
    overlays_dir = scan_dir / "overlays"
    objects_dir.mkdir(exist_ok=True)
    overlays_dir.mkdir(exist_ok=True)

    objects_path = scan_dir / "objects.jsonl"
    csv_path = scan_dir / "objects.csv"
    object_index = 0
    all_records: list[dict[str, Any]] = []
    processed_keys: set[tuple[int, str]] = set()
    write_detection_status(
        scan_dir,
        "processing",
        frame_index=None,
        preview_file=None,
        detector=args.detector,
        training_tray_calibration_source=calibration.get("source"),
        message=f"Segmenting scan images with {args.detector} detector",
    )

    with objects_path.open("w", encoding="utf-8") as objects_file, csv_path.open(
        "w", encoding="utf-8", newline=""
    ) as csv_file:
        csv_writer = csv.DictWriter(csv_file, fieldnames=csv_fields())
        csv_writer.writeheader()

        while True:
            frames = load_manifest(scan_dir, calibration)
            if args.max_frames is not None:
                frames = frames[: args.max_frames]

            for frame in frames:
                key = (int(frame["frame_index"]), str(frame["file_name"]))
                if key in processed_keys:
                    continue

                object_index = process_frame(
                    scan_dir,
                    frame,
                    object_index,
                    objects_dir,
                    overlays_dir,
                    objects_file,
                    csv_writer,
                    all_records,
                    args,
                )
                processed_keys.add(key)

            csv_file.flush()

            if not args.watch:
                break
            if args.max_frames is not None and len(processed_keys) >= args.max_frames:
                break
            if scan_is_done(scan_dir, len(processed_keys)):
                break

            time.sleep(args.poll_interval)

    if object_index == 0:
        write_detection_status(
            scan_dir,
            "none_found",
            frame_index=max((key[0] for key in processed_keys), default=None),
            preview_file=None,
            message=f"No {args.detector} targets detected in this segmentation run",
        )
    unique_object_count = 0
    duplicate_count = 0
    summary_file = None
    if all_records:
        unique_object_count, duplicate_count, summary_file = rewrite_unique_records(scan_dir, all_records)
    write_segmentation_complete(
        scan_dir,
        unique_object_count,
        len(processed_keys),
        object_index,
        duplicate_count,
        summary_file,
        args.detector,
        calibration,
    )

    target_label = "resistor component" if args.detector == "resistor" else "bug silhouette"
    print(
        f"Segmented {unique_object_count} unique {target_label}(s)"
        f" from {object_index} frame candidate(s); marked {duplicate_count} duplicate(s)"
    )
    print(f"Wrote {csv_path}")
    print(f"Wrote {objects_path}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("scan_dir", type=Path)
    parser.add_argument(
        "--detector",
        choices=("resistor", "bug"),
        default="resistor",
        help="Target detector to use. 'resistor' finds small black rectangles; 'bug' restores silhouette detection.",
    )
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
    parser.add_argument(
        "--training-tray-calibration",
        type=Path,
        default=None,
        help=(
            "Optional path to training_tray_calibration.json. Defaults to the BugPicker copy, "
            "then control/training_tray_calibration.json, then built-in defaults."
        ),
    )
    parser.add_argument("--watch", action="store_true", help="Process frames as they are appended to manifest.jsonl")
    parser.add_argument("--poll-interval", type=float, default=0.5)
    args = parser.parse_args()

    run(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
