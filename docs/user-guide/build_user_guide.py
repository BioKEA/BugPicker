#!/usr/bin/env python3
"""Build and validate the maintainable BugPicker operator guide."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import re
import shutil
import subprocess
from pathlib import Path

GUIDE_DIR = Path(__file__).resolve().parent
REPO_DIR = GUIDE_DIR.parent.parent
SOURCE = GUIDE_DIR / "source.html"
ASSETS = GUIDE_DIR / "assets"
OUTPUT_DIR = GUIDE_DIR / "dist"
IMAGE_TOKEN = re.compile(r"\{\{IMAGE:([^|}]+)\|([^}]+)\}\}")


def render_image(match: re.Match[str]) -> str:
    filename = match.group(1).strip()
    caption = match.group(2).strip()
    if (ASSETS / filename).exists():
        return ('<figure><img src="../assets/{name}" alt="{caption}">'
                '<figcaption>{caption}</figcaption></figure>').format(
                    name=html.escape(filename), caption=html.escape(caption))
    return ('<figure class="image-needed"><div><strong>IMAGE NEEDED</strong>'
            '<span>{name}</span></div><figcaption>{caption}</figcaption></figure>').format(
                name=html.escape(filename), caption=html.escape(caption))


def launcher_names() -> list[str]:
    return sorted(path.name for path in (REPO_DIR / "00_Run_BugPicker").glob("RUN_*.js"))


def build_html() -> tuple[Path, list[str]]:
    source = SOURCE.read_text(encoding="utf-8")
    undocumented = [name for name in launcher_names() if f"<code>{name}</code>" not in source]
    if undocumented:
        raise SystemExit("Guide is missing launcher documentation: " + ", ".join(undocumented))
    missing = sorted({match.group(1).strip() for match in IMAGE_TOKEN.finditer(source)
                      if not (ASSETS / match.group(1).strip()).exists()})
    rendered = source.replace("{{BUILD_DATE}}", dt.datetime.now().astimezone().strftime("%B %-d, %Y"))
    rendered = IMAGE_TOKEN.sub(render_image, rendered)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output = OUTPUT_DIR / "BugPicker_User_Guide.html"
    output.write_text(rendered, encoding="utf-8")
    return output, missing


def build_pdf(html_file: Path) -> Path | None:
    chrome = shutil.which("google-chrome") or shutil.which("chromium")
    if chrome is None:
        return None
    output = OUTPUT_DIR / "BugPicker_User_Guide.pdf"
    subprocess.run([
        chrome, "--headless", "--no-sandbox", "--disable-gpu",
        "--allow-file-access-from-files", f"--print-to-pdf={output.resolve()}",
        "--no-pdf-header-footer", html_file.resolve().as_uri(),
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-pdf", action="store_true", help="Build and validate HTML only")
    args = parser.parse_args()
    html_file, missing = build_html()
    print(f"Built {html_file}")
    if missing:
        print("Image placeholders remaining:")
        for filename in missing:
            print(f"  - {filename}")
    if not args.no_pdf:
        pdf_file = build_pdf(html_file)
        print(f"Built {pdf_file}" if pdf_file else "Chrome was not found; PDF was not generated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
