#!/usr/bin/env python3
"""Inspect QA images for post-place well contents and stuck nozzle bugs."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np


def central_crop(image: np.ndarray, fraction: float) -> tuple[np.ndarray, tuple[int, int]]:
    height, width = image.shape[:2]
    crop_width = int(width * fraction)
    crop_height = int(height * fraction)
    x0 = max(0, (width - crop_width) // 2)
    y0 = max(0, (height - crop_height) // 2)
    return image[y0 : y0 + crop_height, x0 : x0 + crop_width], (x0, y0)


def make_bug_mask(image: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hue, saturation, value = cv2.split(hsv)
    del hue

    dark_mask = gray < 95
    colored_dark_mask = (saturation > 35) & (value < 190)
    mask = (dark_mask | colored_dark_mask).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    return mask


def make_well_mask(image: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, saturation, value = cv2.split(hsv)

    very_dark_mask = gray < 82
    colored_dark_mask = (saturation > 45) & (value < 185)
    mask = (very_dark_mask | colored_dark_mask).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    return mask


def make_well_relative_dark_mask(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    local_background = float(np.median(gray))
    relative_dark_mask = (gray < (local_background - 24.0)) & (gray < 175)
    mask = relative_dark_mask.astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    return mask


def make_well_outline_mask(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 18, 55)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    edges = cv2.morphologyEx(edges, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return edges


def component_stats(mask: np.ndarray) -> dict[str, Any]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    areas = [float(cv2.contourArea(contour)) for contour in contours]
    areas = [area for area in areas if area >= 20.0]
    return {
        "component_count": len(areas),
        "largest_area_px": max(areas) if areas else 0.0,
        "total_area_px": float(sum(areas)),
    }


def well_candidate_stats(
    mask: np.ndarray,
    *,
    min_area_px: float = 20.0,
    max_area_px: float = 8000.0,
    max_aspect_ratio: float = 4.0,
    min_fill_ratio: float = 0.15,
    prefix: str = "",
) -> dict[str, Any]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    rejected_large = []
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < min_area_px:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        aspect_ratio = max(width, height) / max(1, min(width, height))
        fill_ratio = area / float(max(1, width * height))
        record = {
            "area_px": area,
            "width_px": int(width),
            "height_px": int(height),
            "aspect_ratio": float(aspect_ratio),
            "fill_ratio": float(fill_ratio),
        }
        if area > max_area_px:
            rejected_large.append(record)
            continue
        if aspect_ratio > max_aspect_ratio or fill_ratio < min_fill_ratio:
            continue
        candidates.append(record)

    largest_candidate = max((candidate["area_px"] for candidate in candidates), default=0.0)
    return {
        f"{prefix}candidate_count": len(candidates),
        f"{prefix}largest_candidate_area_px": largest_candidate,
        f"{prefix}rejected_large_component_count": len(rejected_large),
        f"{prefix}largest_rejected_large_area_px": max(
            (candidate["area_px"] for candidate in rejected_large),
            default=0.0,
        ),
    }


def inspect_well(image: np.ndarray) -> dict[str, Any]:
    crop_fraction = 0.32
    crop, _ = central_crop(image, crop_fraction)
    mask = make_well_mask(crop)
    relative_mask = make_well_relative_dark_mask(crop)
    outline_mask = make_well_outline_mask(crop)
    stats = component_stats(mask)
    relative_stats = component_stats(relative_mask)
    outline_stats = component_stats(outline_mask)
    candidate_stats = well_candidate_stats(mask)
    relative_candidate_stats = well_candidate_stats(
        relative_mask,
        min_area_px=35.0,
        max_area_px=8000.0,
        max_aspect_ratio=5.5,
        min_fill_ratio=0.08,
        prefix="relative_",
    )
    outline_candidate_stats = well_candidate_stats(
        outline_mask,
        min_area_px=35.0,
        max_area_px=6000.0,
        max_aspect_ratio=8.0,
        min_fill_ratio=0.04,
        prefix="outline_",
    )
    crop_area = float(mask.shape[0] * mask.shape[1])
    dark_fraction = stats["total_area_px"] / crop_area if crop_area else 0.0
    relative_dark_fraction = relative_stats["total_area_px"] / crop_area if crop_area else 0.0
    outline_fraction = outline_stats["total_area_px"] / crop_area if crop_area else 0.0
    occupied = (
        relative_dark_fraction >= 0.008
        or (
            relative_dark_fraction >= 0.004
            and relative_candidate_stats["relative_largest_candidate_area_px"] >= 360.0
        )
    )
    return {
        "mode": "well",
        "well_empty": not occupied,
        "bug_present": occupied,
        "dark_fraction": dark_fraction,
        "relative_dark_fraction": relative_dark_fraction,
        "outline_fraction": outline_fraction,
        "well_crop_fraction": crop_fraction,
        **candidate_stats,
        **relative_candidate_stats,
        **outline_candidate_stats,
        **stats,
    }


def inspect_nozzle(image: np.ndarray) -> dict[str, Any]:
    tip_crop, _ = central_crop(image, 0.13)
    tip_hsv = cv2.cvtColor(tip_crop, cv2.COLOR_BGR2HSV)
    tip_gray = cv2.cvtColor(tip_crop, cv2.COLOR_BGR2GRAY)
    hue, saturation, value = cv2.split(tip_hsv)

    height, width = tip_gray.shape[:2]
    yy, xx = np.ogrid[:height, :width]
    center_x = width / 2.0
    center_y = height / 2.0
    radius = min(width, height) * 0.49
    tip_roi = ((xx - center_x) ** 2 + (yy - center_y) ** 2) <= (radius * radius)
    blue_fixture = (hue > 80) & (hue < 130) & (saturation > 35)

    dark_tip_mask = (
        ((tip_gray < 95) | ((saturation > 45) & (value < 170)))
        & tip_roi
        & ~blue_fixture
    ).astype(np.uint8) * 255
    colored_tip_mask = (
        (saturation > 30)
        & (value > 80)
        & (value < 245)
        & tip_roi
        & ~blue_fixture
    ).astype(np.uint8) * 255
    pale_tip_mask = (
        (tip_gray > 155)
        & (saturation < 90)
        & tip_roi
    ).astype(np.uint8) * 255
    outline_tip_mask = cv2.Canny(cv2.GaussianBlur(tip_gray, (5, 5), 0), 20, 60)
    outline_tip_mask = (outline_tip_mask > 0).astype(np.uint8) * 255
    outline_tip_mask[~tip_roi] = 0

    dark_tip_mask = cv2.morphologyEx(dark_tip_mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    dark_tip_mask = cv2.morphologyEx(dark_tip_mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    colored_tip_mask = cv2.morphologyEx(colored_tip_mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    colored_tip_mask = cv2.morphologyEx(colored_tip_mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    pale_tip_mask = cv2.morphologyEx(pale_tip_mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    pale_tip_mask = cv2.morphologyEx(pale_tip_mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    outline_tip_mask = cv2.morphologyEx(outline_tip_mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    outline_tip_mask = cv2.morphologyEx(outline_tip_mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

    dark_stats = component_stats(dark_tip_mask)
    colored_stats = component_stats(colored_tip_mask)
    pale_stats = component_stats(pale_tip_mask)
    outline_stats = component_stats(outline_tip_mask)
    tip_area = float(np.count_nonzero(tip_roi))
    dark_fraction = dark_stats["total_area_px"] / tip_area if tip_area else 0.0

    bug_present = (
        dark_stats["largest_area_px"] >= 80.0
        or dark_stats["total_area_px"] >= 45.0
        or colored_stats["total_area_px"] >= 30.0
        or (
            pale_stats["total_area_px"] >= 800.0
            and pale_stats["total_area_px"] <= 2565.0
            and pale_stats["largest_area_px"] <= 2500.0
        )
        or (
            pale_stats["total_area_px"] >= 550.0
            and pale_stats["total_area_px"] < 800.0
            and pale_stats["largest_area_px"] >= 500.0
        )
        or (
            pale_stats["total_area_px"] >= 3100.0
            and pale_stats["largest_area_px"] >= 3000.0
            and pale_stats["component_count"] >= 3
        )
    )
    possible_multiple = (
        colored_stats["component_count"] >= 8
        and colored_stats["total_area_px"] >= 1800.0
        and pale_stats["component_count"] >= 3
    )
    largest_area = max(
        dark_stats["largest_area_px"],
        colored_stats["largest_area_px"],
        pale_stats["largest_area_px"],
        outline_stats["largest_area_px"],
    )
    total_area = (
        dark_stats["total_area_px"]
        + colored_stats["total_area_px"]
        + pale_stats["total_area_px"]
    )
    return {
        "mode": "nozzle",
        "well_empty": None,
        "bug_present": bug_present,
        "dark_fraction": dark_fraction,
        "possible_multiple": possible_multiple,
        "tip_component_count": colored_stats["component_count"],
        "tip_largest_area_px": largest_area,
        "tip_total_area_px": total_area,
        "tip_dark_component_count": dark_stats["component_count"],
        "tip_dark_largest_area_px": dark_stats["largest_area_px"],
        "tip_dark_total_area_px": dark_stats["total_area_px"],
        "tip_colored_component_count": colored_stats["component_count"],
        "tip_colored_largest_area_px": colored_stats["largest_area_px"],
        "tip_colored_total_area_px": colored_stats["total_area_px"],
        "tip_pale_component_count": pale_stats["component_count"],
        "tip_pale_largest_area_px": pale_stats["largest_area_px"],
        "tip_pale_total_area_px": pale_stats["total_area_px"],
        "tip_outline_component_count": outline_stats["component_count"],
        "tip_outline_largest_area_px": outline_stats["largest_area_px"],
        "tip_outline_total_area_px": outline_stats["total_area_px"],
        "component_count": colored_stats["component_count"],
        "largest_area_px": largest_area,
        "total_area_px": total_area,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--mode", choices=("well", "nozzle"), required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    image = cv2.imread(str(args.image), cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"Could not read image: {args.image}")

    result = inspect_well(image) if args.mode == "well" else inspect_nozzle(image)
    result.update(
        {
            "image": str(args.image),
            "updated_at": datetime.now().isoformat(),
        }
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
