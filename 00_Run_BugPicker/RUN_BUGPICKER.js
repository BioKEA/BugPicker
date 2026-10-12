/**
 * Main BugPicker entry point.
 *
 * Run this script from OpenPnP.
 * The numbered files in this folder are implementation helpers and diagnostics.
 */

var bugPickerRoot = new java.io.File(scripting.getScriptsDirectory().toString(), 'BugPicker');
if (!bugPickerRoot.exists()) {
    bugPickerRoot = new java.io.File(scripting.getScriptsDirectory().toString());
}

load(new java.io.File(bugPickerRoot, '01_Scan_TopCamera_Rectangle.js').getAbsolutePath());
