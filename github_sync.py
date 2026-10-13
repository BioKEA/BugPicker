#!/usr/bin/env python3
"""Credential-safe GitHub backup/update helper for OpenPnP launchers."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

ACTIVE_MODELS = {
    "Data/insect_debris_classifier.pt",
    "Data/taxonomy_classifier.pt",
    "Data/qa_feedback/models/nozzle_qa_classifier.pt",
    "Data/qa_feedback/models/well_qa_classifier.pt",
}
SOURCE_SUFFIXES = {".js", ".py", ".md", ".txt", ".html", ".json"}


def run(repo: Path, command: list[str], env: dict[str, str], check: bool = True):
    print("Running: " + " ".join(command), flush=True)
    result = subprocess.run(
        command, cwd=repo, env=env, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if result.stdout:
        print(result.stdout.rstrip(), flush=True)
    if check and result.returncode:
        raise RuntimeError(
            f"Command failed with exit code {result.returncode}: {' '.join(command)}"
        )
    return result


def changed_paths(repo: Path, env: dict[str, str]) -> list[str]:
    result = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z"], cwd=repo, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
    )
    entries = result.stdout.decode("utf-8", errors="replace").split("\0")
    paths: list[str] = []
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if not entry:
            continue
        status, path = entry[:2], entry[3:]
        if status[0] in {"R", "C"} and index < len(entries):
            path = entries[index]
            index += 1
        paths.append(path)
    return paths


def is_source_path(path: str) -> bool:
    if path == ".gitignore":
        return True
    if path.startswith(("Data/", "archives/")):
        return False
    return Path(path).suffix.lower() in SOURCE_SUFFIXES


def auth_environment(username: str, token: str, temp_dir: Path) -> dict[str, str]:
    askpass = temp_dir / "github-askpass.sh"
    askpass.write_text(
        "#!/bin/sh\n"
        "case \"$1\" in\n"
        "  *Username*) printf '%s\\n' \"$BUGPICKER_GITHUB_USER\" ;;\n"
        "  *) printf '%s\\n' \"$BUGPICKER_GITHUB_TOKEN\" ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    askpass.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    env = os.environ.copy()
    env.update({
        "GIT_ASKPASS": str(askpass),
        "GIT_TERMINAL_PROMPT": "0",
        "BUGPICKER_GITHUB_USER": username,
        "BUGPICKER_GITHUB_TOKEN": token,
    })
    return env


def branch_name(repo: Path, env: dict[str, str]) -> str:
    result = subprocess.run(
        ["git", "branch", "--show-current"], cwd=repo, env=env, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
    )
    branch = result.stdout.strip()
    if not branch:
        raise RuntimeError("Git is not currently on a named branch.")
    return branch


def backup(repo: Path, env: dict[str, str], message: str, include_models: bool):
    if run(repo, ["git", "diff", "--cached", "--quiet"], env, check=False).returncode:
        raise RuntimeError(
            "Files are already staged. Commit or unstage them before running GitHub Backup."
        )
    changed = set(changed_paths(repo, env))
    source_paths = sorted(path for path in changed if is_source_path(path))
    model_paths = sorted(
        path for path in changed
        if include_models and path in ACTIVE_MODELS and (repo / path).exists()
    )
    if source_paths or model_paths:
        print("Staging files:", flush=True)
        for path in source_paths + model_paths:
            print(f"  {path}", flush=True)
        if source_paths:
            run(repo, ["git", "add", "-A", "--", *source_paths], env)
        if model_paths:
            run(repo, ["git", "add", "-f", "--", *model_paths], env)
    else:
        print("No eligible source or model changes need staging.", flush=True)
    if run(repo, ["git", "diff", "--cached", "--quiet"], env, check=False).returncode:
        run(repo, ["git", "commit", "-m", message], env)
    else:
        print("No new commit was created.", flush=True)
    branch = branch_name(repo, env)
    run(repo, ["git", "pull", "--rebase", "--autostash", "origin", branch], env)
    run(repo, ["git", "push", "origin", branch], env)
    print("GitHub backup completed successfully.", flush=True)


def update(repo: Path, env: dict[str, str]):
    changes = changed_paths(repo, env)
    if changes:
        preview = "\n".join(f"  {path}" for path in changes[:20])
        extra = "" if len(changes) <= 20 else f"\n  ...and {len(changes) - 20} more"
        raise RuntimeError(
            "Local changes are present, so GitHub Update stopped without changing anything.\n"
            "Run GitHub Backup first or resolve these files manually:\n" + preview + extra
        )
    branch = branch_name(repo, env)
    run(repo, ["git", "fetch", "origin", branch], env)
    run(repo, ["git", "merge", "--ff-only", f"origin/{branch}"], env)
    print("GitHub update completed successfully.", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("backup", "update"))
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--username", required=True)
    parser.add_argument("--message", default="Update BugPicker programs")
    parser.add_argument("--include-models", action="store_true")
    args = parser.parse_args()
    token = sys.stdin.readline().rstrip("\r\n")
    if not token:
        raise RuntimeError("A GitHub personal access token is required.")
    repo = args.repo.resolve()
    if not (repo / ".git").exists():
        raise RuntimeError(f"Not a Git repository: {repo}")
    with tempfile.TemporaryDirectory(prefix="bugpicker-github-") as temp:
        env = auth_environment(args.username, token, Path(temp))
        if args.mode == "backup":
            backup(repo, env, args.message, args.include_models)
        else:
            update(repo, env)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
