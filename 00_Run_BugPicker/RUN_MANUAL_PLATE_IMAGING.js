/** Image a plate that was filled by hand. */

var bugPickerRunMode = 'manual_plate_imaging';
var bugPickerRoot = new java.io.File(scripting.getScriptsDirectory().toString(), 'BugPicker');
if (!bugPickerRoot.exists()) {
    bugPickerRoot = new java.io.File(scripting.getScriptsDirectory().toString());
}

load(new java.io.File(bugPickerRoot, '01_Scan_TopCamera_Rectangle.js').getAbsolutePath());
