# BugPicker

test
**An automated insect pick-and-place machine, converted from an [Opulo LumenPnP](https://www.opulo.io/products/lumenpnp).**

BugPicker repurposes an open-source PCB pick-and-place machine — normally used to place electronic components on circuit boards — into a robot that scans a tray of insects, detects them with computer vision, and picks each one up with a vacuum nozzle to sort it into a 96-well plate. The motion platform, cameras, and vacuum hardware are stock LumenPnP; the intelligence lives in the OpenPnP scripts and Python vision tools in this repo.

---

## How it works

The system runs as a pipeline coordinated between an OpenPnP scripting layer (JavaScript, executed inside OpenPnP via the Nashorn engine) and a set of Python vision/QA tools. They communicate through files in a `control/` directory and per-run `scans/` directories.

```
   ┌─────────────────────┐     scan images      ┌──────────────────────────┐
   │  OpenPnP machine     │ ───────────────────► │  Vision segmentation     │
   │  (LumenPnP hardware)  │                      │  (OpenCV, Python)        │
   │                      │ ◄─────────────────── │                          │
   └─────────┬───────────┘   pick coordinates    └──────────────────────────┘
             │                                              ▲
             │ pick / inspect / place                       │ QA images
             ▼                                              │
   ┌─────────────────────┐                       ┌──────────────────────────┐
   │  96-well plate +     │                       │  QA inspection (Python)  │
   │  vacuum nozzle N1    │                       │  well / nozzle checks    │
   └─────────────────────┘                       └──────────────────────────┘
```

**End-to-end run:**

1. **Scan** — The top camera rasters over a rectangular tray area in a grid, capturing overlapping frames and logging each frame's machine position to a manifest.
2. **Detect** — A Python OpenCV script watches the scan as it runs, segments dark insect silhouettes out of each frame, deduplicates targets seen in overlapping frames, and converts pixel positions into machine X/Y pick coordinates.
3. **Pick** — For each detected insect, nozzle N1 descends with vacuum on and confirms a pickup via the vacuum pressure sensor (retrying deeper if needed).
4. **Inspect** — The bottom camera photographs the bug on the nozzle; a QA script confirms something was actually picked.
5. **Place** — The insect is dropped into the next numbered well of a 96-well plate (A1…H12).
6. **Verify** — The top camera photographs the well to confirm the drop, and if the well looks empty, re-checks the nozzle and brush-cleans it if the bug is stuck.

A small Tkinter GUI provides cooperative **pause / resume / halt** control and a live view of the latest detection while a run is in progress.

---

## Repository contents

| Path | Description |
|------|-------------|
| `00_Halt_Control.py` | Tkinter control panel — pause/resume/halt buttons, live scan status, and a preview of the most recent detection. Communicates with the running scan via flag and status files in `control/`. |
| `01_Scan_TopCamera_Rectangle.js` | The main OpenPnP script (runs inside OpenPnP). Orchestrates the whole run: grid scan, calling the Python detector, picking with vacuum verification, bottom-camera/well QA, placing into wells, and nozzle cleaning. |
| `02_Segment_Scan_Objects.py` | OpenCV insect detector. Segments bugs from scan frames, deduplicates across overlapping frames, maps pixels → machine coordinates, and emits `objects.jsonl` for the picker. Runs in `--watch` mode alongside the scan. |
| `03_QA_Inspect_Image.py` | Image QA tool. Given a captured image, reports whether a well is empty/occupied or whether a bug is stuck on the nozzle. Called repeatedly by the scan script. |
| `Designs/tray.stl`, `Designs/screentray.stl` | Custom 3D-printable trays for holding insects under the camera. |
| `Data/training data/` | Sample scan frames (`set1`–`set3`) used for tuning detection. |
| `machine.xml.backup-before-full-color` | A backup of the OpenPnP machine configuration (axes, drivers, cameras, nozzles, actuators) for this specific machine. |
| `requirements.txt` | Python dependencies (`numpy`, `opencv-python`). |
| `*.bak*` / `*.backup*` | Working backups kept during development. |

> **Note on numbering:** the `00_`/`01_`/`02_`/`03_` prefixes reflect the order in which the pieces participate in a run (control panel → scan → detect → QA), not a sequence you run by hand. `01` drives the whole show and invokes the others automatically.

---

## Requirements

- **Hardware:** an Opulo LumenPnP (or compatible OpenPnP machine) with a top camera, bottom (up-looking) camera, a vacuum nozzle (N1) with a pressure sensor on actuator `VAC1`, and a 96-well plate fixture.
- **Software:**
  - [OpenPnP](https://openpnp.org/) (provides the Nashorn JavaScript scripting environment that runs `01_Scan_TopCamera_Rectangle.js`).
  - Python 3.9+ with the packages in `requirements.txt`:
    ```bash
    pip install -r requirements.txt
    ```

---

## Running a scan

The scan is launched from within OpenPnP (Scripts menu), which then drives the Python helpers automatically. Roughly:

1. **Open the control panel** (optional but recommended) so you can pause/halt and watch detections:
   ```bash
   python3 00_Halt_Control.py
   ```
2. **Enable bug mode** — the detector defaults to a "resistor" profile for its PCB heritage. Create `control/bug_detector.flag` to switch `02_Segment_Scan_Objects.py` into insect-detection mode.
3. **Run `01_Scan_TopCamera_Rectangle.js` from OpenPnP.** It will:
   - create a timestamped `scans/scan_YYYYMMDD_HHMMSS/` directory,
   - raster the top camera over the scan area and write `frames/` + `manifest.jsonl`,
   - launch `02_Segment_Scan_Objects.py --watch` to detect insects as frames arrive,
   - read back `objects.jsonl` and pick / inspect / place each target,
   - call `03_QA_Inspect_Image.py` for well and nozzle checks along the way.

You can run the detector by hand against a finished scan for tuning or re-processing:

```bash
python3 02_Segment_Scan_Objects.py scans/scan_YYYYMMDD_HHMMSS --detector bug
```

### Dry-run and interactive modes

The scan script honors several optional flag files in `control/` so you can rehearse and calibrate safely:

| Flag file | Effect |
|-----------|--------|
| `control/pause.flag` | Pause before the next machine move (created/removed by the control panel). |
| `control/stop.flag` | Halt the run cleanly before the next move. |
| `control/bug_detector.flag` | Use the insect detector instead of the resistor profile. |
| `control/pick_dry_run.flag` | Move above the first target only — no descent, vacuum, or placement. |
| `control/touch_dry_run.flag` | Move above the first target and open a calibration window to record the true nozzle position. |
| `control/interactive_pick.flag` | Step through each target with a review window (skip / correct / switch nozzle / save jogged position). |

---

## How the pieces communicate

All inter-process coordination happens through files (no sockets/servers), which makes the system easy to inspect and debug.

**`control/` (shared runtime state, git-ignored):**

- `scan_status.json` — current scan state: status, frame index, total frames, message, timestamp.
- `detection_status.json` — live detection feed for the GUI: latest target, counts, centroid, score, preview image path, vacuum/QA details.
- `latest_detection_overlay.png` — downscaled preview of the most recent annotated frame.
- `*.flag` — the pause/stop/dry-run/mode toggles listed above.
- `touch_calibration.jsonl` — append-only log of nozzle position corrections (used to fine-tune pick accuracy).
- `*.out.log` / `*.err.log` — captured output from the launched Python helpers.

**`scans/scan_YYYYMMDD_HHMMSS/` (per-run outputs, git-ignored):**

- `frames/` + `manifest.jsonl` — raw scan frames and their machine coordinates / pixel calibration.
- `objects.jsonl` / `objects.csv` — deduplicated detected insects with pick coordinates, bounding boxes, and scores.
- `all_candidates.jsonl` — raw pre-deduplication detections (for debugging).
- `overlays/`, `objects/` — annotated frames and per-target crops.
- `detection_summary.png` — a contact-sheet of all unique targets.
- `segmentation_complete.json` — final detection summary.
- `bottom_inspections/`, `qa/` — bottom-camera nozzle photos and well-verification images plus their QA JSON results.

> Both `control/` and `scans/` are listed in `.gitignore` — they are generated at runtime and not committed.

---

## Key parameters

These are defined near the top of the respective scripts and will need adjusting for your machine's calibration and tray layout.

**Scan / motion (`01_Scan_TopCamera_Rectangle.js`):**
- Scan area `xLeft`/`xRight`/`yTop`/`yBottom` and grid `xStepMm`/`yStepMm` (overlapping frames).
- Camera mounting offsets (`cameraXOffsetMm`, `cameraYOffsetMm`) relative to the nozzle.
- Pick/drop Z heights derived from a touch-calibration value; per-attempt retry depth.
- Vacuum "part present" pressure window (used by `vacuumIndicatesPartOn()`).
- 96-well plate origin (A1 location) and 9 mm well pitch.
- Cross-frame deduplication radius (default 6 mm).

**Detection (`02_Segment_Scan_Objects.py`):**
- `--detector {bug,resistor}` and contour filters: area limits, rectangularity, aspect ratio, brightness, and background contrast.
- A pink-exclusion mask to ignore colored calibration/witness marks.
- `GLOBAL_DEDUPE_DISTANCE_MM` (6 mm) and the image-Y-inverted coordinate transform (`image_y_inverted_v2`).

**QA (`03_QA_Inspect_Image.py`):**
- `--mode {well,nozzle}` with separate dark-area / dark-fraction thresholds for "well occupied" vs. "bug stuck on nozzle."

---

## License

This project is licensed under the **GNU General Public License v3.0** — see [LICENSE](LICENSE). This is consistent with the open-source heritage of the LumenPnP and OpenPnP projects it builds on.
