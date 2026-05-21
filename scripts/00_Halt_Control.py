#!/usr/bin/env python3
"""00: Lightweight cooperative pause/resume control for scan scripts."""

from __future__ import annotations

import json
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import messagebox, ttk


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONTROL_DIR = PROJECT_ROOT / "control"
HALT_FILE = CONTROL_DIR / "halt.flag"
STATUS_FILE = CONTROL_DIR / "scan_status.json"


class HaltControl(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("BioKEA Bug PnP Control")
        self.geometry("680x450")
        self.minsize(680, 450)

        CONTROL_DIR.mkdir(exist_ok=True)

        self.status_var = tk.StringVar(value="No scan status yet")
        self.scan_var = tk.StringVar(value="Scan: -")
        self.frame_var = tk.StringVar(value="Frame: -")
        self.progress_var = tk.StringVar(value="Progress: -")
        self.updated_var = tk.StringVar(value="Updated: -")
        self.message_var = tk.StringVar(value="")
        self.halt_var = tk.StringVar(value="Pause flag is clear")

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
        style.configure("Logo.TLabel", background="#09211c", foreground="#f5f1e8", font=("TkDefaultFont", 26, "bold"))
        style.configure("Tag.TLabel", background="#09211c", foreground="#a7d8bf", font=("TkDefaultFont", 10))
        style.configure("Title.TLabel", background="#eef3f1", foreground="#09211c", font=("TkDefaultFont", 16, "bold"))
        style.configure("Panel.TLabel", background="#ffffff", foreground="#111827", font=("TkDefaultFont", 12))
        style.configure("Small.TLabel", background="#ffffff", foreground="#4b5563", font=("TkDefaultFont", 10))

        outer = ttk.Frame(self, padding=18, style="Outer.TFrame")
        outer.pack(fill="both", expand=True)

        brand = ttk.Frame(outer, padding=16, style="Brand.TFrame")
        brand.pack(fill="x")
        ttk.Label(brand, text="BioKEA", style="Logo.TLabel").pack(anchor="w")

        ttk.Label(outer, text="Bug PnP Scan Control", style="Title.TLabel").pack(anchor="w", pady=(16, 0))

        panel = ttk.Frame(outer, padding=14, style="Panel.TFrame")
        panel.pack(fill="x", pady=(12, 12))

        ttk.Label(panel, textvariable=self.status_var, style="Panel.TLabel").grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(panel, textvariable=self.scan_var, style="Small.TLabel").grid(row=1, column=0, sticky="w", pady=(8, 0))
        ttk.Label(panel, textvariable=self.frame_var, style="Small.TLabel").grid(row=1, column=1, sticky="w", padx=(22, 0), pady=(8, 0))
        ttk.Label(panel, textvariable=self.progress_var, style="Small.TLabel").grid(row=2, column=0, sticky="w", pady=(4, 0))
        ttk.Label(panel, textvariable=self.updated_var, style="Small.TLabel").grid(row=2, column=1, sticky="w", padx=(22, 0), pady=(4, 0))
        ttk.Label(panel, textvariable=self.message_var, style="Small.TLabel", wraplength=500).grid(
            row=3, column=0, columnspan=2, sticky="w", pady=(8, 0)
        )

        halt_panel = ttk.Frame(outer, padding=14, style="Panel.TFrame")
        halt_panel.pack(fill="x")

        ttk.Label(halt_panel, textvariable=self.halt_var, style="Panel.TLabel").pack(anchor="w")

        button_row = ttk.Frame(halt_panel, style="Panel.TFrame")
        button_row.pack(fill="x", pady=(12, 0))

        halt_button = tk.Button(
            button_row,
            text="PAUSE / HALT",
            command=self.request_pause,
            height=3,
            bg="#a32020",
            fg="white",
            activebackground="#7a1616",
            activeforeground="white",
            font=("TkDefaultFont", 14, "bold"),
            relief="flat",
        )
        halt_button.pack(side="left", fill="x", expand=True, padx=(0, 8))

        clear_button = tk.Button(
            button_row,
            text="RESUME",
            command=self.resume_scan,
            height=3,
            bg="#1d6b4f",
            fg="white",
            activebackground="#15543e",
            activeforeground="white",
            font=("TkDefaultFont", 12, "bold"),
            relief="flat",
        )
        clear_button.pack(side="left", fill="x", expand=True)

        note = (
            "Cooperative pause: the running script waits before the next scan move and resumes when cleared. "
            "Use OpenPnP/controller/physical stop for immediate emergency stop."
        )
        ttk.Label(outer, text=note, wraplength=520).pack(anchor="w", pady=(12, 0))

    def request_pause(self) -> None:
        CONTROL_DIR.mkdir(exist_ok=True)
        HALT_FILE.write_text(f"pause requested at {datetime.now().isoformat()}\n", encoding="utf-8")
        self.refresh()

    def resume_scan(self) -> None:
        HALT_FILE.unlink(missing_ok=True)
        self.refresh()

    def on_close(self) -> None:
        if not HALT_FILE.exists():
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
            HALT_FILE.unlink(missing_ok=True)

        self.destroy()

    def refresh(self) -> None:
        self.halt_var.set("Pause flag is REQUESTED" if HALT_FILE.exists() else "Pause flag is clear")

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
        else:
            self.status_var.set("No scan status yet")
            self.scan_var.set("Scan: -")
            self.frame_var.set("Frame: -")
            self.progress_var.set("Progress: -")
            self.updated_var.set("Updated: -")
            self.message_var.set("")

        self.after(500, self.refresh)

    def _progress_text(self, frame: object, total: object) -> str:
        try:
            frame_number = int(frame)
            total_number = int(total)
            if total_number <= 0:
                raise ValueError
        except (TypeError, ValueError):
            return "Progress: -"

        return f"Progress: {(frame_number / total_number) * 100:.1f}%"


def main() -> int:
    app = HaltControl()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
