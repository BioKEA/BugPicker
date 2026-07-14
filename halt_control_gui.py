#!/usr/bin/env python3
"""00: Lightweight cooperative pause/resume/halt control for scan scripts."""

from __future__ import annotations

import json
import tkinter as tk
import time
from datetime import datetime
from pathlib import Path
from tkinter import messagebox, ttk


SCRIPT_PATH = Path(__file__).resolve()
if SCRIPT_PATH.parent.name == "BugPicker" and SCRIPT_PATH.parent.parent.name == "scripts":
    PROJECT_ROOT = SCRIPT_PATH.parents[2]
else:
    PROJECT_ROOT = SCRIPT_PATH.parents[1]
CONTROL_DIR = PROJECT_ROOT / "control"
PAUSE_FILE = CONTROL_DIR / "pause.flag"
STOP_FILE = CONTROL_DIR / "stop.flag"
STATUS_FILE = CONTROL_DIR / "scan_status.json"
DETECTION_STATUS_FILE = CONTROL_DIR / "detection_status.json"
TERMINAL_SCAN_STATUSES = {"completed", "halted", "failed", "error"}
AUTO_CLOSE_DELAY_MS = 1500


class HaltControl(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("BioKEA Bug PnP Control")
        self.geometry("580x720")
        self.minsize(580, 560)

        CONTROL_DIR.mkdir(exist_ok=True)

        self.status_var = tk.StringVar(value="No scan status yet")
        self.scan_var = tk.StringVar(value="Scan: -")
        self.frame_var = tk.StringVar(value="Frame: -")
        self.progress_var = tk.StringVar(value="Progress: -")
        self.updated_var = tk.StringVar(value="Updated: -")
        self.message_var = tk.StringVar(value="")
        self.control_var = tk.StringVar(value="Controls clear")
        self.detection_var = tk.StringVar(value="Latest detection: -")
        self.detection_detail_var = tk.StringVar(value="")
        self.detection_image: tk.PhotoImage | None = None
        self.detection_preview_path: Path | None = None
        self.detection_preview_mtime: float | None = None
        self.detection_image_label: ttk.Label | None = None
        self.started_at_epoch = time.time()
        self.auto_close_after_id: str | None = None

        self.configure(bg="#eef3f1")
        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self._build()
        self.refresh()

    def _build(self) -> None:
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("Outer.TFrame", background="#eef3f1")
        style.configure("Panel.TFrame", background="#ffffff")
        style.configure("Brand.TFrame", background="#09211c")
        style.configure("Logo.TLabel", background="#09211c", foreground="#f5f1e8", font=("TkDefaultFont", 18, "bold"))
        style.configure("Title.TLabel", background="#eef3f1", foreground="#09211c", font=("TkDefaultFont", 12, "bold"))
        style.configure("Panel.TLabel", background="#ffffff", foreground="#111827", font=("TkDefaultFont", 10))
        style.configure("Small.TLabel", background="#ffffff", foreground="#4b5563", font=("TkDefaultFont", 9))

        outer = ttk.Frame(self, padding=12, style="Outer.TFrame")
        outer.pack(fill="both", expand=True)

        brand = ttk.Frame(outer, padding=10, style="Brand.TFrame")
        brand.pack(fill="x")
        ttk.Label(brand, text="BioKEA", style="Logo.TLabel").pack(anchor="w")

        ttk.Label(outer, text="Bug PnP Scan Control", style="Title.TLabel").pack(anchor="w", pady=(10, 0))

        panel = ttk.Frame(outer, padding=10, style="Panel.TFrame")
        panel.pack(fill="x", pady=(8, 8))

        ttk.Label(panel, textvariable=self.status_var, style="Panel.TLabel").grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(panel, textvariable=self.scan_var, style="Small.TLabel").grid(row=1, column=0, sticky="w", pady=(8, 0))
        ttk.Label(panel, textvariable=self.frame_var, style="Small.TLabel").grid(row=1, column=1, sticky="w", padx=(22, 0), pady=(8, 0))
        ttk.Label(panel, textvariable=self.progress_var, style="Small.TLabel").grid(row=2, column=0, sticky="w", pady=(4, 0))
        ttk.Label(panel, textvariable=self.updated_var, style="Small.TLabel").grid(row=2, column=1, sticky="w", padx=(22, 0), pady=(4, 0))
        ttk.Label(panel, textvariable=self.message_var, style="Small.TLabel", wraplength=500).grid(
            row=3, column=0, columnspan=2, sticky="w", pady=(8, 0)
        )

        halt_panel = ttk.Frame(outer, padding=10, style="Panel.TFrame")
        halt_panel.pack(fill="x")

        ttk.Label(halt_panel, textvariable=self.control_var, style="Panel.TLabel").pack(anchor="w")

        button_row = ttk.Frame(halt_panel, style="Panel.TFrame")
        button_row.pack(fill="x", pady=(12, 0))

        pause_button = tk.Button(
            button_row,
            text="PAUSE",
            command=self.request_pause,
            height=2,
            bg="#d6a11d",
            fg="#111827",
            activebackground="#b98512",
            activeforeground="#111827",
            font=("TkDefaultFont", 10, "bold"),
            relief="flat",
        )
        pause_button.pack(side="left", fill="x", expand=True, padx=(0, 6))

        resume_button = tk.Button(
            button_row,
            text="RESUME",
            command=self.resume_scan,
            height=2,
            bg="#1d6b4f",
            fg="white",
            activebackground="#15543e",
            activeforeground="white",
            font=("TkDefaultFont", 10, "bold"),
            relief="flat",
        )
        resume_button.pack(side="left", fill="x", expand=True, padx=(0, 6))

        halt_button = tk.Button(
            button_row,
            text="HALT",
            command=self.request_halt,
            height=2,
            bg="#a32020",
            fg="white",
            activebackground="#7a1616",
            activeforeground="white",
            font=("TkDefaultFont", 10, "bold"),
            relief="flat",
        )
        halt_button.pack(side="left", fill="x", expand=True)

        note = (
            "Pause waits before the next scan move. Halt exits the running script before the next move. "
            "Use OpenPnP/controller/physical stop for immediate emergency stop."
        )
        ttk.Label(outer, text=note, wraplength=500).pack(anchor="w", pady=(8, 0))

        detection_panel = ttk.Frame(outer, padding=10, style="Panel.TFrame")
        detection_panel.pack(fill="both", expand=True, pady=(8, 0))

        ttk.Label(detection_panel, textvariable=self.detection_var, style="Panel.TLabel").pack(anchor="w")
        ttk.Label(
            detection_panel,
            textvariable=self.detection_detail_var,
            style="Small.TLabel",
            wraplength=520,
        ).pack(anchor="w", pady=(4, 8))
        self.detection_image_label = ttk.Label(detection_panel, style="Panel.TLabel")
        self.detection_image_label.pack(anchor="center", fill="both", expand=True)

    def request_pause(self) -> None:
        CONTROL_DIR.mkdir(exist_ok=True)
        PAUSE_FILE.write_text(f"pause requested at {datetime.now().isoformat()}\n", encoding="utf-8")
        self.refresh()

    def resume_scan(self) -> None:
        PAUSE_FILE.unlink(missing_ok=True)
        self.refresh()

    def request_halt(self) -> None:
        CONTROL_DIR.mkdir(exist_ok=True)
        STOP_FILE.write_text(f"halt requested at {datetime.now().isoformat()}\n", encoding="utf-8")
        PAUSE_FILE.unlink(missing_ok=True)
        self.refresh()

    def on_close(self) -> None:
        if not PAUSE_FILE.exists():
            self.destroy()
            return

        should_resume = messagebox.askyesno(
            title="Resume Before Closing?",
            message=(
                "The scan is currently paused.\n\n"
                "Clear the pause flag and allow the scan to resume before closing?"
            ),
            default=messagebox.YES,
        )
        if should_resume:
            PAUSE_FILE.unlink(missing_ok=True)

        self.destroy()

    def refresh(self) -> None:
        controls = []
        if PAUSE_FILE.exists():
            controls.append("pause requested")
        if STOP_FILE.exists():
            controls.append("halt requested")
        self.control_var.set("Controls: " + (", ".join(controls) if controls else "clear"))

        if STATUS_FILE.exists():
            try:
                status = json.loads(STATUS_FILE.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                self.status_var.set("Status: unreadable status file")
                self.scan_var.set("Scan: -")
                self.frame_var.set("Frame: -")
                self.progress_var.set("Progress: -")
                self.updated_var.set("Updated: -")
                self.message_var.set("")
            else:
                state = status.get("status", "unknown").upper()
                frame = status.get("frame_index", "-")
                total = status.get("total_frames", "-")
                self.status_var.set(f"Status: {state}")
                self.scan_var.set(f"Scan: {status.get('scan_id', '-')}")
                self.frame_var.set(f"Frame: {frame} / {total}")
                self.progress_var.set(self._progress_text(frame, total))
                self.updated_var.set(f"Updated: {status.get('updated_at', '-')}")
                self.message_var.set(status.get("message", ""))
                self._schedule_auto_close_if_finished(status)
        else:
            self.status_var.set("No scan status yet")
            self.scan_var.set("Scan: -")
            self.frame_var.set("Frame: -")
            self.progress_var.set("Progress: -")
            self.updated_var.set("Updated: -")
            self.message_var.set("")

        self.refresh_detection()
        self.after(500, self.refresh)

    def _schedule_auto_close_if_finished(self, status: dict[str, object]) -> None:
        state = str(status.get("status", "")).lower()
        if state not in TERMINAL_SCAN_STATUSES or self.auto_close_after_id is not None:
            return

        try:
            status_mtime = STATUS_FILE.stat().st_mtime
        except OSError:
            return

        if status_mtime < self.started_at_epoch:
            return

        if PAUSE_FILE.exists():
            return

        self.auto_close_after_id = self.after(AUTO_CLOSE_DELAY_MS, self.destroy)

    def refresh_detection(self) -> None:
        if not DETECTION_STATUS_FILE.exists():
            self.detection_var.set("Latest detection: -")
            self.detection_detail_var.set("")
            self._clear_detection_image()
            return

        try:
            status = json.loads(DETECTION_STATUS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            self.detection_var.set("Latest detection: unreadable detection status")
            self.detection_detail_var.set("")
            self._clear_detection_image()
            return

        detection_state = status.get("status", "unknown")
        if detection_state != "detected":
            if detection_state == "processing":
                self.detection_var.set("Latest detection: processing current scan")
            elif detection_state == "none_found":
                self.detection_var.set("Latest detection: none found")
            else:
                self.detection_var.set(f"Latest detection: {detection_state}")
            self.detection_detail_var.set(status.get("message", ""))
            self._clear_detection_image()
            return

        frame = status.get("frame_index", "-")
        count = status.get("detections_in_frame", "-")
        duplicates_in_frame = status.get("duplicates_in_frame", 0)
        unique_object_count = status.get("unique_object_count", "-")
        duplicate_count = status.get("duplicate_count", "-")
        label = status.get("label", "")
        score = status.get("score", "-")
        centroid_x = status.get("centroid_x_px", "-")
        centroid_y = status.get("centroid_y_px", "-")
        pressure_parts = []
        if "vacuum_level" in status:
            level = status.get("vacuum_level")
            if level is None:
                pressure_parts.append("Vacuum: unreadable")
            else:
                pressure_parts.append(f"Vacuum: {self._format_number(level)}")

            part_on = status.get("vacuum_part_on")
            if part_on is True:
                pressure_parts.append("part detected")
            elif part_on is False:
                pressure_parts.append("no part detected")

            attempt = status.get("vacuum_attempt")
            if attempt not in (None, ""):
                pressure_parts.append(f"attempt {attempt}")

            pick_z = status.get("pick_z_mm")
            if pick_z not in (None, ""):
                pressure_parts.append(f"Z {self._format_number(pick_z)} mm")

        qa_parts = []
        if "qa_mode" in status:
            qa_parts.append(f"QA: {status.get('qa_mode')}")
            if status.get("qa_well_empty") is True:
                qa_parts.append("well empty")
            elif status.get("qa_well_empty") is False:
                qa_parts.append("well occupied")
            if status.get("qa_bug_present") is True:
                qa_parts.append("bug present")
            elif status.get("qa_bug_present") is False:
                qa_parts.append("no bug detected")
            if "qa_largest_area_px" in status:
                qa_parts.append(f"largest area {self._format_number(status.get('qa_largest_area_px'))} px")
            if "qa_dark_fraction" in status:
                qa_parts.append(f"dark fraction {self._format_number(status.get('qa_dark_fraction'))}")

        label_text = f": {label}" if label else ""
        self.detection_var.set(
            f"Latest detection{label_text} | frame {frame} "
            f"({count} in frame, {duplicates_in_frame} duplicate)"
        )
        detail = (
            f"Unique targets so far: {unique_object_count}   Duplicates so far: {duplicate_count}   "
            f"Centroid: {self._format_number(centroid_x)}, {self._format_number(centroid_y)} px   "
            f"Score: {self._format_number(score)}   Updated: {status.get('updated_at', '-')}"
        )
        if pressure_parts:
            detail = f"{detail}\n" + "   ".join(pressure_parts)
        if qa_parts:
            detail = f"{detail}\n" + "   ".join(qa_parts)
        self.detection_detail_var.set(detail)

        preview = status.get("preview_file")
        if not preview or self.detection_image_label is None:
            return

        preview_path = Path(preview)
        if not preview_path.exists():
            return

        mtime = preview_path.stat().st_mtime
        if self.detection_preview_path == preview_path and self.detection_preview_mtime == mtime:
            return

        try:
            image = tk.PhotoImage(file=str(preview_path))
        except tk.TclError:
            return

        max_width = 520
        max_height = 293
        subsample = max(
            1,
            int((image.width() + max_width - 1) / max_width),
            int((image.height() + max_height - 1) / max_height),
        )
        self.detection_image = image.subsample(subsample, subsample)

        self.detection_preview_path = preview_path
        self.detection_preview_mtime = mtime
        self.detection_image_label.configure(image=self.detection_image)

    def _clear_detection_image(self) -> None:
        self.detection_image = None
        self.detection_preview_path = None
        self.detection_preview_mtime = None
        if self.detection_image_label is not None:
            self.detection_image_label.configure(image="")

    def _progress_text(self, frame: object, total: object) -> str:
        try:
            frame_number = int(frame)
            total_number = int(total)
            if total_number <= 0:
                raise ValueError
        except (TypeError, ValueError):
            return "Progress: -"

        return f"Progress: {(frame_number / total_number) * 100:.1f}%"

    def _format_number(self, value: object) -> str:
        try:
            return f"{float(value):.1f}"
        except (TypeError, ValueError):
            return str(value)


def main() -> int:
    app = HaltControl()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
