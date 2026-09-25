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
import torch
from PIL import Image
from torch import nn
from torchvision import models, transforms


SCRIPT_DIR = Path(__file__).resolve().parent
NOZZLE_QA_MODEL = SCRIPT_DIR / "Data/qa_feedback/models/nozzle_qa_classifier.pt"
WELL_QA_MODEL = SCRIPT_DIR / "Data/qa_feedback/models/well_qa_classifier.pt"


class SmallQaCnn(nn.Module):
    def __init__(self, class_count: int) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 24, kernel_size=5, stride=2, padding=2),
            nn.BatchNorm2d(24),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(24, 48, kernel_size=3, padding=1),
            nn.BatchNorm2d(48),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(48, 96, kernel_size=3, padding=1),
            nn.BatchNorm2d(96),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d((1, 1)),
        )
        self.classifier = nn.Linear(96, class_count)

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        value = self.features(value)
        value = torch.flatten(value, 1)
        return self.classifier(value)


def build_qa_model(architecture: str, class_count: int) -> nn.Module:
    if architecture == "small_qa_cnn":
        return SmallQaCnn(class_count)
    if architecture == "efficientnet_b0":
        model = models.efficientnet_b0(weights=None)
        input_features = model.classifier[1].in_features
        model.classifier = nn.Sequential(
            nn.Dropout(p=0.25),
            nn.Linear(input_features, class_count),
        )
        return model
    raise ValueError(f"Unsupported QA architecture: {architecture}")


def inspect_nozzle_model(image: np.ndarray) -> dict[str, Any] | None:
    if not NOZZLE_QA_MODEL.exists():
        return None
    checkpoint = torch.load(NOZZLE_QA_MODEL, map_location="cpu", weights_only=False)
    classes = list(checkpoint.get("classes") or [])
    if classes != ["empty_nozzle", "specimen_present"]:
        return None
    architecture = str(checkpoint.get("architecture") or "small_qa_cnn")
    model = build_qa_model(architecture, len(classes))
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()

    crop_fraction = checkpoint.get("center_crop_fraction")
    crop, _ = central_crop(
        image,
        float(crop_fraction) if crop_fraction is not None else 0.50,
    )
    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(
            mean=checkpoint.get("normalization_mean", [0.485, 0.456, 0.406]),
            std=checkpoint.get("normalization_std", [0.229, 0.224, 0.225]),
        ),
    ])
    tensor = transform(Image.fromarray(rgb)).unsqueeze(0)
    with torch.no_grad():
        probabilities = torch.softmax(model(tensor), dim=1)[0]
    probability_by_class = {
        label: float(probabilities[index].item())
        for index, label in enumerate(classes)
    }
    empty_threshold = float(checkpoint.get("empty_confidence_threshold", 0.95))
    confidently_empty = probability_by_class["empty_nozzle"] >= empty_threshold
    return {
        "model_classes": classes,
        "model_probabilities": probability_by_class,
        "model_empty_threshold": empty_threshold,
        "model_confidently_empty": confidently_empty,
        "model_bug_present": not confidently_empty,
        "model_path": str(NOZZLE_QA_MODEL),
    }


def inspect_well_model(image: np.ndarray) -> dict[str, Any] | None:
    if not WELL_QA_MODEL.exists():
        return None
    checkpoint = torch.load(WELL_QA_MODEL, map_location="cpu", weights_only=False)
    classes = list(checkpoint.get("classes") or [])
    if classes != ["empty_well", "occupied_well"]:
        return None
    architecture = str(checkpoint.get("architecture") or "efficientnet_b0")
    model = build_qa_model(architecture, len(classes))
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()

    masked = image.copy()
    height, width = masked.shape[:2]
    radius_fraction = float(checkpoint.get("well_mask_radius_fraction", 0.36))
    radius = min(width, height) * radius_fraction
    yy, xx = np.ogrid[:height, :width]
    inside = ((xx - width / 2.0) ** 2 + (yy - height / 2.0) ** 2) <= radius**2
    mean_color = np.mean(masked.reshape(-1, 3), axis=0)
    masked[~inside] = mean_color.astype(np.uint8)
    rgb = cv2.cvtColor(masked, cv2.COLOR_BGR2RGB)
    transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(
            mean=checkpoint.get("normalization_mean", [0.485, 0.456, 0.406]),
            std=checkpoint.get("normalization_std", [0.229, 0.224, 0.225]),
        ),
    ])
    tensor = transform(Image.fromarray(rgb)).unsqueeze(0)
    with torch.inference_mode():
        probabilities = torch.softmax(model(tensor), dim=1)[0]
    probability_by_class = {
        label: float(probabilities[index].item())
        for index, label in enumerate(classes)
    }
    occupied = probability_by_class["occupied_well"] >= 0.50
    return {
        "model_classes": classes,
        "model_probabilities": probability_by_class,
        "model_well_occupied": occupied,
        "model_path": str(WELL_QA_MODEL),
        "well_mask_radius_fraction": radius_fraction,
    }


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


def component_count_at_least(mask: np.ndarray, min_area_px: float) -> int:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return sum(1 for contour in contours if float(cv2.contourArea(contour)) >= min_area_px)


def largest_component_geometry(mask: np.ndarray, center_x: float, center_y: float) -> dict[str, Any]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best_contour = None
    best_area = 0.0
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area > best_area:
            best_area = area
            best_contour = contour

    if best_contour is None or best_area < 20.0:
        return {
            "largest_component_width_px": 0,
            "largest_component_height_px": 0,
            "largest_component_aspect_ratio": 0.0,
            "largest_component_fill_ratio": 0.0,
            "largest_component_centroid_offset_px": 0.0,
        }

    x, y, width, height = cv2.boundingRect(best_contour)
    moments = cv2.moments(best_contour)
    if abs(moments["m00"]) < 0.000001:
        component_x = x + (width / 2.0)
        component_y = y + (height / 2.0)
    else:
        component_x = moments["m10"] / moments["m00"]
        component_y = moments["m01"] / moments["m00"]
    return {
        "largest_component_width_px": int(width),
        "largest_component_height_px": int(height),
        "largest_component_aspect_ratio": float(max(width, height) / max(1, min(width, height))),
        "largest_component_fill_ratio": float(best_area / float(max(1, width * height))),
        "largest_component_centroid_offset_px": float(
            ((component_x - center_x) ** 2 + (component_y - center_y) ** 2) ** 0.5
        ),
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
    body_sized_relative = (
        relative_candidate_stats["relative_largest_candidate_area_px"] >= 4200.0
        and relative_dark_fraction >= 0.006
    )
    large_body_region = relative_stats["largest_area_px"] >= 8000.0 and relative_dark_fraction >= 0.012

    full_hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hue, saturation, value = cv2.split(full_hsv)
    height, width = value.shape[:2]
    yy, xx = np.ogrid[:height, :width]
    center_x = width / 2.0
    center_y = height / 2.0
    well_radius = min(width, height) * 0.50
    well_roi = ((xx - center_x) ** 2 + (yy - center_y) ** 2) <= (well_radius * well_radius)
    side_body_mask = (
        (value < 135)
        & (saturation > 25)
        & well_roi
    ).astype(np.uint8) * 255
    side_body_mask = cv2.morphologyEx(side_body_mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    side_body_mask = cv2.morphologyEx(side_body_mask, cv2.MORPH_CLOSE, np.ones((4, 4), np.uint8))
    side_body_stats = component_stats(side_body_mask)
    full_background = float(np.median(gray[well_roi])) if np.any(well_roi) else float(np.median(gray))
    full_relative_mask = (
        (gray < (full_background - 18.0))
        & (gray < 215)
        & well_roi
    ).astype(np.uint8) * 255
    full_relative_mask = cv2.morphologyEx(full_relative_mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    full_relative_mask = cv2.morphologyEx(full_relative_mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    full_relative_stats = component_stats(full_relative_mask)
    full_relative_candidate_stats = well_candidate_stats(
        full_relative_mask,
        min_area_px=50.0,
        max_area_px=20000.0,
        max_aspect_ratio=12.0,
        min_fill_ratio=0.02,
        prefix="full_relative_",
    )
    full_color_mask = (
        (value < 165)
        & (saturation > 12)
        & well_roi
    ).astype(np.uint8) * 255
    full_color_mask = cv2.morphologyEx(full_color_mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    full_color_mask = cv2.morphologyEx(full_color_mask, cv2.MORPH_CLOSE, np.ones((4, 4), np.uint8))
    full_color_stats = component_stats(full_color_mask)
    side_body_region = (
        side_body_stats["largest_area_px"] >= 8500.0
        and side_body_stats["total_area_px"] >= 9000.0
    )
    peripheral_side_body_region = (
        side_body_stats["largest_area_px"] >= 2500.0
        and side_body_stats["total_area_px"] >= 3500.0
    )
    full_color_body_region = (
        full_color_stats["largest_area_px"] >= 3500.0
        and full_color_stats["total_area_px"] >= 4500.0
    )
    full_relative_body_region = (
        full_relative_candidate_stats["full_relative_largest_candidate_area_px"] >= 2500.0
        and full_relative_stats["total_area_px"] >= 6000.0
        and full_relative_candidate_stats["full_relative_candidate_count"] >= 5
    )
    large_full_relative_body_region = (
        full_relative_stats["largest_area_px"] >= 12000.0
        and full_relative_stats["total_area_px"] >= 16000.0
    )
    non_relative_occupied = (
        body_sized_relative
        or large_body_region
        or side_body_region
        or peripheral_side_body_region
        or full_color_body_region
    )
    relative_only_well_occupancy = (
        not non_relative_occupied
        and (full_relative_body_region or large_full_relative_body_region)
    )
    occupied = (
        non_relative_occupied
        or relative_only_well_occupancy
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
        "side_body_total_area_px": side_body_stats["total_area_px"],
        "side_body_largest_area_px": side_body_stats["largest_area_px"],
        "side_body_component_count": side_body_stats["component_count"],
        "full_relative_background_intensity": full_background,
        "full_relative_total_area_px": full_relative_stats["total_area_px"],
        "full_relative_largest_area_px": full_relative_stats["largest_area_px"],
        "full_relative_component_count": full_relative_stats["component_count"],
        **full_relative_candidate_stats,
        "full_color_total_area_px": full_color_stats["total_area_px"],
        "full_color_largest_area_px": full_color_stats["largest_area_px"],
        "full_color_component_count": full_color_stats["component_count"],
        "peripheral_side_body_region": peripheral_side_body_region,
        "full_color_body_region": full_color_body_region,
        "full_relative_body_region": full_relative_body_region,
        "large_full_relative_body_region": large_full_relative_body_region,
        "relative_only_well_occupancy": relative_only_well_occupancy,
        **stats,
    }


def inspect_well_top(image: np.ndarray) -> dict[str, Any]:
    """Detect specimens across the full well, including against its side wall."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    _, saturation, value = cv2.split(hsv)
    height, width = gray.shape[:2]
    center_x = width / 2.0
    center_y = height / 2.0

    blurred = cv2.medianBlur(gray, 9)
    circles = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=min(width, height) * 0.4,
        param1=80,
        param2=30,
        minRadius=int(min(width, height) * 0.15),
        maxRadius=int(min(width, height) * 0.48),
    )
    if circles is not None:
        candidates = circles[0]
        selected = min(
            candidates,
            key=lambda circle: (circle[0] - center_x) ** 2 + (circle[1] - center_y) ** 2,
        )
        well_x, well_y, well_radius = (float(value) for value in selected)
    else:
        well_x, well_y = center_x, center_y
        well_radius = min(width, height) * 0.42

    yy, xx = np.ogrid[:height, :width]
    specimen_radius = well_radius * 0.90
    well_roi = ((xx - well_x) ** 2 + (yy - well_y) ** 2) <= specimen_radius**2
    background = float(np.median(gray[well_roi])) if np.any(well_roi) else float(np.median(gray))
    relative_dark = gray < min(205.0, background - 18.0)
    colored_body = (saturation > 24) & (value < 195)
    mask = ((relative_dark | colored_body) & well_roi).astype(np.uint8) * 255
    kernel_scale = max(2, int(round(min(width, height) / 300.0)))
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_OPEN,
        np.ones((kernel_scale, kernel_scale), np.uint8),
    )
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        np.ones((kernel_scale * 2 + 1, kernel_scale * 2 + 1), np.uint8),
    )

    stats = component_stats(mask)
    roi_area = float(np.count_nonzero(well_roi))
    largest_fraction = stats["largest_area_px"] / roi_area if roi_area else 0.0
    total_fraction = stats["total_area_px"] / roi_area if roi_area else 0.0
    occupied = (
        largest_fraction >= 0.0015
        or total_fraction >= 0.0030
    )
    return {
        "mode": "well_top",
        "well_empty": not occupied,
        "bug_present": occupied,
        "relative_only_well_occupancy": False,
        "well_circle_x_px": well_x,
        "well_circle_y_px": well_y,
        "well_circle_radius_px": well_radius,
        "well_background_intensity": background,
        "largest_area_px": stats["largest_area_px"],
        "total_area_px": stats["total_area_px"],
        "component_count": stats["component_count"],
        "largest_area_fraction": largest_fraction,
        "dark_fraction": total_fraction,
    }


def inspect_nozzle(image: np.ndarray) -> dict[str, Any]:
    tip_crop, _ = central_crop(image, 0.18)
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
    colored_large_component_count = component_count_at_least(colored_tip_mask, 900.0)
    pale_large_component_count = component_count_at_least(pale_tip_mask, 2500.0)
    pale_geometry = largest_component_geometry(pale_tip_mask, center_x, center_y)
    outline_stats = component_stats(outline_tip_mask)
    tip_area = float(np.count_nonzero(tip_roi))
    dark_fraction = dark_stats["total_area_px"] / tip_area if tip_area else 0.0
    strong_texture_pickup = (
        dark_stats["largest_area_px"] >= 800.0
        or dark_stats["total_area_px"] >= 2500.0
        or colored_stats["total_area_px"] >= 3000.0
    )
    pale_texture_support = (
        dark_stats["total_area_px"] >= 25.0
        or colored_stats["total_area_px"] >= 20.0
    )
    bare_centered_tip_signature = (
        pale_large_component_count == 1
        and dark_stats["total_area_px"] < 25.0
        and colored_stats["total_area_px"] < 20.0
        and pale_stats["largest_area_px"] >= 12150.0
        and pale_stats["total_area_px"] >= 12150.0
        and pale_stats["total_area_px"] <= 12700.0
        and pale_geometry["largest_component_width_px"] <= 160
        and pale_geometry["largest_component_height_px"] >= 132
        and pale_geometry["largest_component_fill_ratio"] >= 0.580
        and pale_geometry["largest_component_fill_ratio"] <= 0.665
        and pale_geometry["largest_component_aspect_ratio"] >= 0.990
        and pale_geometry["largest_component_aspect_ratio"] <= 1.160
        and pale_geometry["largest_component_centroid_offset_px"] >= 18.0
        and pale_geometry["largest_component_centroid_offset_px"] <= 33.0
    )
    clean_bare_tip_reject = (
        bare_centered_tip_signature
        and (
            (
                pale_stats["total_area_px"] >= 12275.0
                and pale_stats["total_area_px"] <= 12325.0
                and pale_geometry["largest_component_centroid_offset_px"] >= 28.0
            )
            or (
                pale_stats["total_area_px"] >= 12375.0
                and pale_stats["total_area_px"] <= 12450.0
                and pale_geometry["largest_component_centroid_offset_px"] >= 26.0
            )
        )
    )
    ambiguous_bare_pickup = bare_centered_tip_signature and not clean_bare_tip_reject
    moderate_texture_pickup = (
        not bare_centered_tip_signature
        and dark_stats["total_area_px"] >= 350.0
        and colored_stats["total_area_px"] >= 100.0
        and pale_stats["total_area_px"] >= 4500.0
    )
    low_pale_texture_pickup = (
        not bare_centered_tip_signature
        and (
            (
                dark_stats["total_area_px"] >= 750.0
                and colored_stats["total_area_px"] >= 100.0
            )
            or (
                dark_stats["total_area_px"] >= 175.0
                and colored_stats["total_area_px"] >= 150.0
                and pale_stats["total_area_px"] >= 2500.0
            )
        )
    )
    permissive_texture_pickup = (
        not bare_centered_tip_signature
        and (
            (
                dark_stats["total_area_px"] >= 75.0
                and colored_stats["total_area_px"] >= 50.0
                and pale_stats["total_area_px"] >= 2500.0
            )
            or (
                pale_stats["total_area_px"] >= 7000.0
                and pale_stats["total_area_px"] <= 9000.0
                and pale_geometry["largest_component_fill_ratio"] <= 0.45
            )
        )
    )
    weak_single_channel_pickup = (
        not bare_centered_tip_signature
        and (
            (
                dark_stats["total_area_px"] >= 20.0
                and pale_stats["total_area_px"] >= 5500.0
            )
            or (
                dark_stats["total_area_px"] >= 500.0
                and pale_stats["total_area_px"] >= 2000.0
            )
        )
    )
    low_dark_pale_pickup = (
        not bare_centered_tip_signature
        and dark_fraction >= 0.015
        and dark_stats["total_area_px"] >= 90.0
        and pale_stats["total_area_px"] >= 2500.0
        and pale_texture_support
    )
    large_pale_pickup = (
        pale_stats["component_count"] >= 1
        and pale_stats["largest_area_px"] >= 7000.0
        and pale_stats["total_area_px"] >= 7000.0
        and pale_stats["total_area_px"] <= 14000.0
        and pale_texture_support
        and not bare_centered_tip_signature
    )
    offcenter_pale_pickup = (
        pale_stats["component_count"] >= 1
        and pale_stats["largest_area_px"] >= 7000.0
        and pale_stats["total_area_px"] >= 7000.0
        and pale_stats["total_area_px"] <= 18000.0
        and pale_texture_support
        and (
            pale_geometry["largest_component_aspect_ratio"] >= 1.45
            or pale_geometry["largest_component_centroid_offset_px"] >= radius * 0.35
            or pale_geometry["largest_component_fill_ratio"] <= 0.50
        )
    )
    low_fill_pale_pickup = (
        pale_stats["component_count"] >= 1
        and pale_stats["largest_area_px"] >= 9000.0
        and pale_stats["total_area_px"] >= 9000.0
        and pale_stats["total_area_px"] <= 15000.0
        and pale_geometry["largest_component_fill_ratio"] <= 0.54
        and pale_geometry["largest_component_centroid_offset_px"] >= radius * 0.20
        and pale_texture_support
    )
    centered_pale_pickup = (
        pale_large_component_count == 1
        and pale_stats["largest_area_px"] >= 10000.0
        and pale_stats["total_area_px"] >= 10000.0
        and pale_stats["total_area_px"] <= 16500.0
        and pale_geometry["largest_component_width_px"] >= 120
        and pale_geometry["largest_component_height_px"] >= 120
        and pale_geometry["largest_component_fill_ratio"] >= 0.50
        and pale_geometry["largest_component_centroid_offset_px"] <= radius * 0.40
        and not bare_centered_tip_signature
    )

    bug_present = (
        strong_texture_pickup
        or ambiguous_bare_pickup
        or moderate_texture_pickup
        or low_pale_texture_pickup
        or permissive_texture_pickup
        or weak_single_channel_pickup
        or low_dark_pale_pickup
        or large_pale_pickup
        or offcenter_pale_pickup
        or low_fill_pale_pickup
        or centered_pale_pickup
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
        pale_large_component_count >= 2
        and pale_stats["total_area_px"] >= 12000.0
        and (
            colored_large_component_count >= 2
            or colored_stats["total_area_px"] >= 4500.0
            or dark_stats["total_area_px"] >= 3500.0
        )
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
        "tip_colored_large_component_count": colored_large_component_count,
        "tip_colored_largest_area_px": colored_stats["largest_area_px"],
        "tip_colored_total_area_px": colored_stats["total_area_px"],
        "tip_pale_component_count": pale_stats["component_count"],
        "tip_pale_large_component_count": pale_large_component_count,
        "tip_pale_largest_area_px": pale_stats["largest_area_px"],
        "tip_pale_total_area_px": pale_stats["total_area_px"],
        "tip_pale_largest_width_px": pale_geometry["largest_component_width_px"],
        "tip_pale_largest_height_px": pale_geometry["largest_component_height_px"],
        "tip_pale_largest_aspect_ratio": pale_geometry["largest_component_aspect_ratio"],
        "tip_pale_largest_fill_ratio": pale_geometry["largest_component_fill_ratio"],
        "tip_pale_largest_centroid_offset_px": pale_geometry["largest_component_centroid_offset_px"],
        "tip_large_pale_pickup": large_pale_pickup,
        "tip_offcenter_pale_pickup": offcenter_pale_pickup,
        "tip_low_fill_pale_pickup": low_fill_pale_pickup,
        "tip_centered_pale_pickup": centered_pale_pickup,
        "tip_strong_texture_pickup": strong_texture_pickup,
        "tip_moderate_texture_pickup": moderate_texture_pickup,
        "tip_low_pale_texture_pickup": low_pale_texture_pickup,
        "tip_permissive_texture_pickup": permissive_texture_pickup,
        "tip_weak_single_channel_pickup": weak_single_channel_pickup,
        "tip_low_dark_pale_pickup": low_dark_pale_pickup,
        "tip_ambiguous_bare_pickup": ambiguous_bare_pickup,
        "tip_clean_bare_reject": clean_bare_tip_reject,
        "tip_pale_texture_support": pale_texture_support,
        "tip_bare_centered_signature": bare_centered_tip_signature,
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
    parser.add_argument("--mode", choices=("well", "well_top", "nozzle"), required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    image = cv2.imread(str(args.image), cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"Could not read image: {args.image}")

    if args.mode == "well":
        result = inspect_well(image)
    elif args.mode == "well_top":
        result = inspect_well_top(image)
        model_result = inspect_well_model(image)
        if model_result is None:
            result["decision_source"] = "opencv_heuristic"
            result["model_available"] = False
        else:
            result["heuristic_well_empty"] = bool(result["well_empty"])
            result.update(model_result)
            result["model_available"] = True
            result["well_empty"] = not bool(model_result["model_well_occupied"])
            result["bug_present"] = bool(model_result["model_well_occupied"])
            result["decision_source"] = "well_qa_model"
    else:
        result = inspect_nozzle(image)
        model_result = inspect_nozzle_model(image)
        if model_result is None:
            result["decision_source"] = "opencv_heuristic"
            result["model_available"] = False
        else:
            heuristic_bug_present = bool(result["bug_present"])
            model_bug_present = bool(model_result["model_bug_present"])
            result.update(model_result)
            result["model_available"] = True
            result["heuristic_bug_present"] = heuristic_bug_present
            # A compatible promoted model is the nozzle decision authority. The
            # caller still requires two independently captured frames to clear.
            result["bug_present"] = model_bug_present
            result["decision_source"] = "nozzle_qa_model"
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
