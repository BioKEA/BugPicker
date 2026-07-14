#!/usr/bin/env python
"""00: Launch the Python 3 halt-control GUI from OpenPnP or a shell.

OpenPnP may parse .py scripts with Jython, which cannot read modern Python 3
syntax such as annotations. Keep this file Python 2/Jython compatible and put
the Tkinter GUI implementation in halt_control_gui.py.
"""

import os
import subprocess
import sys


def script_dir():
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except NameError:
        return os.getcwd()


def candidate_pythons(base_dir):
    project_dir = project_root(base_dir)
    return [
        os.path.join(project_dir, ".venv", "bin", "python"),
        "/home/sean/Documents/OpenInvert-PnP/.venv/bin/python",
        "python3",
    ]


def find_python(base_dir):
    for python in candidate_pythons(base_dir):
        if os.path.isabs(python) and not os.path.exists(python):
            continue
        return python
    return "python3"


def running_on_jython():
    return sys.platform.startswith("java") or "java" in sys.platform.lower()


def project_root(base_dir):
    parent = os.path.dirname(base_dir)
    if os.path.basename(base_dir) == "BugPicker" and os.path.basename(parent) == "scripts":
        return os.path.dirname(parent)
    return parent


def launch_external_gui(base_dir, gui_script):
    python = find_python(base_dir)
    root_dir = project_root(base_dir)
    control_dir = os.path.join(root_dir, "control")
    if not os.path.isdir(control_dir):
        os.makedirs(control_dir)
    stdout_log = os.path.join(control_dir, "halt_gui.out.log")
    stderr_log = os.path.join(control_dir, "halt_gui.err.log")

    stdout = open(stdout_log, "ab")
    stderr = open(stderr_log, "ab")
    try:
        subprocess.Popen([python, gui_script], cwd=root_dir, stdout=stdout, stderr=stderr)
    finally:
        stdout.close()
        stderr.close()

    print("Launched halt control GUI with " + python)
    print("Logs: " + stdout_log + " / " + stderr_log)


def main():
    base_dir = script_dir()
    gui_script = os.path.join(base_dir, "halt_control_gui.py")

    if running_on_jython():
        launch_external_gui(base_dir, gui_script)
        return 0

    sys.path.insert(0, base_dir)
    import halt_control_gui

    return halt_control_gui.main()


if __name__ == "__main__":
    sys.exit(main())
