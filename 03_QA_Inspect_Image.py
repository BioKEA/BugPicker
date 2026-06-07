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


def component_stats(mask: np.ndarray) -> dict[str, Any]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    areas = [float(cv2.contourArea(contour)) for contour in contours]
    areas = [area for area in areas if area >= 20.0]
    return {
        "component_count": len(areas),
        "largest_area_px": max(areas) if areas else 0.0,
        "total_area_px": float(sum(areas)),
    }


def inspect_well(image: np.ndarray) -> dict[str, Any]:
    crop, _ = central_crop(image, 0.72)
    mask = make_bug_mask(crop)
    stats = component_stats(mask)
    crop_area = float(mask.shape[0] * mask.shape[1])
    dark_fraction = stats["total_area_px"] / crop_area if crop_area else 0.0
    occupied = stats["largest_area_px"] >= 90.0 or dark_fraction >= 0.0015
    return {
        "mode": "well",
        "well_empty": not occupied,
        "bug_present": occupied,
        "dark_fraction": dark_fraction,
        **stats,
    }


def inspect_nozzle(image: np.ndarray) -> dict[str, Any]:
    crop, _ = central_crop(image, 0.62)
    mask = make_bug_mask(crop)
    stats = component_stats(mask)
    crop_area = float(mask.shape[0] * mask.shape[1])
    dark_fraction = stats["total_area_px"] / crop_area if crop_area else 0.0
    bug_present = stats["largest_area_px"] >= 120.0 or dark_fraction >= 0.002
    return {
        "mode": "nozzle",
        "well_empty": None,
        "bug_present": bug_present,
        "dark_fraction": dark_fraction,
        **stats,
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
