#!/usr/bin/env python3
import json
import os
import sys

import cv2
import numpy as np


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


def annotated_path_for(image_path):
    base, ext = os.path.splitext(image_path)
    return "%s_boxed%s" % (base, ext or ".png")


def mark_centroid(image, center_x, center_y):
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


def make_dark_mask(gray):
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    _, mask = cv2.threshold(
        blurred,
        FIXED_DARK_THRESHOLD,
        255,
        cv2.THRESH_BINARY_INV,
    )

    # Fill light handwriting and ragged reflection gaps inside the black label.
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(
            cv2.MORPH_RECT,
            (CLOSE_KERNEL_SIZE, CLOSE_KERNEL_SIZE),
        ),
    )
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (OPEN_KERNEL_SIZE, OPEN_KERNEL_SIZE)),
    )
    return mask


def mark_label(image, label, box):
    x = int(min(point[0] for point in box))
    y = int(min(point[1] for point in box))
    y = max(0, y - 6)

    text = str(label)
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 0.8
    thickness = 2
    (text_width, text_height), baseline = cv2.getTextSize(
        text,
        font,
        font_scale,
        thickness,
    )
    top_left = (max(0, x), max(text_height + baseline + 2, y) - text_height - baseline - 2)
    bottom_right = (
        top_left[0] + text_width + 8,
        top_left[1] + text_height + baseline + 6,
    )
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


def contour_contrast(gray, contour):
    object_mask = np.zeros(gray.shape, dtype=np.uint8)
    cv2.drawContours(object_mask, [contour], -1, 255, -1)

    dilated_mask = cv2.dilate(
        object_mask,
        cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25)),
        iterations=1,
    )
    ring_mask = cv2.subtract(dilated_mask, object_mask)

    inside_mean = cv2.mean(gray, mask=object_mask)[0]
    ring_mean = cv2.mean(gray, mask=ring_mask)[0]
    return inside_mean, ring_mean, ring_mean - inside_mean


def detect_black_rectangles(image_path):
    image = cv2.imread(image_path)
    if image is None:
        raise RuntimeError("Could not read image: %s" % image_path)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mask = make_dark_mask(gray)

    image_area = image.shape[0] * image.shape[1]
    reference_side = min(image.shape[0], image.shape[1])
    max_area = image_area * MAX_AREA_FRACTION
    max_rect_area = image_area * MAX_RECT_AREA_FRACTION
    max_short_side = reference_side * MAX_SHORT_SIDE_FRACTION
    max_long_side = reference_side * MAX_LONG_SIDE_FRACTION
    candidates = []

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < MIN_AREA_PX or area > max_area:
            continue

        rect = cv2.minAreaRect(contour)
        (center_x, center_y), (width, height), angle = rect
        rect_area = width * height
        if rect_area <= 0:
            continue

        short_side = min(width, height)
        long_side = max(width, height)
        if short_side <= 0:
            continue
        if rect_area > max_rect_area:
            continue
        if short_side > max_short_side or long_side > max_long_side:
            continue

        aspect_ratio = long_side / short_side
        if aspect_ratio < MIN_ASPECT_RATIO or aspect_ratio > MAX_ASPECT_RATIO:
            continue

        rectangularity = area / rect_area
        if rectangularity < MIN_RECTANGULARITY:
            continue

        mean_intensity, background_mean, contrast = contour_contrast(gray, contour)
        if mean_intensity > MAX_INSIDE_MEAN_INTENSITY:
            continue
        if contrast < MIN_BACKGROUND_CONTRAST:
            continue

        box = cv2.boxPoints(rect)
        box = np.intp(box)

        score = contrast * rectangularity * min(aspect_ratio, 3.0)
        candidates.append(
            {
                "centroid_px": [float(center_x), float(center_y)],
                "area_px": float(area),
                "rectangularity": float(rectangularity),
                "aspect_ratio": float(aspect_ratio),
                "mean_intensity": float(mean_intensity),
                "background_mean_intensity": float(background_mean),
                "background_contrast": float(contrast),
                "angle_degrees": float(angle),
                "size_px": [float(width), float(height)],
                "box_px": box.astype(float).tolist(),
                "score": float(score),
            }
        )

    candidates.sort(key=lambda item: (item["centroid_px"][1], item["centroid_px"][0]))
    for index, candidate in enumerate(candidates, 1):
        candidate["id"] = index

    if candidates:
        annotated = image.copy()
        for candidate in candidates:
            box = np.array(candidate["box_px"], dtype=np.int32)
            cv2.drawContours(annotated, [box], 0, BOUNDING_BOX_COLOR, LINE_THICKNESS)
            mark_label(annotated, candidate["id"], box)
            center_x, center_y = candidate["centroid_px"]
            mark_centroid(annotated, center_x, center_y)

        output_path = annotated_path_for(image_path)
        cv2.imwrite(output_path, annotated)
        for candidate in candidates:
            candidate["annotated_image_path"] = output_path

    return candidates


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: bugpicker_detect.py IMAGE_PATH")

    detections = detect_black_rectangles(sys.argv[1])
    print(
        json.dumps(
            {
                "found": len(detections) > 0,
                "detections": detections,
            }
        )
    )


if __name__ == "__main__":
    main()
