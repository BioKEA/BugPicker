/**
 * 01: Scan the predefined rectangle with the Top camera and save images.
 *
 * Area:
 *   X 361 to 411
 *   Y 208 to 319
 *
 * Output:
 *   <OpenPnP config>/scans/<scan_id>/
 *     frames/*.png
 *     manifest.jsonl
 *
 * Cooperative pause/resume/halt:
 *   If <OpenPnP config>/control/pause.flag exists, the
 *   scan pauses before the next move. Clearing the flag resumes the same run.
 *   If <OpenPnP config>/control/stop.flag exists, the
 *   scan exits before the next move.
 *   The halt control GUI is launched automatically at scan start.
 */

load(scripting.getScriptsDirectory().toString() + '/Examples/JavaScript/Utility.js');

var imports = new JavaImporter(org.openpnp.model, java.io, javax.imageio, javax.swing, java.awt);

with (imports) {
    var scriptsRootDir = new File(scripting.getScriptsDirectory().toString());
    var scriptsDir = scriptsRootDir.getName() === 'BugPicker'
        ? scriptsRootDir
        : new File(scriptsRootDir, 'BugPicker');
    if (!scriptsDir.exists()) {
        scriptsDir = scriptsRootDir;
    }
    var projectDir = scriptsRootDir.getName() === 'BugPicker'
        && scriptsRootDir.getParentFile() !== null
        && scriptsRootDir.getParentFile().getName() === 'scripts'
        ? scriptsRootDir.getParentFile().getParentFile()
        : scriptsRootDir.getParentFile();
    var scriptLocalPython = new File(scriptsDir, '.venv/bin/python');
    var projectLocalPython = new File(projectDir, '.venv/bin/python');
    var previousPython = new File('/home/sean/Documents/OpenInvert-PnP/.venv/bin/python');
    var python = scriptLocalPython.exists()
        ? scriptLocalPython.getAbsolutePath()
        : projectLocalPython.exists()
        ? projectLocalPython.getAbsolutePath()
        : previousPython.exists()
        ? previousPython.getAbsolutePath()
        : 'python3';
    var currentCoordinateTransformVersion = 'image_y_inverted_v2';
    var hiResCameraName = 'OpenPnP Capture Camera HiRes';
    var hiResFocusCenterZ = -1.3;
    var hiResFocusFastStepMm = 0.5;
    var hiResMinimumZ = -3.0;
    var hiResLightDevice = '';
    var hiResLightControl = '';
    var hiResLightOnValue = '1';
    var hiResLightOffValue = '0';
    var pickerMinimumXmm = 0.0;
    var pickerMaximumXmm = 433.0;
    var pickerXLimitMarginMm = 0.25;
    var pickerN1HeadOffsetXmm = 23.0;

    function pad(number, width) {
        var text = String(number);
        while (text.length < width) {
            text = '0' + text;
        }
        return text;
    }

    function timestamp() {
        var now = new Date();
        return now.getFullYear()
            + pad(now.getMonth() + 1, 2)
            + pad(now.getDate(), 2)
            + '_'
            + pad(now.getHours(), 2)
            + pad(now.getMinutes(), 2)
            + pad(now.getSeconds(), 2);
    }

    function positions(start, stop, step, descending) {
        var values = [];
        var epsilon = 0.000001;

        if (descending) {
            for (var value = start; value >= stop + epsilon; value -= step) {
                values.push(value);
            }
            if (values.length === 0 || Math.abs(values[values.length - 1] - stop) > epsilon) {
                values.push(stop);
            }
        }
        else {
            for (var value = start; value <= stop - epsilon; value += step) {
                values.push(value);
            }
            if (values.length === 0 || Math.abs(values[values.length - 1] - stop) > epsilon) {
                values.push(stop);
            }
        }

        return values;
    }

    function jsonLine(frameIndex, fileName, x, y, requestedX, requestedY, width, height, unitsPerPixel, context) {
        var record = {
            frame_index: frameIndex,
            file_name: fileName,
            camera: 'Top',
            x_mm: x,
            y_mm: y,
            requested_x_mm: requestedX,
            requested_y_mm: requestedY,
            image_width_px: width,
            image_height_px: height,
            units_per_pixel_x_mm: unitsPerPixel.x,
            units_per_pixel_y_mm: unitsPerPixel.y
        };
        if (context) {
            for (var key in context) {
                if (context.hasOwnProperty(key)) {
                    record[key] = context[key];
                }
            }
        }
        return JSON.stringify(record) + '\n';
    }

    function formatLocation(location) {
        return 'X=' + location.x.toFixed(3)
            + ' Y=' + location.y.toFixed(3)
            + ' Z=' + location.z.toFixed(3)
            + ' R=' + location.rotation.toFixed(3);
    }

    function getUnitsPerPixelForCurrentZ(camera) {
        try {
            return camera.getUnitsPerPixelAtZ();
        }
        catch (error) {
            return camera.getUnitsPerPixel();
        }
    }

    function findCameraByName(name) {
        function cameraMatches(camera) {
            return camera && String(camera.getName()) === name;
        }

        try {
            if (cameraMatches(machine.defaultHead.defaultCamera)) {
                return machine.defaultHead.defaultCamera;
            }
        }
        catch (defaultError) {
            print('Could not check default head camera for ' + name + ': ' + defaultError);
        }

        try {
            var headCameras = machine.defaultHead.getCameras();
            for (var headIndex = 0; headIndex < headCameras.size(); headIndex++) {
                var headCamera = headCameras.get(headIndex);
                if (cameraMatches(headCamera)) {
                    return headCamera;
                }
            }
        }
        catch (headError) {
            print('Could not enumerate head cameras while looking for ' + name + ': ' + headError);
        }

        try {
            var machineCameras = machine.getCameras();
            for (var machineIndex = 0; machineIndex < machineCameras.size(); machineIndex++) {
                var machineCamera = machineCameras.get(machineIndex);
                if (cameraMatches(machineCamera)) {
                    return machineCamera;
                }
            }
        }
        catch (machineError) {
            print('Could not enumerate machine cameras while looking for ' + name + ': ' + machineError);
        }

        throw new Error('Camera not found: ' + name);
    }

    function allCameraNames() {
        var names = [];

        function addCamera(camera) {
            if (camera) {
                names.push(String(camera.getName()));
            }
        }

        try {
            addCamera(machine.defaultHead.defaultCamera);
        }
        catch (defaultError) {
        }
        try {
            var headCameras = machine.defaultHead.getCameras();
            for (var headIndex = 0; headIndex < headCameras.size(); headIndex++) {
                addCamera(headCameras.get(headIndex));
            }
        }
        catch (headError) {
        }
        try {
            var machineCameras = machine.getCameras();
            for (var machineIndex = 0; machineIndex < machineCameras.size(); machineIndex++) {
                addCamera(machineCameras.get(machineIndex));
            }
        }
        catch (machineError) {
        }
        return names;
    }

    function findHiResCamera() {
        var preferredNames = [
            hiResCameraName,
            'OpenPnP Capture Camera HiRes',
            'OpenPnpCaptureCamera',
            'OpenPnP Capture Camera',
            'HiRes'
        ];
        for (var i = 0; i < preferredNames.length; i++) {
            try {
                var camera = findCameraByName(preferredNames[i]);
                print('HiRes camera resolved as "' + camera.getName() + '".');
                return camera;
            }
            catch (error) {
            }
        }

        var availableNames = allCameraNames();
        throw new Error('HiRes camera not found. Tried: '
            + preferredNames.join(', ')
            + '. Available cameras: '
            + (availableNames.length === 0 ? '(none found)' : availableNames.join(', ')));
    }

    function setHiResLight(on) {
        if (!hiResLightDevice || !hiResLightControl) {
            return;
        }
        var value = on ? hiResLightOnValue : hiResLightOffValue;
        try {
            var process = new Packages.java.lang.ProcessBuilder(
                'v4l2-ctl',
                '-d',
                hiResLightDevice,
                '--set-ctrl=' + hiResLightControl + '=' + value
            ).start();
            var exitCode = process.waitFor();
            if (exitCode !== 0) {
                print('HiRes light control failed with exit ' + exitCode
                    + ' for ' + hiResLightControl + '=' + value);
            }
        }
        catch (error) {
            print('HiRes light control unavailable: ' + error);
        }
    }

    function writeText(file, text) {
        var writer = new FileWriter(file);
        try {
            writer.write(text);
        }
        finally {
            writer.close();
        }
    }

    function readText(file) {
        var reader = new BufferedReader(new FileReader(file));
        var lines = [];
        try {
            var line = reader.readLine();
            while (line !== null) {
                lines.push(String(line));
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }
        return lines.join('\n');
    }

    function readNumber(record, key, fallback) {
        if (record[key] === undefined || record[key] === null || record[key] === '') {
            return fallback;
        }
        var value = Number(record[key]);
        if (isNaN(value)) {
            throw new Error('Calibration value is not numeric: ' + key + '=' + record[key]);
        }
        return value;
    }

    function trayHeightPresets() {
        return [
            {
                label: '12.5 mm tray - medium insects',
                trayHeightMm: 12.5,
                sizeClass: 'medium',
                pickZMm: -43.3
            },
            {
                label: 'Small insects',
                trayHeightMm: 12.5,
                sizeClass: 'small',
                pickZMm: -43.6
            },
            {
                label: 'Large insects',
                trayHeightMm: 12.5,
                sizeClass: 'large',
                pickZMm: -42.8
            }
        ];
    }

    function defaultTrayHeightPreset() {
        return trayHeightPresets()[0];
    }

    function findTrayHeightPresetIndex(calibration) {
        var presets = trayHeightPresets();
        for (var i = 0; i < presets.length; i++) {
            if (Math.abs(Number(calibration.pickZMm) - Number(presets[i].pickZMm)) < 0.001
                    && String(calibration.sizeClass) === String(presets[i].sizeClass)) {
                return i;
            }
        }
        return 0;
    }

    function defaultTrainingTrayCalibrationValues() {
        return {
            xLeft: 361.0,
            xRight: 411.0,
            yTop: 208.0,
            yBottom: 319.0,
            cameraXOffsetMm: -23.0,
            cameraYOffsetMm: 64.0,
            scanBoundsAreCameraCoordinates: false,
            xStepMm: 8.0,
            yStepMm: 5.0,
            plateA1X: 72.4,
            plateA1Y: 238.6,
            plateQaCameraA1X: 72.4,
            plateQaCameraA1Y: 238.6,
            hiResTrayOffsetX: 0.0,
            hiResTrayOffsetY: 0.0,
            hiResFocusZMm: hiResFocusCenterZ,
            recoveryPlateA1X: 93.0,
            recoveryPlateA1Y: 287.0,
            plateWellPitchMm: 9.0
        };
    }

    function loadTrainingTrayCalibration(defaults) {
        var localCalibrationFile = new File(scriptsDir, 'training_tray_calibration.json');
        var controlCalibrationFile = new File(projectDir, 'control/training_tray_calibration.json');
        var calibrationFile = localCalibrationFile.exists() ? localCalibrationFile : controlCalibrationFile;
        var multiCalibrationFile = multiTrayCalibrationFile();
        var defaultPreset = defaultTrayHeightPreset();
        var calibration = {
            xLeft: defaults.xLeft,
            xRight: defaults.xRight,
            yTop: defaults.yTop,
            yBottom: defaults.yBottom,
            cameraXOffsetMm: defaults.cameraXOffsetMm,
            cameraYOffsetMm: defaults.cameraYOffsetMm,
            scanBoundsAreCameraCoordinates: defaults.scanBoundsAreCameraCoordinates,
            xStepMm: defaults.xStepMm,
            yStepMm: defaults.yStepMm,
            trayHeightMm: defaultPreset.trayHeightMm,
            sizeClass: defaultPreset.sizeClass,
            pickZMm: defaultPreset.pickZMm,
            plateA1X: defaults.plateA1X,
            plateA1Y: defaults.plateA1Y,
            plateQaCameraA1X: defaults.plateQaCameraA1X,
            plateQaCameraA1Y: defaults.plateQaCameraA1Y,
            hiResTrayOffsetX: defaults.hiResTrayOffsetX,
            hiResTrayOffsetY: defaults.hiResTrayOffsetY,
            hiResFocusZMm: defaults.hiResFocusZMm,
            recoveryPlateA1X: defaults.recoveryPlateA1X,
            recoveryPlateA1Y: defaults.recoveryPlateA1Y,
            plateWellPitchMm: defaults.plateWellPitchMm,
            source: 'built-in defaults'
        };

        if (!calibrationFile.exists()) {
            return calibration;
        }

        var record = JSON.parse(readText(calibrationFile));
        calibration.xLeft = readNumber(record, 'x_left_mm', calibration.xLeft);
        calibration.xRight = readNumber(record, 'x_right_mm', calibration.xRight);
        calibration.yTop = readNumber(record, 'y_top_mm', calibration.yTop);
        calibration.yBottom = readNumber(record, 'y_bottom_mm', calibration.yBottom);
        calibration.cameraXOffsetMm = readNumber(record, 'camera_x_offset_mm', calibration.cameraXOffsetMm);
        calibration.cameraYOffsetMm = readNumber(record, 'camera_y_offset_mm', calibration.cameraYOffsetMm);
        calibration.scanBoundsAreCameraCoordinates = record.scan_bounds_are_camera_coordinates === undefined
            ? calibration.scanBoundsAreCameraCoordinates
            : Boolean(record.scan_bounds_are_camera_coordinates);
        calibration.xStepMm = readNumber(record, 'x_step_mm', calibration.xStepMm);
        calibration.yStepMm = readNumber(record, 'y_step_mm', calibration.yStepMm);
        calibration.trayHeightMm = readNumber(record, 'tray_height_mm', calibration.trayHeightMm);
        calibration.sizeClass = record.size_class === undefined ? calibration.sizeClass : String(record.size_class);
        calibration.pickZMm = readNumber(record, 'pick_z_mm', calibration.pickZMm);
        calibration.plateA1X = readNumber(record, 'plate_a1_x_mm', calibration.plateA1X);
        calibration.plateA1Y = readNumber(record, 'plate_a1_y_mm', calibration.plateA1Y);
        calibration.plateQaCameraA1X = readNumber(record, 'plate_qa_camera_a1_x_mm', calibration.plateA1X);
        calibration.plateQaCameraA1Y = readNumber(record, 'plate_qa_camera_a1_y_mm', calibration.plateA1Y);
        calibration.hiResTrayOffsetX = readNumber(record, 'hires_tray_offset_x_mm', calibration.hiResTrayOffsetX);
        calibration.hiResTrayOffsetY = readNumber(record, 'hires_tray_offset_y_mm', calibration.hiResTrayOffsetY);
        calibration.hiResFocusZMm = readNumber(record, 'hires_focus_z_mm', calibration.hiResFocusZMm);
        calibration.recoveryPlateA1X = readNumber(record, 'recovery_plate_a1_x_mm', calibration.recoveryPlateA1X);
        calibration.recoveryPlateA1Y = readNumber(record, 'recovery_plate_a1_y_mm', calibration.recoveryPlateA1Y);
        calibration.plateWellPitchMm = readNumber(record, 'plate_well_pitch_mm', calibration.plateWellPitchMm);
        calibration.source = calibrationFile.getAbsolutePath();
        if (multiCalibrationFile.exists()) {
            var multiRecord = JSON.parse(readText(multiCalibrationFile));
            calibration.multiConfig = normalizeMultiTrayCalibration(multiRecord, calibration);
            applyPrimaryMultiSlotToSingleCalibration(calibration, calibration.multiConfig);
            calibration.source = multiCalibrationFile.getAbsolutePath();
        }
        return calibration;
    }

    function trainingTrayCalibrationFile() {
        return new File(scriptsDir, 'training_tray_calibration.json');
    }

    function multiTrayCalibrationFile() {
        return new File(scriptsDir, 'multitray_calibration.json');
    }

    function clonePlainObject(record) {
        return JSON.parse(JSON.stringify(record));
    }

    function multiSlotByNumber(records, slotName, slotNumber) {
        if (!records) {
            return null;
        }
        for (var i = 0; i < records.length; i++) {
            if (Number(records[i][slotName]) === Number(slotNumber)) {
                return records[i];
            }
        }
        return null;
    }

    function defaultMultiTrayCalibration(singleCalibration) {
        var base = singleCalibration || loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        return {
            schema_version: 2,
            active_collection_event_count: 1,
            active_sorting_tray_count: 1,
            active_plate_count: 1,
            active_recovery_plate_count: 1,
            shared: {
                camera_x_offset_mm: Number(base.cameraXOffsetMm),
                camera_y_offset_mm: Number(base.cameraYOffsetMm),
                scan_bounds_are_camera_coordinates: Boolean(base.scanBoundsAreCameraCoordinates),
                x_step_mm: Number(base.xStepMm),
                y_step_mm: Number(base.yStepMm),
                plate_well_pitch_mm: Number(base.plateWellPitchMm),
                hires_tray_offset_x_mm: Number(base.hiResTrayOffsetX),
                hires_tray_offset_y_mm: Number(base.hiResTrayOffsetY),
                hires_focus_z_mm: Number(base.hiResFocusZMm),
                debris_classifier_mode: 'train',
                taxonomy_classifier_mode: 'train',
                auto_replate: false
            },
            collection_events: [
                { event_slot: 1, enabled: true, collection_code: '', plate_slot: 1, recovery_slot: 1 },
                { event_slot: 2, enabled: false, collection_code: '', plate_slot: 2, recovery_slot: 2 }
            ],
            sorting_trays: [
                {
                    tray_slot: 1,
                    enabled: true,
                    collection_event_slot: 1,
                    x_left_mm: Number(base.xLeft),
                    x_right_mm: Number(base.xRight),
                    y_top_mm: Number(base.yTop),
                    y_bottom_mm: Number(base.yBottom),
                    tray_height_mm: Number(base.trayHeightMm),
                    size_class: String(base.sizeClass),
                    pick_z_mm: Number(base.pickZMm)
                },
                {
                    tray_slot: 2,
                    enabled: false,
                    collection_event_slot: 1,
                    x_left_mm: Number(base.xLeft),
                    x_right_mm: Number(base.xRight),
                    y_top_mm: Number(base.yTop),
                    y_bottom_mm: Number(base.yBottom),
                    tray_height_mm: Number(base.trayHeightMm),
                    size_class: String(base.sizeClass),
                    pick_z_mm: Number(base.pickZMm)
                },
                {
                    tray_slot: 3,
                    enabled: false,
                    collection_event_slot: 1,
                    x_left_mm: Number(base.xLeft),
                    x_right_mm: Number(base.xRight),
                    y_top_mm: Number(base.yTop),
                    y_bottom_mm: Number(base.yBottom),
                    tray_height_mm: Number(base.trayHeightMm),
                    size_class: String(base.sizeClass),
                    pick_z_mm: Number(base.pickZMm)
                },
                {
                    tray_slot: 4,
                    enabled: false,
                    collection_event_slot: 1,
                    x_left_mm: Number(base.xLeft),
                    x_right_mm: Number(base.xRight),
                    y_top_mm: Number(base.yTop),
                    y_bottom_mm: Number(base.yBottom),
                    tray_height_mm: Number(base.trayHeightMm),
                    size_class: String(base.sizeClass),
                    pick_z_mm: Number(base.pickZMm)
                }
            ],
            plates: [
                {
                    plate_slot: 1,
                    enabled: true,
                    plate_number: 'AA0001',
                    start_well: 'A1',
                    plate_a1_x_mm: Number(base.plateA1X),
                    plate_a1_y_mm: Number(base.plateA1Y),
                    top_camera_a1_x_mm: Number(base.plateA1X) + Number(base.cameraXOffsetMm),
                    top_camera_a1_y_mm: Number(base.plateA1Y) + Number(base.cameraYOffsetMm),
                    plate_qa_camera_a1_x_mm: Number(base.plateQaCameraA1X),
                    plate_qa_camera_a1_y_mm: Number(base.plateQaCameraA1Y)
                },
                {
                    plate_slot: 2,
                    enabled: false,
                    plate_number: 'AA0002',
                    start_well: 'A1',
                    plate_a1_x_mm: Number(base.plateA1X),
                    plate_a1_y_mm: Number(base.plateA1Y),
                    top_camera_a1_x_mm: Number(base.plateA1X) + Number(base.cameraXOffsetMm),
                    top_camera_a1_y_mm: Number(base.plateA1Y) + Number(base.cameraYOffsetMm),
                    plate_qa_camera_a1_x_mm: Number(base.plateQaCameraA1X),
                    plate_qa_camera_a1_y_mm: Number(base.plateQaCameraA1Y)
                }
            ],
            recovery_plates: [
                {
                    recovery_slot: 1,
                    enabled: true,
                    recovery_plate_a1_x_mm: Number(base.recoveryPlateA1X),
                    recovery_plate_a1_y_mm: Number(base.recoveryPlateA1Y)
                },
                {
                    recovery_slot: 2,
                    enabled: false,
                    recovery_plate_a1_x_mm: Number(base.recoveryPlateA1X),
                    recovery_plate_a1_y_mm: Number(base.recoveryPlateA1Y)
                }
            ]
        };
    }

    function normalizeMultiTrayCalibration(record, singleCalibration) {
        var normalized = defaultMultiTrayCalibration(singleCalibration);
        if (!record) {
            return normalized;
        }
        normalized.schema_version = 2;
        normalized.active_collection_event_count = Math.max(1, Math.min(2, Number(record.active_collection_event_count || 1)));
        normalized.active_sorting_tray_count = Math.max(1, Math.min(4, Number(record.active_sorting_tray_count || 1)));
        normalized.active_plate_count = Math.max(1, Math.min(2, Number(record.active_plate_count || normalized.active_collection_event_count)));
        normalized.active_recovery_plate_count = Math.max(1, Math.min(2, Number(record.active_recovery_plate_count || normalized.active_collection_event_count)));
        if (record.shared) {
            normalized.shared.camera_x_offset_mm = readNumber(record.shared, 'camera_x_offset_mm', normalized.shared.camera_x_offset_mm);
            normalized.shared.camera_y_offset_mm = readNumber(record.shared, 'camera_y_offset_mm', normalized.shared.camera_y_offset_mm);
            normalized.shared.scan_bounds_are_camera_coordinates = record.shared.scan_bounds_are_camera_coordinates === undefined
                ? normalized.shared.scan_bounds_are_camera_coordinates
                : Boolean(record.shared.scan_bounds_are_camera_coordinates);
            normalized.shared.x_step_mm = readNumber(record.shared, 'x_step_mm', normalized.shared.x_step_mm);
            normalized.shared.y_step_mm = readNumber(record.shared, 'y_step_mm', normalized.shared.y_step_mm);
            normalized.shared.plate_well_pitch_mm = readNumber(record.shared, 'plate_well_pitch_mm', normalized.shared.plate_well_pitch_mm);
            normalized.shared.hires_tray_offset_x_mm = readNumber(record.shared, 'hires_tray_offset_x_mm', normalized.shared.hires_tray_offset_x_mm);
            normalized.shared.hires_tray_offset_y_mm = readNumber(record.shared, 'hires_tray_offset_y_mm', normalized.shared.hires_tray_offset_y_mm);
            normalized.shared.hires_focus_z_mm = readNumber(record.shared, 'hires_focus_z_mm', normalized.shared.hires_focus_z_mm);
            normalized.shared.debris_classifier_mode = String(record.shared.debris_classifier_mode || normalized.shared.debris_classifier_mode);
            if (normalized.shared.debris_classifier_mode !== 'auto') {
                normalized.shared.debris_classifier_mode = 'train';
            }
            normalized.shared.taxonomy_classifier_mode = String(record.shared.taxonomy_classifier_mode || normalized.shared.taxonomy_classifier_mode);
            if (normalized.shared.taxonomy_classifier_mode !== 'auto') {
                normalized.shared.taxonomy_classifier_mode = 'train';
            }
            normalized.shared.auto_replate = Boolean(record.shared.auto_replate);
        }

        function mergeSlots(targetRecords, sourceRecords, slotName) {
            if (!sourceRecords) {
                return;
            }
            for (var i = 0; i < targetRecords.length; i++) {
                var source = multiSlotByNumber(sourceRecords, slotName, targetRecords[i][slotName]);
                if (source) {
                    for (var key in source) {
                        if (source.hasOwnProperty(key)) {
                            targetRecords[i][key] = source[key];
                        }
                    }
                }
            }
        }

        mergeSlots(normalized.collection_events, record.collection_events, 'event_slot');
        mergeSlots(normalized.sorting_trays, record.sorting_trays, 'tray_slot');
        mergeSlots(normalized.plates, record.plates, 'plate_slot');
        mergeSlots(normalized.recovery_plates, record.recovery_plates, 'recovery_slot');
        return normalized;
    }

    function applyPrimaryMultiSlotToSingleCalibration(calibration, multiConfig) {
        var tray = multiSlotByNumber(multiConfig.sorting_trays, 'tray_slot', 1);
        var plate = multiSlotByNumber(multiConfig.plates, 'plate_slot', 1);
        var recovery = multiSlotByNumber(multiConfig.recovery_plates, 'recovery_slot', 1);
        calibration.cameraXOffsetMm = Number(multiConfig.shared.camera_x_offset_mm);
        calibration.cameraYOffsetMm = Number(multiConfig.shared.camera_y_offset_mm);
        calibration.scanBoundsAreCameraCoordinates = Boolean(multiConfig.shared.scan_bounds_are_camera_coordinates);
        calibration.xStepMm = Number(multiConfig.shared.x_step_mm);
        calibration.yStepMm = Number(multiConfig.shared.y_step_mm);
        calibration.plateWellPitchMm = Number(multiConfig.shared.plate_well_pitch_mm);
        calibration.hiResTrayOffsetX = isNaN(Number(multiConfig.shared.hires_tray_offset_x_mm))
            ? 0.0
            : Number(multiConfig.shared.hires_tray_offset_x_mm);
        calibration.hiResTrayOffsetY = isNaN(Number(multiConfig.shared.hires_tray_offset_y_mm))
            ? 0.0
            : Number(multiConfig.shared.hires_tray_offset_y_mm);
        calibration.hiResFocusZMm = isNaN(Number(multiConfig.shared.hires_focus_z_mm))
            ? hiResFocusCenterZ
            : Number(multiConfig.shared.hires_focus_z_mm);
        if (tray) {
            calibration.xLeft = Number(tray.x_left_mm);
            calibration.xRight = Number(tray.x_right_mm);
            calibration.yTop = Number(tray.y_top_mm);
            calibration.yBottom = Number(tray.y_bottom_mm);
            calibration.trayHeightMm = Number(tray.tray_height_mm);
            calibration.sizeClass = String(tray.size_class);
            calibration.pickZMm = Number(tray.pick_z_mm);
        }
        if (plate) {
            calibration.plateA1X = Number(plate.plate_a1_x_mm);
            calibration.plateA1Y = Number(plate.plate_a1_y_mm);
            calibration.plateQaCameraA1X = Number(plate.plate_qa_camera_a1_x_mm);
            calibration.plateQaCameraA1Y = Number(plate.plate_qa_camera_a1_y_mm);
        }
        if (recovery) {
            calibration.recoveryPlateA1X = Number(recovery.recovery_plate_a1_x_mm);
            calibration.recoveryPlateA1Y = Number(recovery.recovery_plate_a1_y_mm);
        }
    }

    function writeTrainingTrayCalibration(calibration) {
        var record = {
            x_left_mm: calibration.xLeft,
            x_right_mm: calibration.xRight,
            y_top_mm: calibration.yTop,
            y_bottom_mm: calibration.yBottom,
            camera_x_offset_mm: calibration.cameraXOffsetMm,
            camera_y_offset_mm: calibration.cameraYOffsetMm,
            scan_bounds_are_camera_coordinates: calibration.scanBoundsAreCameraCoordinates,
            x_step_mm: calibration.xStepMm,
            y_step_mm: calibration.yStepMm,
            tray_height_mm: calibration.trayHeightMm,
            size_class: calibration.sizeClass,
            pick_z_mm: calibration.pickZMm,
            plate_a1_x_mm: calibration.plateA1X,
            plate_a1_y_mm: calibration.plateA1Y,
            plate_qa_camera_a1_x_mm: calibration.plateQaCameraA1X,
            plate_qa_camera_a1_y_mm: calibration.plateQaCameraA1Y,
            hires_tray_offset_x_mm: calibration.hiResTrayOffsetX,
            hires_tray_offset_y_mm: calibration.hiResTrayOffsetY,
            hires_focus_z_mm: calibration.hiResFocusZMm,
            recovery_plate_a1_x_mm: calibration.recoveryPlateA1X,
            recovery_plate_a1_y_mm: calibration.recoveryPlateA1Y,
            plate_well_pitch_mm: calibration.plateWellPitchMm
        };
        var file = trainingTrayCalibrationFile();
        writeText(file, JSON.stringify(record, null, 2) + '\n');
        if (calibration.multiConfig) {
            writeText(multiTrayCalibrationFile(), JSON.stringify(calibration.multiConfig, null, 2) + '\n');
            print('Saved multi-tray calibration: ' + multiTrayCalibrationFile().getAbsolutePath());
        }
        calibration.source = file.getAbsolutePath();
        print('Saved training tray calibration: ' + calibration.source);
    }

    function numberFieldValue(field, name) {
        var value = Number(String(field.getText()).trim());
        if (isNaN(value)) {
            throw new Error(name + ' must be a number.');
        }
        return value;
    }

    function selectedOneBasedIndex(comboBox) {
        return Number(comboBox.getSelectedIndex()) + 1;
    }

    function promptForMultiRunSetup(calibration) {
        var ActionListener = Packages.java.awt.event.ActionListener;
        var JComboBox = Packages.javax.swing.JComboBox;
        var DefaultComboBoxModel = Packages.javax.swing.DefaultComboBoxModel;
        var JScrollPane = Packages.javax.swing.JScrollPane;
        var Dimension = Packages.java.awt.Dimension;
        var multiConfig = calibration.multiConfig
            ? clonePlainObject(calibration.multiConfig)
            : defaultMultiTrayCalibration(calibration);

        while (true) {
            var panel = new JPanel(new BorderLayout(10, 10));
            var topPanel = new JPanel(new GridLayout(0, 2, 8, 6));
            topPanel.setBorder(BorderFactory.createTitledBorder('Run layout'));

            function countBox(maxCount, selectedCount) {
                var model = new DefaultComboBoxModel();
                for (var i = 1; i <= maxCount; i++) {
                    model.addElement(String(i));
                }
                var box = new JComboBox(model);
                box.setSelectedIndex(Math.max(0, Math.min(maxCount - 1, Number(selectedCount || 1) - 1)));
                return box;
            }

            var eventCountBox = countBox(2, multiConfig.active_collection_event_count);
            var trayCountBox = countBox(4, multiConfig.active_sorting_tray_count);
            var classifierModeModel = new DefaultComboBoxModel();
            classifierModeModel.addElement('Train Debris Classifier');
            classifierModeModel.addElement('Auto-Debris Classifier');
            var classifierModeBox = new JComboBox(classifierModeModel);
            classifierModeBox.setSelectedIndex(String(multiConfig.shared.debris_classifier_mode || 'train') === 'auto' ? 1 : 0);
            var taxonomyModeModel = new DefaultComboBoxModel();
            taxonomyModeModel.addElement('Train Taxonomy');
            taxonomyModeModel.addElement('Auto Taxonomy');
            var taxonomyModeBox = new JComboBox(taxonomyModeModel);
            taxonomyModeBox.setSelectedIndex(String(multiConfig.shared.taxonomy_classifier_mode || 'train') === 'auto' ? 1 : 0);
            var autoReplateBox = new JCheckBox(
                'Continue with remaining targets (single plate)',
                Boolean(multiConfig.shared.auto_replate)
            );
            autoReplateBox.setEnabled(selectedOneBasedIndex(eventCountBox) === 1);
            if (!autoReplateBox.isEnabled()) {
                autoReplateBox.setSelected(false);
            }
            topPanel.add(new JLabel('Collection events'));
            topPanel.add(eventCountBox);
            topPanel.add(new JLabel('Sorting trays'));
            topPanel.add(trayCountBox);
            topPanel.add(new JLabel('96-well plates'));
            topPanel.add(new JLabel('One per collection event'));
            topPanel.add(new JLabel('Recovery plates'));
            topPanel.add(new JLabel('One per collection event'));
            topPanel.add(new JLabel('Debris classifier'));
            topPanel.add(classifierModeBox);
            topPanel.add(new JLabel('Taxonomy'));
            topPanel.add(taxonomyModeBox);
            topPanel.add(new JLabel('Auto re-plate'));
            topPanel.add(autoReplateBox);

            var eventsPanel = new JPanel(new GridLayout(0, 4, 8, 6));
            eventsPanel.setBorder(BorderFactory.createTitledBorder('Collection events'));
            var collectionCodeFields = [];
            var plateNumberFields = [];
            var startWellFields = [];

            function saveVisibleEventFields() {
                for (var saveEventSlot = 1; saveEventSlot <= 2; saveEventSlot++) {
                    var saveEvent = multiSlotByNumber(multiConfig.collection_events, 'event_slot', saveEventSlot);
                    var savePlate = multiSlotByNumber(multiConfig.plates, 'plate_slot', saveEventSlot);
                    if (saveEvent && collectionCodeFields[saveEventSlot]) {
                        saveEvent.collection_code = String(collectionCodeFields[saveEventSlot].getText()).trim();
                    }
                    if (savePlate && plateNumberFields[saveEventSlot]) {
                        savePlate.plate_number = String(plateNumberFields[saveEventSlot].getText()).trim();
                    }
                    if (savePlate && startWellFields[saveEventSlot]) {
                        savePlate.start_well = String(startWellFields[saveEventSlot].getText()).trim();
                    }
                }
            }

            function rebuildEventRows() {
                saveVisibleEventFields();
                eventsPanel.removeAll();
                eventsPanel.add(new JLabel('Event'));
                eventsPanel.add(new JLabel('Collection code'));
                eventsPanel.add(new JLabel('Plate number'));
                eventsPanel.add(new JLabel('Start well'));
                var visibleEventCount = selectedOneBasedIndex(eventCountBox);
                for (var eventSlot = 1; eventSlot <= visibleEventCount; eventSlot++) {
                    var eventConfig = multiSlotByNumber(multiConfig.collection_events, 'event_slot', eventSlot);
                    var plateConfig = multiSlotByNumber(multiConfig.plates, 'plate_slot', eventSlot);
                    var collectionCodeField = new JTextField(String(eventConfig ? eventConfig.collection_code || '' : ''), 10);
                    var plateNumberField = new JTextField(String(plateConfig ? plateConfig.plate_number || ('AA000' + eventSlot) : ('AA000' + eventSlot)), 10);
                    var startWellField = new JTextField(String(plateConfig ? plateConfig.start_well || 'A1' : 'A1'), 6);
                    collectionCodeFields[eventSlot] = collectionCodeField;
                    plateNumberFields[eventSlot] = plateNumberField;
                    startWellFields[eventSlot] = startWellField;
                    eventsPanel.add(new JLabel('Event ' + eventSlot));
                    eventsPanel.add(collectionCodeField);
                    eventsPanel.add(plateNumberField);
                    eventsPanel.add(startWellField);
                }
                eventsPanel.revalidate();
                eventsPanel.repaint();
            }
            rebuildEventRows();

            var traysPanel = new JPanel(new GridLayout(0, 2, 8, 6));
            traysPanel.setBorder(BorderFactory.createTitledBorder('Sorting tray assignments'));
            var trayEventBoxes = [];

            function saveVisibleTrayFields() {
                for (var saveTraySlot = 1; saveTraySlot <= 4; saveTraySlot++) {
                    var saveTray = multiSlotByNumber(multiConfig.sorting_trays, 'tray_slot', saveTraySlot);
                    if (saveTray && trayEventBoxes[saveTraySlot]) {
                        saveTray.collection_event_slot = selectedOneBasedIndex(trayEventBoxes[saveTraySlot]);
                    }
                }
            }

            function eventAssignmentBox(selectedEventSlot) {
                var model = new DefaultComboBoxModel();
                model.addElement('Event 1');
                model.addElement('Event 2');
                var box = new JComboBox(model);
                box.setSelectedIndex(Math.max(0, Math.min(1, Number(selectedEventSlot || 1) - 1)));
                return box;
            }

            function rebuildTrayRows() {
                saveVisibleTrayFields();
                trayEventBoxes = [];
                traysPanel.removeAll();
                traysPanel.add(new JLabel('Sorting tray'));
                traysPanel.add(new JLabel('Collection event'));
                var visibleTrayCount = selectedOneBasedIndex(trayCountBox);
                for (var traySlot = 1; traySlot <= visibleTrayCount; traySlot++) {
                    var trayConfig = multiSlotByNumber(multiConfig.sorting_trays, 'tray_slot', traySlot);
                    var trayEventBox = eventAssignmentBox(trayConfig ? trayConfig.collection_event_slot : 1);
                    trayEventBoxes[traySlot] = trayEventBox;
                    traysPanel.add(new JLabel('Tray ' + traySlot));
                    traysPanel.add(trayEventBox);
                }
                traysPanel.revalidate();
                traysPanel.repaint();
            }
            rebuildTrayRows();

            eventCountBox.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    rebuildEventRows();
                    rebuildTrayRows();
                    var singlePlateRun = selectedOneBasedIndex(eventCountBox) === 1;
                    autoReplateBox.setEnabled(singlePlateRun);
                    if (!singlePlateRun) {
                        autoReplateBox.setSelected(false);
                    }
                }
            }));
            trayCountBox.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    rebuildTrayRows();
                }
            }));

            panel.add(topPanel, BorderLayout.NORTH);
            var centerPanel = new JPanel(new GridLayout(1, 2, 10, 8));
            centerPanel.add(eventsPanel);
            centerPanel.add(traysPanel);
            panel.add(centerPanel, BorderLayout.CENTER);
            panel.add(
                new JLabel('<html>Cross-sample guard: each collection event uses its matching plate and recovery plate. '
                    + 'Only enabled trays are used in this run.</html>'),
                BorderLayout.SOUTH
            );

            var setupScroll = new JScrollPane(panel);
            setupScroll.setPreferredSize(new Dimension(760, 520));
            var result = JOptionPane.showConfirmDialog(
                null,
                setupScroll,
                'BugPicker run setup',
                JOptionPane.OK_CANCEL_OPTION,
                JOptionPane.QUESTION_MESSAGE
            );
            if (result !== JOptionPane.OK_OPTION) {
                throw new Error('Run setup was cancelled.');
            }

            try {
                saveVisibleEventFields();
                saveVisibleTrayFields();
                var eventCount = selectedOneBasedIndex(eventCountBox);
                var trayCount = selectedOneBasedIndex(trayCountBox);
                multiConfig.active_collection_event_count = eventCount;
                multiConfig.active_sorting_tray_count = trayCount;
                multiConfig.active_plate_count = eventCount;
                multiConfig.active_recovery_plate_count = eventCount;
                multiConfig.shared.debris_classifier_mode = classifierModeBox.getSelectedIndex() === 1 ? 'auto' : 'train';
                multiConfig.shared.taxonomy_classifier_mode = taxonomyModeBox.getSelectedIndex() === 1 ? 'auto' : 'train';
                multiConfig.shared.auto_replate = autoReplateBox.isSelected();

                for (var updateEventSlot = 1; updateEventSlot <= 2; updateEventSlot++) {
                    var updateEvent = multiSlotByNumber(multiConfig.collection_events, 'event_slot', updateEventSlot);
                    var updatePlate = multiSlotByNumber(multiConfig.plates, 'plate_slot', updateEventSlot);
                    var updateRecovery = multiSlotByNumber(multiConfig.recovery_plates, 'recovery_slot', updateEventSlot);
                    var enabledEvent = updateEventSlot <= eventCount;
                    if (updateEvent) {
                        updateEvent.enabled = enabledEvent;
                        updateEvent.plate_slot = updateEventSlot;
                        updateEvent.recovery_slot = updateEventSlot;
                        if (enabledEvent) {
                            updateEvent.collection_code = String(collectionCodeFields[updateEventSlot].getText()).trim();
                            if (updateEvent.collection_code.length === 0) {
                                throw new Error('Collection code is required for event ' + updateEventSlot + '.');
                            }
                        }
                    }
                    if (updatePlate) {
                        updatePlate.enabled = enabledEvent;
                        if (enabledEvent) {
                            updatePlate.plate_number = normalizePlateNumber(plateNumberFields[updateEventSlot].getText());
                            updatePlate.start_well = normalizeWellName(startWellFields[updateEventSlot].getText());
                        }
                    }
                    if (updateRecovery) {
                        updateRecovery.enabled = enabledEvent;
                    }
                }

                var enabledEventSeen = {};
                for (var updateTraySlot = 1; updateTraySlot <= 4; updateTraySlot++) {
                    var updateTray = multiSlotByNumber(multiConfig.sorting_trays, 'tray_slot', updateTraySlot);
                    var trayEnabled = updateTraySlot <= trayCount;
                    var assignedEvent = trayEventBoxes[updateTraySlot]
                        ? selectedOneBasedIndex(trayEventBoxes[updateTraySlot])
                        : Number(updateTray ? updateTray.collection_event_slot || 1 : 1);
                    if (trayEnabled && assignedEvent > eventCount) {
                        throw new Error('Tray ' + updateTraySlot + ' is assigned to disabled event ' + assignedEvent + '.');
                    }
                    if (updateTray) {
                        updateTray.enabled = trayEnabled;
                        updateTray.collection_event_slot = trayEnabled ? assignedEvent : Math.min(assignedEvent, eventCount);
                    }
                    if (trayEnabled) {
                        enabledEventSeen[String(assignedEvent)] = true;
                    }
                }
                for (var requiredEvent = 1; requiredEvent <= eventCount; requiredEvent++) {
                    if (!enabledEventSeen[String(requiredEvent)]) {
                        throw new Error('Event ' + requiredEvent + ' needs at least one enabled sorting tray.');
                    }
                }

                calibration.multiConfig = multiConfig;
                writeText(multiTrayCalibrationFile(), JSON.stringify(multiConfig, null, 2) + '\n');
                print('Saved BugPicker run setup: ' + multiTrayCalibrationFile().getAbsolutePath());
                return calibration;
            }
            catch (validationError) {
                JOptionPane.showMessageDialog(
                    null,
                    String(validationError.message || validationError),
                    'Invalid run setup',
                    JOptionPane.ERROR_MESSAGE
                );
            }
        }
    }

    function activeSortingTrayConfigs(multiConfig) {
        var trays = [];
        if (!multiConfig || !multiConfig.sorting_trays) {
            return trays;
        }
        for (var i = 0; i < multiConfig.sorting_trays.length; i++) {
            var tray = multiConfig.sorting_trays[i];
            if (!tray.enabled) {
                continue;
            }
            var eventSlot = Number(tray.collection_event_slot || 1);
            var eventConfig = multiSlotByNumber(multiConfig.collection_events, 'event_slot', eventSlot);
            var plateSlot = eventConfig ? Number(eventConfig.plate_slot || eventSlot) : eventSlot;
            var recoverySlot = eventConfig ? Number(eventConfig.recovery_slot || eventSlot) : eventSlot;
            trays.push({
                traySlot: Number(tray.tray_slot || (i + 1)),
                collectionEventSlot: eventSlot,
                plateSlot: plateSlot,
                recoverySlot: recoverySlot,
                xLeft: Number(tray.x_left_mm),
                xRight: Number(tray.x_right_mm),
                yTop: Number(tray.y_top_mm),
                yBottom: Number(tray.y_bottom_mm),
                trayHeightMm: Number(tray.tray_height_mm),
                sizeClass: String(tray.size_class || ''),
                pickZMm: Number(tray.pick_z_mm)
            });
        }
        trays.sort(function(left, right) {
            return left.traySlot - right.traySlot;
        });
        return trays;
    }

    function scanFrameCountForTray(tray, xStepMm, yStepMm) {
        var xStart = Math.min(Number(tray.xLeft), Number(tray.xRight));
        var xEnd = Math.max(Number(tray.xLeft), Number(tray.xRight));
        var yStart = Math.min(Number(tray.yTop), Number(tray.yBottom));
        var yEnd = Math.max(Number(tray.yTop), Number(tray.yBottom));
        return positions(xStart, xEnd, Number(xStepMm), false).length
            * positions(yStart, yEnd, Number(yStepMm), false).length;
    }

    function plateContextForSlot(multiConfig, plateSlot) {
        var eventConfig = multiSlotByNumber(multiConfig.collection_events, 'event_slot', plateSlot);
        var plateConfig = multiSlotByNumber(multiConfig.plates, 'plate_slot', plateSlot);
        var recoveryConfig = multiSlotByNumber(multiConfig.recovery_plates, 'recovery_slot', plateSlot);
        if (!plateConfig || !recoveryConfig) {
            throw new Error('Missing plate or recovery calibration for slot ' + plateSlot + '.');
        }
        var plateNumber = normalizePlateNumber(plateConfig.plate_number);
        return {
            plateNumber: plateNumber,
            plateId: 'P-' + plateNumber,
            collectionCode: String(eventConfig ? eventConfig.collection_code || '' : '').trim(),
            startWell: normalizeWellName(plateConfig.start_well),
            plateSlot: Number(plateSlot),
            recoverySlot: Number(plateSlot),
            plateA1X: Number(plateConfig.plate_a1_x_mm),
            plateA1Y: Number(plateConfig.plate_a1_y_mm),
            topCameraA1X: Number(plateConfig.top_camera_a1_x_mm),
            topCameraA1Y: Number(plateConfig.top_camera_a1_y_mm),
            plateQaCameraA1X: Number(plateConfig.plate_qa_camera_a1_x_mm),
            plateQaCameraA1Y: Number(plateConfig.plate_qa_camera_a1_y_mm),
            recoveryPlateA1X: Number(recoveryConfig.recovery_plate_a1_x_mm),
            recoveryPlateA1Y: Number(recoveryConfig.recovery_plate_a1_y_mm),
            plateWellPitchMm: Number(multiConfig.shared.plate_well_pitch_mm)
        };
    }

    function activePlateContexts(multiConfig) {
        var contexts = [];
        var activeCount = Math.max(1, Math.min(2, Number(multiConfig.active_plate_count || 1)));
        for (var plateSlot = 1; plateSlot <= activeCount; plateSlot++) {
            contexts.push(plateContextForSlot(multiConfig, plateSlot));
        }
        return contexts;
    }

    function raisePickerToCalibrationTravelZ(nozzle, travelZ, context) {
        if (nozzle === null || travelZ === null || isNaN(Number(travelZ))) {
            return;
        }
        print('Raising picker to calibration travel Z=' + Number(travelZ).toFixed(3)
            + ' before ' + context);
        moveNozzleToXyAtZ(nozzle, nozzle.location.x, nozzle.location.y, Number(travelZ));
    }

    function commandCameraToTrayPoint(camera, calibration, xField, yField, label, nozzle, calibrationTravelZ) {
        var requestedX = numberFieldValue(xField, label + ' X');
        var requestedY = numberFieldValue(yField, label + ' Y');
        var cameraX = calibration.scanBoundsAreCameraCoordinates
            ? requestedX
            : requestedX + calibration.cameraXOffsetMm;
        var cameraY = calibration.scanBoundsAreCameraCoordinates
            ? requestedY
            : requestedY + calibration.cameraYOffsetMm;

        raisePickerToCalibrationTravelZ(nozzle, calibrationTravelZ, label + ' tray camera move');
        print('Moving Top camera to ' + label
            + ' tray point X=' + requestedX.toFixed(3)
            + ' Y=' + requestedY.toFixed(3)
            + ' commanded camera X=' + cameraX.toFixed(3)
            + ' Y=' + cameraY.toFixed(3));
        moveCameraToXy(camera, cameraX, cameraY);
        print('Top camera after ' + label + ' move: ' + formatLocation(camera.getLocation()));
    }

    function commandPickerToA1(nozzle, xField, yField, calibrationTravelZ, xName, yName, label, zLabel, zValue) {
        if (nozzle === null) {
            throw new Error('Picker nozzle is not available.');
        }
        var x = numberFieldValue(xField, xName);
        var y = numberFieldValue(yField, yName);
        var travelZ = Number(calibrationTravelZ);
        var z = Number(zValue);
        print('Moving picker to ' + label + ' candidate X=' + x.toFixed(3)
            + ' Y=' + y.toFixed(3)
            + ' at current travel Z=' + travelZ.toFixed(3)
            + ', then ' + zLabel + '=' + z.toFixed(3));
        raisePickerToCalibrationTravelZ(nozzle, travelZ, label + ' calibration move');
        moveNozzleToXyAtZ(nozzle, x, y, travelZ);
        warnDualNozzleZClearance(z, label + ' calibration descent');
        moveNozzleToXyAtZ(nozzle, x, y, z);
        print('Picker after ' + label + ' move: ' + formatLocation(nozzle.location));
    }

    function commandPickerToPlateA1(nozzle, xField, yField, calibrationTravelZ) {
        commandPickerToA1(nozzle, xField, yField, calibrationTravelZ, 'plate_a1_x_mm', 'plate_a1_y_mm', 'plate A1', 'drop Z', -33.5);
    }

    function commandTopCameraToPlateA1(camera, nozzle, xField, yField, calibrationTravelZ) {
        var x = numberFieldValue(xField, 'top_camera_a1_x_mm');
        var y = numberFieldValue(yField, 'top_camera_a1_y_mm');
        raisePickerToCalibrationTravelZ(nozzle, calibrationTravelZ, 'Top camera plate A1 calibration move');
        moveCameraToXy(camera, x, y);
        print('Top camera after plate A1 calibration move: ' + formatLocation(camera.getLocation()));
    }

    function commandHiResToPlateQaA1(nozzle, xField, yField, focusZField, calibrationTravelZ) {
        if (nozzle === null) {
            throw new Error('HiRes camera motion reference N1 is not available.');
        }
        var x = numberFieldValue(xField, 'plate_qa_camera_a1_x_mm');
        var y = numberFieldValue(yField, 'plate_qa_camera_a1_y_mm');
        var travelZ = Number(calibrationTravelZ);
        var focusZ = Math.max(hiResMinimumZ, numberFieldValue(focusZField, 'hires_focus_z_mm'));
        print('Moving HiRes camera carrier to plate QA A1 candidate X=' + x.toFixed(3)
            + ' Y=' + y.toFixed(3)
            + ' then focus Z=' + focusZ.toFixed(3)
            + ' using N1 coordinate frame');
        raisePickerToCalibrationTravelZ(nozzle, travelZ, 'plate QA A1 HiRes calibration move');
        moveNozzleToXyAtZ(nozzle, x, y, travelZ);
        moveNozzleToXyAtZ(nozzle, x, y, focusZ);
        print('HiRes camera carrier after plate QA A1 move: ' + formatLocation(nozzle.location));
    }

    function commandPickerToRecoveryPlateA1Xy(nozzle, xField, yField, calibrationTravelZ) {
        if (nozzle === null) {
            throw new Error('Picker nozzle is not available.');
        }
        var x = numberFieldValue(xField, 'recovery_plate_a1_x_mm');
        var y = numberFieldValue(yField, 'recovery_plate_a1_y_mm');
        var travelZ = Number(calibrationTravelZ);
        print('Moving picker to recovery plate A1 XY candidate X=' + x.toFixed(3)
            + ' Y=' + y.toFixed(3)
            + ' at travel Z=' + travelZ.toFixed(3));
        raisePickerToCalibrationTravelZ(nozzle, travelZ, 'recovery plate A1 XY calibration move');
        moveNozzleToXyAtZ(nozzle, x, y, travelZ);
        print('Picker after recovery plate A1 XY move: ' + formatLocation(nozzle.location));
    }

    function commandPickerToRecoveryPlateA1Z(nozzle, calibrationTravelZ) {
        if (nozzle === null) {
            throw new Error('Picker nozzle is not available.');
        }
        var travelZ = Number(calibrationTravelZ);
        var wipeZ = -42.0;
        var x = Number(nozzle.location.x);
        var y = Number(nozzle.location.y);
        print('Dropping picker to recovery plate wipe Z=' + wipeZ.toFixed(3)
            + ' for 1.0s, then returning to travel Z=' + travelZ.toFixed(3));
        warnDualNozzleZClearance(wipeZ, 'recovery plate A1 Z calibration descent');
        moveNozzleToXyAtZ(nozzle, x, y, wipeZ);
        Packages.java.lang.Thread.sleep(1000);
        moveNozzleToXyAtZ(nozzle, x, y, travelZ);
        print('Picker after recovery plate A1 Z probe: ' + formatLocation(nozzle.location));
    }

    function promptForTrainingTrayBounds(calibration, camera, nozzle) {
        var calibrationTravelZ = nozzle === null ? null : Number(nozzle.location.z);
        var hiResCalibrationTravelZ = calibrationTravelZ;
        while (true) {
            var ActionListener = Packages.java.awt.event.ActionListener;
            var JComboBox = Packages.javax.swing.JComboBox;
            var DefaultComboBoxModel = Packages.javax.swing.DefaultComboBoxModel;
            var DocumentListener = Packages.javax.swing.event.DocumentListener;
            var panel = new JPanel(new BorderLayout(12, 6));
            var calibrationPanel = new JPanel(new GridLayout(0, 2, 12, 6));
            var jogDock = new JPanel(new BorderLayout(6, 6));
            jogDock.setBorder(BorderFactory.createTitledBorder('Jog controls'));
            jogDock.add(new JLabel('<html>Select a Jog button<br>from a calibration box.</html>'), BorderLayout.CENTER);
            var startPanel = new JPanel(new GridLayout(0, 2, 8, 6));
            var endPanel = new JPanel(new GridLayout(0, 2, 8, 6));
            var heightPanel = new JPanel(new GridLayout(0, 2, 8, 6));
            var platePanel = new JPanel(new GridLayout(0, 2, 8, 6));
            var recoveryPlatePanel = new JPanel(new GridLayout(0, 2, 8, 6));
            var xLeftField = new JTextField(calibration.xLeft.toFixed(3), 10);
            var xRightField = new JTextField(calibration.xRight.toFixed(3), 10);
            var yTopField = new JTextField(calibration.yTop.toFixed(3), 10);
            var yBottomField = new JTextField(calibration.yBottom.toFixed(3), 10);
            var imageCountField = new JTextField('', 10);
            imageCountField.setEditable(false);
            var plateA1XField = new JTextField(Number(calibration.plateA1X).toFixed(3), 10);
            var plateA1YField = new JTextField(Number(calibration.plateA1Y).toFixed(3), 10);
            var topCameraA1XField = new JTextField(Number(calibration.plateA1X + calibration.cameraXOffsetMm).toFixed(3), 10);
            var topCameraA1YField = new JTextField(Number(calibration.plateA1Y + calibration.cameraYOffsetMm).toFixed(3), 10);
            var plateQaCameraA1XField = new JTextField(Number(calibration.plateQaCameraA1X).toFixed(3), 10);
            var plateQaCameraA1YField = new JTextField(Number(calibration.plateQaCameraA1Y).toFixed(3), 10);
            var hiResFocusZField = new JTextField(Number(calibration.hiResFocusZMm).toFixed(3), 10);
            var recoveryPlateA1XField = new JTextField(Number(calibration.recoveryPlateA1X).toFixed(3), 10);
            var recoveryPlateA1YField = new JTextField(Number(calibration.recoveryPlateA1Y).toFixed(3), 10);
            var platePitchField = new JTextField(Number(calibration.plateWellPitchMm).toFixed(3), 10);
            var trayHeightField = new JTextField(Number(calibration.trayHeightMm).toFixed(3), 10);
            var sizeClassField = new JTextField(String(calibration.sizeClass), 10);
            var pickZField = new JTextField(Number(calibration.pickZMm).toFixed(3), 10);
            var trayPresetModel = new DefaultComboBoxModel();
            var presets = trayHeightPresets();
            for (var presetIndex = 0; presetIndex < presets.length; presetIndex++) {
                trayPresetModel.addElement(presets[presetIndex].label);
            }
            var trayPresetBox = new JComboBox(trayPresetModel);
            trayPresetBox.setSelectedIndex(findTrayHeightPresetIndex(calibration));
            var startMoveButton = new JButton('Move camera');
            var endMoveButton = new JButton('Move camera');
            var plateA1MoveButton = new JButton('Move picker to drop Z');
            var topCameraA1MoveButton = new JButton('Move Top camera to A1');
            var plateQaCameraA1MoveButton = new JButton('Move HiRes to QA A1');
            var recoveryPlateA1XyButton = new JButton('Move picker to X,Y');
            var recoveryPlateA1ZButton = new JButton('Drop to picker Z');
            var traySlotModel = new DefaultComboBoxModel();
            for (var traySlotOption = 1; traySlotOption <= 4; traySlotOption++) {
                traySlotModel.addElement('Tray ' + traySlotOption);
            }
            var traySlotBox = new JComboBox(traySlotModel);
            var plateSlotModel = new DefaultComboBoxModel();
            for (var plateSlotOption = 1; plateSlotOption <= 2; plateSlotOption++) {
                plateSlotModel.addElement('Plate ' + plateSlotOption);
            }
            var plateSlotBox = new JComboBox(plateSlotModel);
            var recoverySlotModel = new DefaultComboBoxModel();
            for (var recoverySlotOption = 1; recoverySlotOption <= 2; recoverySlotOption++) {
                recoverySlotModel.addElement('Recovery ' + recoverySlotOption);
            }
            var recoverySlotBox = new JComboBox(recoverySlotModel);
            var currentTraySlot = 1;
            var currentPlateSlot = 1;
            var currentRecoverySlot = 1;

            function activeMultiConfig() {
                if (!calibration.multiConfig) {
                    calibration.multiConfig = defaultMultiTrayCalibration(calibration);
                }
                return calibration.multiConfig;
            }

            function saveTrayFields(slot) {
                var config = activeMultiConfig();
                var tray = multiSlotByNumber(config.sorting_trays, 'tray_slot', slot);
                if (!tray) {
                    return;
                }
                tray.x_left_mm = numberFieldValue(xLeftField, 'x_left_mm');
                tray.x_right_mm = numberFieldValue(xRightField, 'x_right_mm');
                tray.y_top_mm = numberFieldValue(yTopField, 'y_top_mm');
                tray.y_bottom_mm = numberFieldValue(yBottomField, 'y_bottom_mm');
                tray.tray_height_mm = numberFieldValue(trayHeightField, 'tray_height_mm');
                tray.size_class = String(sizeClassField.getText()).trim();
                tray.pick_z_mm = numberFieldValue(pickZField, 'pick_z_mm');
            }

            function loadTrayFields(slot) {
                var config = activeMultiConfig();
                var tray = multiSlotByNumber(config.sorting_trays, 'tray_slot', slot);
                if (!tray) {
                    return;
                }
                xLeftField.setText(Number(tray.x_left_mm).toFixed(3));
                xRightField.setText(Number(tray.x_right_mm).toFixed(3));
                yTopField.setText(Number(tray.y_top_mm).toFixed(3));
                yBottomField.setText(Number(tray.y_bottom_mm).toFixed(3));
                trayHeightField.setText(Number(tray.tray_height_mm).toFixed(3));
                sizeClassField.setText(String(tray.size_class || ''));
                pickZField.setText(Number(tray.pick_z_mm).toFixed(3));
                updateImageCountField();
            }

            function savePlateFields(slot) {
                var config = activeMultiConfig();
                var plate = multiSlotByNumber(config.plates, 'plate_slot', slot);
                var event = multiSlotByNumber(config.collection_events, 'event_slot', slot);
                if (!plate) {
                    return;
                }
                plate.plate_a1_x_mm = numberFieldValue(plateA1XField, 'plate_a1_x_mm');
                plate.plate_a1_y_mm = numberFieldValue(plateA1YField, 'plate_a1_y_mm');
                plate.top_camera_a1_x_mm = numberFieldValue(topCameraA1XField, 'top_camera_a1_x_mm');
                plate.top_camera_a1_y_mm = numberFieldValue(topCameraA1YField, 'top_camera_a1_y_mm');
                plate.plate_qa_camera_a1_x_mm = numberFieldValue(plateQaCameraA1XField, 'plate_qa_camera_a1_x_mm');
                plate.plate_qa_camera_a1_y_mm = numberFieldValue(plateQaCameraA1YField, 'plate_qa_camera_a1_y_mm');
            }

            function loadPlateFields(slot) {
                var config = activeMultiConfig();
                var plate = multiSlotByNumber(config.plates, 'plate_slot', slot);
                var event = multiSlotByNumber(config.collection_events, 'event_slot', slot);
                if (!plate) {
                    return;
                }
                plateA1XField.setText(Number(plate.plate_a1_x_mm).toFixed(3));
                plateA1YField.setText(Number(plate.plate_a1_y_mm).toFixed(3));
                topCameraA1XField.setText(Number(plate.top_camera_a1_x_mm).toFixed(3));
                topCameraA1YField.setText(Number(plate.top_camera_a1_y_mm).toFixed(3));
                plateQaCameraA1XField.setText(Number(plate.plate_qa_camera_a1_x_mm).toFixed(3));
                plateQaCameraA1YField.setText(Number(plate.plate_qa_camera_a1_y_mm).toFixed(3));
            }

            function saveRecoveryFields(slot) {
                var config = activeMultiConfig();
                var recovery = multiSlotByNumber(config.recovery_plates, 'recovery_slot', slot);
                if (!recovery) {
                    return;
                }
                recovery.recovery_plate_a1_x_mm = numberFieldValue(recoveryPlateA1XField, 'recovery_plate_a1_x_mm');
                recovery.recovery_plate_a1_y_mm = numberFieldValue(recoveryPlateA1YField, 'recovery_plate_a1_y_mm');
            }

            function loadRecoveryFields(slot) {
                var config = activeMultiConfig();
                var recovery = multiSlotByNumber(config.recovery_plates, 'recovery_slot', slot);
                if (!recovery) {
                    return;
                }
                recoveryPlateA1XField.setText(Number(recovery.recovery_plate_a1_x_mm).toFixed(3));
                recoveryPlateA1YField.setText(Number(recovery.recovery_plate_a1_y_mm).toFixed(3));
            }

            function jogStepValue(stepField) {
                var value = Number(String(stepField.getText()).trim());
                if (isNaN(value) || value <= 0) {
                    throw new Error('Jog step must be a positive number.');
                }
                return value;
            }

            function updateTrayFieldsFromCamera(xField, yField) {
                var location = camera.getLocation();
                var x = calibration.scanBoundsAreCameraCoordinates
                    ? Number(location.x)
                    : Number(location.x) - Number(calibration.cameraXOffsetMm);
                var y = calibration.scanBoundsAreCameraCoordinates
                    ? Number(location.y)
                    : Number(location.y) - Number(calibration.cameraYOffsetMm);
                xField.setText(x.toFixed(3));
                yField.setText(y.toFixed(3));
                updateImageCountField();
            }

            function updateCameraFieldsFromCurrentLocation(xField, yField) {
                var location = camera.getLocation();
                xField.setText(Number(location.x).toFixed(3));
                yField.setText(Number(location.y).toFixed(3));
            }

            function updatePickerFieldsFromCurrentLocation(xField, yField, jogNozzle) {
                var activeNozzle = jogNozzle || nozzle;
                if (activeNozzle === null) {
                    throw new Error('Requested nozzle is not available.');
                }
                var location = activeNozzle.location;
                xField.setText(Number(location.x).toFixed(3));
                yField.setText(Number(location.y).toFixed(3));
            }

            function jogCameraBy(stepField, dx, dy, xField, yField, updateFields) {
                var step = jogStepValue(stepField);
                raisePickerToCalibrationTravelZ(nozzle, calibrationTravelZ, 'Top camera XY jog');
                var location = camera.getLocation();
                moveCameraToXy(camera, Number(location.x) + (dx * step), Number(location.y) + (dy * step));
                updateFields(xField, yField);
                print('Jogged Top camera to ' + formatLocation(camera.getLocation()));
            }

            function jogPickerBy(stepField, dx, dy, xField, yField, jogNozzle, jogTravelZ, label) {
                var activeNozzle = jogNozzle || nozzle;
                if (activeNozzle === null) {
                    throw new Error('Requested nozzle is not available.');
                }
                var step = jogStepValue(stepField);
                var travelZ = isNaN(Number(jogTravelZ)) ? Number(activeNozzle.location.z) : Number(jogTravelZ);
                raisePickerToCalibrationTravelZ(activeNozzle, travelZ, label || 'XY jog');
                moveNozzleToXyAtZ(
                    activeNozzle,
                    Number(activeNozzle.location.x) + (dx * step),
                    Number(activeNozzle.location.y) + (dy * step),
                    travelZ
                );
                updatePickerFieldsFromCurrentLocation(xField, yField, activeNozzle);
                print('Jogged ' + (label || 'picker') + ' to ' + formatLocation(activeNozzle.location));
            }

            function makeJogPanel(title, detailProvider, xField, yField, isCamera, updateFields, jogNozzle, jogTravelZ, jogLabel) {
                var jogPanel = new JPanel(new BorderLayout(6, 6));
                jogPanel.setBorder(BorderFactory.createTitledBorder(title));
                var detailLabel = new JLabel('<html>' + String(detailProvider()) + '</html>');
                var statusLabel = new JLabel('Record has not been pressed.');
                var controlsPanel = new JPanel(new GridLayout(0, 3, 4, 4));
                var stepField = new JTextField('1.000', 6);
                var leftButton = new JButton('-X');
                var rightButton = new JButton('+X');
                var upButton = new JButton('+Y');
                var downButton = new JButton('-Y');
                var recordButton = new JButton('Record');

                function runJog(dx, dy) {
                    try {
                        if (isCamera) {
                            jogCameraBy(stepField, dx, dy, xField, yField, updateFields);
                        }
                        else {
                            jogPickerBy(stepField, dx, dy, xField, yField, jogNozzle, jogTravelZ, jogLabel);
                        }
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Jog failed',
                            JOptionPane.ERROR_MESSAGE
                        );
                    }
                }

                recordButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        try {
                            var detail = String(detailProvider());
                            if (isCamera) {
                                raisePickerToCalibrationTravelZ(nozzle, calibrationTravelZ, 'camera jog record');
                            }
                            else {
                                raisePickerToCalibrationTravelZ(jogNozzle || nozzle, Number(jogTravelZ), 'jog record');
                            }
                            if (isCamera) {
                                updateFields(xField, yField);
                            }
                            else {
                                updatePickerFieldsFromCurrentLocation(xField, yField, jogNozzle || nozzle);
                            }
                            detailLabel.setText('<html>' + detail + '</html>');
                            statusLabel.setText('Recorded X=' + xField.getText() + ' Y=' + yField.getText());
                        }
                        catch (error) {
                            JOptionPane.showMessageDialog(
                                null,
                                String(error.message || error),
                                'Record failed',
                                JOptionPane.ERROR_MESSAGE
                            );
                        }
                    }
                }));
                leftButton.addActionListener(new ActionListener({ actionPerformed: function(event) { runJog(-1, 0); } }));
                rightButton.addActionListener(new ActionListener({ actionPerformed: function(event) { runJog(1, 0); } }));
                upButton.addActionListener(new ActionListener({ actionPerformed: function(event) { runJog(0, 1); } }));
                downButton.addActionListener(new ActionListener({ actionPerformed: function(event) { runJog(0, -1); } }));

                controlsPanel.add(new JLabel('Step mm'));
                controlsPanel.add(stepField);
                controlsPanel.add(recordButton);
                controlsPanel.add(new JLabel(''));
                controlsPanel.add(upButton);
                controlsPanel.add(new JLabel(''));
                controlsPanel.add(leftButton);
                controlsPanel.add(downButton);
                controlsPanel.add(rightButton);
                jogPanel.add(detailLabel, BorderLayout.NORTH);
                jogPanel.add(controlsPanel, BorderLayout.CENTER);
                jogPanel.add(statusLabel, BorderLayout.SOUTH);
                return jogPanel;
            }

            function showJogControls(title, detailProvider, xField, yField, isCamera, updateFields, jogNozzle, jogTravelZ, jogLabel) {
                jogDock.removeAll();
                jogDock.setBorder(BorderFactory.createTitledBorder('Jog controls: ' + title));
                jogDock.add(makeJogPanel(title, detailProvider, xField, yField, isCamera, updateFields, jogNozzle, jogTravelZ, jogLabel), BorderLayout.NORTH);
                jogDock.revalidate();
                jogDock.repaint();
            }

            function makeJogWindowButton(title, detailProvider, xField, yField, isCamera, updateFields, jogNozzle, jogTravelZ, jogLabel) {
                var button = new JButton(title);
                button.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        showJogControls(title, detailProvider, xField, yField, isCamera, updateFields, jogNozzle, jogTravelZ, jogLabel);
                    }
                }));
                return button;
            }

            function trayStartJogDetail() {
                return 'Calibrating sorting tray ' + currentTraySlot
                    + ' starting position. Record updates x_left_mm and y_top_mm.';
            }

            function trayEndJogDetail() {
                return 'Calibrating sorting tray ' + currentTraySlot
                    + ' ending position. Record updates x_right_mm and y_bottom_mm.';
            }

            function plateA1JogDetail() {
                return 'Calibrating 96-well plate ' + currentPlateSlot
                    + ' picker A1. Record updates A1 X mm and A1 Y mm.';
            }

            function plateQaA1JogDetail() {
                return 'Calibrating 96-well plate ' + currentPlateSlot
                    + ' HiRes camera A1. Record updates QA camera A1 X mm and QA camera A1 Y mm.';
            }

            function topCameraA1JogDetail() {
                return 'Calibrating 96-well plate ' + currentPlateSlot
                    + ' Lumen Top camera A1. Record updates Top camera A1 X mm and Y mm.';
            }

            function recoveryA1JogDetail() {
                return 'Calibrating recovery plate ' + currentRecoverySlot
                    + ' picker A1. Record updates A1 X mm and A1 Y mm.';
            }

            startPanel.setBorder(BorderFactory.createTitledBorder('Starting position'));
            startPanel.add(new JLabel('Sorting tray'));
            startPanel.add(traySlotBox);
            startPanel.add(new JLabel('X (x_left_mm)'));
            startPanel.add(xLeftField);
            startPanel.add(new JLabel('Y (y_top_mm)'));
            startPanel.add(yTopField);
            startPanel.add(new JLabel(''));
            startPanel.add(startMoveButton);
            startPanel.add(new JLabel(''));
            startPanel.add(makeJogWindowButton('Jog Top camera', trayStartJogDetail, xLeftField, yTopField, true, updateTrayFieldsFromCamera));

            endPanel.setBorder(BorderFactory.createTitledBorder('Ending position'));
            endPanel.add(new JLabel('X (x_right_mm)'));
            endPanel.add(xRightField);
            endPanel.add(new JLabel('Y (y_bottom_mm)'));
            endPanel.add(yBottomField);
            endPanel.add(new JLabel('Scan images'));
            endPanel.add(imageCountField);
            endPanel.add(new JLabel(''));
            endPanel.add(endMoveButton);
            endPanel.add(new JLabel(''));
            endPanel.add(makeJogWindowButton('Jog Top camera', trayEndJogDetail, xRightField, yBottomField, true, updateTrayFieldsFromCamera));

            heightPanel.setBorder(BorderFactory.createTitledBorder('Tray height / pick Z'));
            heightPanel.add(new JLabel('Preset'));
            heightPanel.add(trayPresetBox);
            heightPanel.add(new JLabel('Tray height mm'));
            heightPanel.add(trayHeightField);
            heightPanel.add(new JLabel('Size class'));
            heightPanel.add(sizeClassField);
            heightPanel.add(new JLabel('Pick Z mm'));
            heightPanel.add(pickZField);

            platePanel.setBorder(BorderFactory.createTitledBorder('96-well plate'));
            platePanel.add(new JLabel('Plate slot'));
            platePanel.add(plateSlotBox);
            platePanel.add(new JLabel('A1 X mm'));
            platePanel.add(plateA1XField);
            platePanel.add(new JLabel('A1 Y mm'));
            platePanel.add(plateA1YField);
            platePanel.add(new JLabel('Well pitch mm'));
            platePanel.add(platePitchField);
            platePanel.add(new JLabel(''));
            platePanel.add(plateA1MoveButton);
            platePanel.add(new JLabel(''));
            platePanel.add(makeJogWindowButton('Jog picker', plateA1JogDetail, plateA1XField, plateA1YField, false, null, nozzle, calibrationTravelZ, 'picker'));
            platePanel.add(new JLabel('Top camera A1 X mm'));
            platePanel.add(topCameraA1XField);
            platePanel.add(new JLabel('Top camera A1 Y mm'));
            platePanel.add(topCameraA1YField);
            platePanel.add(new JLabel(''));
            platePanel.add(topCameraA1MoveButton);
            platePanel.add(new JLabel(''));
            platePanel.add(makeJogWindowButton('Jog Top camera A1', topCameraA1JogDetail, topCameraA1XField, topCameraA1YField, true, updateCameraFieldsFromCurrentLocation));
            platePanel.add(new JLabel('HiRes A1 X mm'));
            platePanel.add(plateQaCameraA1XField);
            platePanel.add(new JLabel('HiRes A1 Y mm'));
            platePanel.add(plateQaCameraA1YField);
            platePanel.add(new JLabel('HiRes focus Z mm'));
            platePanel.add(hiResFocusZField);
            platePanel.add(new JLabel(''));
            platePanel.add(plateQaCameraA1MoveButton);
            platePanel.add(new JLabel(''));
            platePanel.add(makeJogWindowButton('Jog HiRes camera', plateQaA1JogDetail, plateQaCameraA1XField, plateQaCameraA1YField, false, null, nozzle, hiResCalibrationTravelZ, 'HiRes camera'));

            recoveryPlatePanel.setBorder(BorderFactory.createTitledBorder('Recovery plate'));
            recoveryPlatePanel.add(new JLabel('Recovery slot'));
            recoveryPlatePanel.add(recoverySlotBox);
            recoveryPlatePanel.add(new JLabel('A1 X mm'));
            recoveryPlatePanel.add(recoveryPlateA1XField);
            recoveryPlatePanel.add(new JLabel('A1 Y mm'));
            recoveryPlatePanel.add(recoveryPlateA1YField);
            recoveryPlatePanel.add(new JLabel(''));
            recoveryPlatePanel.add(recoveryPlateA1XyButton);
            recoveryPlatePanel.add(new JLabel(''));
            recoveryPlatePanel.add(makeJogWindowButton('Jog picker', recoveryA1JogDetail, recoveryPlateA1XField, recoveryPlateA1YField, false, null, nozzle, calibrationTravelZ, 'picker'));
            recoveryPlatePanel.add(new JLabel(''));
            recoveryPlatePanel.add(recoveryPlateA1ZButton);

            function applyTrayPreset(index) {
                var preset = presets[Math.max(0, Math.min(index, presets.length - 1))];
                trayHeightField.setText(Number(preset.trayHeightMm).toFixed(3));
                sizeClassField.setText(String(preset.sizeClass));
                pickZField.setText(Number(preset.pickZMm).toFixed(3));
            }

            trayPresetBox.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    applyTrayPreset(trayPresetBox.getSelectedIndex());
                }
            }));

            function updateImageCountField() {
                try {
                    var xLeft = numberFieldValue(xLeftField, 'x_left_mm');
                    var xRight = numberFieldValue(xRightField, 'x_right_mm');
                    var yTop = numberFieldValue(yTopField, 'y_top_mm');
                    var yBottom = numberFieldValue(yBottomField, 'y_bottom_mm');
                    var xStart = Math.min(xLeft, xRight);
                    var xEnd = Math.max(xLeft, xRight);
                    var yStart = Math.min(yTop, yBottom);
                    var yEnd = Math.max(yTop, yBottom);
                    var xCount = positions(xStart, xEnd, Number(calibration.xStepMm), false).length;
                    var yCount = positions(yStart, yEnd, Number(calibration.yStepMm), false).length;
                    imageCountField.setText(String(xCount * yCount) + ' (' + xCount + ' x ' + yCount + ')');
                }
                catch (error) {
                    imageCountField.setText('Invalid bounds');
                }
            }

            function addImageCountListener(field) {
                field.getDocument().addDocumentListener(new DocumentListener({
                    insertUpdate: function(event) {
                        updateImageCountField();
                    },
                    removeUpdate: function(event) {
                        updateImageCountField();
                    },
                    changedUpdate: function(event) {
                        updateImageCountField();
                    }
                }));
            }

            addImageCountListener(xLeftField);
            addImageCountListener(xRightField);
            addImageCountListener(yTopField);
            addImageCountListener(yBottomField);
            updateImageCountField();

            traySlotBox.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    try {
                        saveTrayFields(currentTraySlot);
                        currentTraySlot = selectedOneBasedIndex(traySlotBox);
                        loadTrayFields(currentTraySlot);
                        showJogControls('Jog Top camera', trayStartJogDetail, xLeftField, yTopField, true, updateTrayFieldsFromCamera);
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Could not switch sorting tray',
                            JOptionPane.ERROR_MESSAGE
                        );
                        traySlotBox.setSelectedIndex(currentTraySlot - 1);
                    }
                }
            }));
            plateSlotBox.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    try {
                        savePlateFields(currentPlateSlot);
                        currentPlateSlot = selectedOneBasedIndex(plateSlotBox);
                        loadPlateFields(currentPlateSlot);
                        showJogControls('Jog picker', plateA1JogDetail, plateA1XField, plateA1YField, false, null, nozzle, calibrationTravelZ, 'picker');
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Could not switch plate',
                            JOptionPane.ERROR_MESSAGE
                        );
                        plateSlotBox.setSelectedIndex(currentPlateSlot - 1);
                    }
                }
            }));
            recoverySlotBox.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    try {
                        saveRecoveryFields(currentRecoverySlot);
                        currentRecoverySlot = selectedOneBasedIndex(recoverySlotBox);
                        loadRecoveryFields(currentRecoverySlot);
                        showJogControls('Jog picker', recoveryA1JogDetail, recoveryPlateA1XField, recoveryPlateA1YField, false, null, nozzle, calibrationTravelZ, 'picker');
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Could not switch recovery plate',
                            JOptionPane.ERROR_MESSAGE
                        );
                        recoverySlotBox.setSelectedIndex(currentRecoverySlot - 1);
                    }
                }
            }));

            startMoveButton.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    try {
                        commandCameraToTrayPoint(
                            camera,
                            calibration,
                            xLeftField,
                            yTopField,
                            'starting',
                            nozzle,
                            calibrationTravelZ
                        );
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Could not move camera',
                            JOptionPane.ERROR_MESSAGE
                        );
                    }
                }
            }));
            endMoveButton.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    try {
                        commandCameraToTrayPoint(
                            camera,
                            calibration,
                            xRightField,
                            yBottomField,
                            'ending',
                            nozzle,
                            calibrationTravelZ
                        );
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Could not move camera',
                            JOptionPane.ERROR_MESSAGE
                        );
                    }
                }
            }));
            plateA1MoveButton.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    try {
                        commandPickerToPlateA1(nozzle, plateA1XField, plateA1YField, calibrationTravelZ);
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Could not move picker',
                            JOptionPane.ERROR_MESSAGE
                        );
                    }
                }
            }));
            topCameraA1MoveButton.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    try {
                        commandTopCameraToPlateA1(camera, nozzle, topCameraA1XField, topCameraA1YField, calibrationTravelZ);
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Could not move Top camera',
                            JOptionPane.ERROR_MESSAGE
                        );
                    }
                }
            }));
            plateQaCameraA1MoveButton.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    try {
                        commandHiResToPlateQaA1(nozzle, plateQaCameraA1XField, plateQaCameraA1YField, hiResFocusZField, hiResCalibrationTravelZ);
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Could not move camera',
                            JOptionPane.ERROR_MESSAGE
                        );
                    }
                }
            }));
            recoveryPlateA1XyButton.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    try {
                        commandPickerToRecoveryPlateA1Xy(nozzle, recoveryPlateA1XField, recoveryPlateA1YField, calibrationTravelZ);
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Could not move picker',
                            JOptionPane.ERROR_MESSAGE
                        );
                    }
                }
            }));
            recoveryPlateA1ZButton.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    try {
                        commandPickerToRecoveryPlateA1Z(nozzle, calibrationTravelZ);
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Could not move picker',
                            JOptionPane.ERROR_MESSAGE
                        );
                    }
                }
            }));

            calibrationPanel.add(startPanel);
            calibrationPanel.add(endPanel);
            calibrationPanel.add(heightPanel);
            calibrationPanel.add(platePanel);
            calibrationPanel.add(recoveryPlatePanel);

            loadTrayFields(currentTraySlot);
            loadPlateFields(currentPlateSlot);
            loadRecoveryFields(currentRecoverySlot);

            var scrollPane = new Packages.javax.swing.JScrollPane(calibrationPanel);
            scrollPane.setPreferredSize(new Packages.java.awt.Dimension(880, 720));
            scrollPane.setVerticalScrollBarPolicy(Packages.javax.swing.ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED);
            scrollPane.setHorizontalScrollBarPolicy(Packages.javax.swing.ScrollPaneConstants.HORIZONTAL_SCROLLBAR_AS_NEEDED);
            panel.add(scrollPane, BorderLayout.CENTER);
            panel.add(jogDock, BorderLayout.EAST);
            showJogControls('Jog Top camera', trayStartJogDetail, xLeftField, yTopField, true, updateTrayFieldsFromCamera);

            var result = JOptionPane.showConfirmDialog(
                null,
                panel,
                'Tray scan bounds',
                JOptionPane.OK_CANCEL_OPTION,
                JOptionPane.QUESTION_MESSAGE
            );
            if (result !== JOptionPane.OK_OPTION) {
                throw new Error('Scan cancelled before tray scan bounds were accepted.');
            }

            try {
                saveTrayFields(currentTraySlot);
                savePlateFields(currentPlateSlot);
                saveRecoveryFields(currentRecoverySlot);
                var dialogMultiConfig = activeMultiConfig();
                var primaryTrayConfig = multiSlotByNumber(dialogMultiConfig.sorting_trays, 'tray_slot', 1);
                var primaryPlateConfig = multiSlotByNumber(dialogMultiConfig.plates, 'plate_slot', 1);
                var primaryRecoveryConfig = multiSlotByNumber(dialogMultiConfig.recovery_plates, 'recovery_slot', 1);
                var primaryEventConfig = multiSlotByNumber(dialogMultiConfig.collection_events, 'event_slot', 1);
                var updated = {
                    xLeft: Number(primaryTrayConfig.x_left_mm),
                    xRight: Number(primaryTrayConfig.x_right_mm),
                    yTop: Number(primaryTrayConfig.y_top_mm),
                    yBottom: Number(primaryTrayConfig.y_bottom_mm),
                    cameraXOffsetMm: calibration.cameraXOffsetMm,
                    cameraYOffsetMm: calibration.cameraYOffsetMm,
                    scanBoundsAreCameraCoordinates: calibration.scanBoundsAreCameraCoordinates,
                    xStepMm: calibration.xStepMm,
                    yStepMm: calibration.yStepMm,
                    trayHeightMm: Number(primaryTrayConfig.tray_height_mm),
                    sizeClass: String(primaryTrayConfig.size_class || '').trim(),
                    pickZMm: Number(primaryTrayConfig.pick_z_mm),
                    plateA1X: Number(primaryPlateConfig.plate_a1_x_mm),
                    plateA1Y: Number(primaryPlateConfig.plate_a1_y_mm),
                    topCameraA1X: Number(primaryPlateConfig.top_camera_a1_x_mm),
                    topCameraA1Y: Number(primaryPlateConfig.top_camera_a1_y_mm),
                    plateQaCameraA1X: Number(primaryPlateConfig.plate_qa_camera_a1_x_mm),
                    plateQaCameraA1Y: Number(primaryPlateConfig.plate_qa_camera_a1_y_mm),
                    hiResTrayOffsetX: Number(primaryPlateConfig.plate_qa_camera_a1_x_mm) - Number(primaryPlateConfig.plate_a1_x_mm),
                    hiResTrayOffsetY: Number(primaryPlateConfig.plate_qa_camera_a1_y_mm) - Number(primaryPlateConfig.plate_a1_y_mm),
                    hiResFocusZMm: numberFieldValue(hiResFocusZField, 'hires_focus_z_mm'),
                    recoveryPlateA1X: Number(primaryRecoveryConfig.recovery_plate_a1_x_mm),
                    recoveryPlateA1Y: Number(primaryRecoveryConfig.recovery_plate_a1_y_mm),
                    plateWellPitchMm: numberFieldValue(platePitchField, 'plate_well_pitch_mm'),
                    source: calibration.source
                };
                var plateNumber = normalizePlateNumber(primaryPlateConfig.plate_number);
                var startWell = normalizeWellName(primaryPlateConfig.start_well);
                var plateId = 'P-' + plateNumber;
                var collectionCode = String(primaryEventConfig ? primaryEventConfig.collection_code || '' : '').trim();

                if (updated.xLeft === updated.xRight || updated.yTop === updated.yBottom) {
                    throw new Error('Tray scan bounds must span a non-zero X and Y range.');
                }
                if (updated.sizeClass.length === 0) {
                    throw new Error('Size class must not be blank.');
                }
                if (updated.plateWellPitchMm <= 0) {
                    throw new Error('Plate well pitch must be greater than zero.');
                }
                if (collectionCode.length === 0) {
                    throw new Error('Collection code must not be blank.');
                }
                if (updated.xLeft > updated.xRight) {
                    var swapX = updated.xLeft;
                    updated.xLeft = updated.xRight;
                    updated.xRight = swapX;
                }
                if (updated.yTop > updated.yBottom) {
                    var swapY = updated.yTop;
                    updated.yTop = updated.yBottom;
                    updated.yBottom = swapY;
                }
                var multiConfig = calibration.multiConfig
                    ? clonePlainObject(calibration.multiConfig)
                    : defaultMultiTrayCalibration(updated);
                multiConfig.shared.camera_x_offset_mm = updated.cameraXOffsetMm;
                multiConfig.shared.camera_y_offset_mm = updated.cameraYOffsetMm;
                multiConfig.shared.scan_bounds_are_camera_coordinates = updated.scanBoundsAreCameraCoordinates;
                multiConfig.shared.x_step_mm = updated.xStepMm;
                multiConfig.shared.y_step_mm = updated.yStepMm;
                multiConfig.shared.plate_well_pitch_mm = updated.plateWellPitchMm;
                multiConfig.shared.hires_tray_offset_x_mm = updated.hiResTrayOffsetX;
                multiConfig.shared.hires_tray_offset_y_mm = updated.hiResTrayOffsetY;
                multiConfig.shared.hires_focus_z_mm = updated.hiResFocusZMm;
                var primaryTray = multiSlotByNumber(multiConfig.sorting_trays, 'tray_slot', 1);
                if (primaryTray) {
                    primaryTray.enabled = true;
                    primaryTray.x_left_mm = updated.xLeft;
                    primaryTray.x_right_mm = updated.xRight;
                    primaryTray.y_top_mm = updated.yTop;
                    primaryTray.y_bottom_mm = updated.yBottom;
                    primaryTray.tray_height_mm = updated.trayHeightMm;
                    primaryTray.size_class = updated.sizeClass;
                    primaryTray.pick_z_mm = updated.pickZMm;
                }
                var primaryPlate = multiSlotByNumber(multiConfig.plates, 'plate_slot', 1);
                if (primaryPlate) {
                    primaryPlate.enabled = true;
                    primaryPlate.plate_number = plateNumber;
                    primaryPlate.start_well = startWell;
                    primaryPlate.plate_a1_x_mm = updated.plateA1X;
                    primaryPlate.plate_a1_y_mm = updated.plateA1Y;
                    primaryPlate.top_camera_a1_x_mm = updated.topCameraA1X;
                    primaryPlate.top_camera_a1_y_mm = updated.topCameraA1Y;
                    primaryPlate.plate_qa_camera_a1_x_mm = updated.plateQaCameraA1X;
                    primaryPlate.plate_qa_camera_a1_y_mm = updated.plateQaCameraA1Y;
                }
                var primaryRecovery = multiSlotByNumber(multiConfig.recovery_plates, 'recovery_slot', 1);
                if (primaryRecovery) {
                    primaryRecovery.enabled = true;
                    primaryRecovery.recovery_plate_a1_x_mm = updated.recoveryPlateA1X;
                    primaryRecovery.recovery_plate_a1_y_mm = updated.recoveryPlateA1Y;
                }
                var primaryEvent = multiSlotByNumber(multiConfig.collection_events, 'event_slot', 1);
                if (primaryEvent) {
                    primaryEvent.enabled = true;
                    primaryEvent.collection_code = collectionCode;
                    primaryEvent.plate_slot = 1;
                    primaryEvent.recovery_slot = 1;
                }
                multiConfig.active_collection_event_count = Math.max(1, Number(multiConfig.active_collection_event_count || 1));
                multiConfig.active_sorting_tray_count = Math.max(1, Number(multiConfig.active_sorting_tray_count || 1));
                multiConfig.active_plate_count = Math.max(1, Number(multiConfig.active_plate_count || 1));
                multiConfig.active_recovery_plate_count = Math.max(1, Number(multiConfig.active_recovery_plate_count || 1));
                updated.multiConfig = multiConfig;

                if (plateCsvFile(plateNumber).exists()) {
                    var recordedWells = occupiedWellCount(plateNumber);
                    var plateChoice = JOptionPane.showOptionDialog(
                        null,
                        'A spreadsheet already exists for plate ' + plateNumber
                            + ' with ' + recordedWells + ' recorded well(s).'
                            + '\n\nContinue from the next unrecorded well, or archive the old CSV and treat this as a fresh plate?',
                        'Existing plate warning',
                        JOptionPane.YES_NO_CANCEL_OPTION,
                        JOptionPane.WARNING_MESSAGE,
                        null,
                        Java.to(['Continue existing plate', 'Archive and restart plate', 'Cancel'], 'java.lang.Object[]'),
                        'Continue existing plate'
                    );
                    if (plateChoice === 1) {
                        archivePlateSpreadsheet(plateNumber);
                    }
                    else if (plateChoice === 0) {
                        reviewExistingPlateWells({
                            plateNumber: plateNumber,
                            plateId: plateId,
                            collectionCode: collectionCode,
                            startWell: startWell
                        });
                    }
                    else {
                        throw new Error('Choose a new plate number, continue the existing plate, or archive the old CSV.');
                    }
                }
                writeTrainingTrayCalibration(updated);
                updated.plateContext = plateContextForSlot(updated.multiConfig, 1);
                return updated;
            }
            catch (validationError) {
                JOptionPane.showMessageDialog(
                    null,
                    String(validationError.message || validationError),
                    'Invalid tray bounds',
                    JOptionPane.ERROR_MESSAGE
                );
            }
        }
    }

    function appendText(file, text) {
        var writer = new FileWriter(file, true);
        try {
            writer.write(text);
        }
        finally {
            writer.close();
        }
    }

    function writeStatus(statusFile, status, scanId, frameIndex, totalFrames, message) {
        var record = {
            status: status,
            scan_id: scanId,
            frame_index: frameIndex,
            total_frames: totalFrames,
            message: message,
            updated_at: new Date().toISOString()
        };
        writeText(statusFile, JSON.stringify(record, null, 2) + '\n');
    }

    function plateSpreadsheetRoot() {
        var dir = new File(projectDir, 'Plate_spreadsheets');
        dir.mkdirs();
        return dir;
    }

    function plateImageRoot() {
        var dir = new File(projectDir, 'Plate_insect_images');
        dir.mkdirs();
        return dir;
    }

    function plateAuditRoot() {
        var dir = new File(projectDir, 'Plate_audits');
        dir.mkdirs();
        return dir;
    }

    function plateTaxonomyRoot() {
        var dir = new File(projectDir, 'Plate_taxonomy');
        dir.mkdirs();
        return dir;
    }

    function normalizePlateNumber(text) {
        var value = String(text || '').trim().toUpperCase();
        value = value.replace(/[^A-Z0-9_-]/g, '');
        if (value.length === 0) {
            throw new Error('Plate number must not be blank.');
        }
        return value;
    }

    function normalizeWellName(text) {
        var value = String(text || '').trim().toUpperCase();
        var match = /^([A-H])([1-9]|1[0-2])$/.exec(value);
        if (match === null) {
            throw new Error('Starting well must be A1 through H12.');
        }
        return match[1] + String(Number(match[2]));
    }

    function wellIndexForName(wellName) {
        var normalized = normalizeWellName(wellName);
        var rowIndex = normalized.charCodeAt(0) - 'A'.charCodeAt(0);
        var columnIndex = Number(normalized.substring(1)) - 1;
        return (rowIndex * 12) + columnIndex;
    }

    var RESERVED_NEGATIVE_CONTROL_WELL = 'H12';
    var RESERVED_NEGATIVE_CONTROL_WELL_INDEX = wellIndexForName(RESERVED_NEGATIVE_CONTROL_WELL);
    var PLATE_FILLABLE_WELL_COUNT = 95;

    function isReservedPlateWellName(wellName) {
        return normalizeWellName(wellName) === RESERVED_NEGATIVE_CONTROL_WELL;
    }

    function isReservedPlateWellIndex(wellIndex) {
        return Number(wellIndex) === RESERVED_NEGATIVE_CONTROL_WELL_INDEX;
    }

    function plateCsvFile(plateNumber) {
        return new File(plateSpreadsheetRoot(), normalizePlateNumber(plateNumber) + '.csv');
    }

    function plateXlsxFile(plateNumber) {
        return new File(plateSpreadsheetRoot(), normalizePlateNumber(plateNumber) + '.xlsx');
    }

    function exportPlateXlsx(plateNumber) {
        var csvFile = plateCsvFile(plateNumber);
        if (!csvFile.exists()) {
            return false;
        }
        var exporter = new File(scriptsDir, 'plate_xlsx_export.py');
        var template = new File(new File(scriptsDir, 'Data'), 'plate_spreadsheet_template.xlsx');
        try {
            var builder = new Packages.java.lang.ProcessBuilder(
                python,
                exporter.getAbsolutePath(),
                csvFile.getAbsolutePath(),
                '--template',
                template.getAbsolutePath(),
                '--output',
                plateXlsxFile(plateNumber).getAbsolutePath()
            );
            builder.directory(projectDir);
            builder.redirectErrorStream(true);
            var process = builder.start();
            var exitCode = process.waitFor();
            if (exitCode !== 0) {
                print('Formatted XLSX export failed with exit ' + exitCode + ' for plate ' + plateNumber + '.');
                return false;
            }
            print('Updated formatted plate XLSX: ' + plateXlsxFile(plateNumber).getAbsolutePath());
            return true;
        }
        catch (error) {
            print('Formatted XLSX export failed for plate ' + plateNumber + ': ' + error);
            return false;
        }
    }

    function plateCsvHeaders() {
        return [
            'no.',
            'Plate number',
            'Plate ID',
            'Well Number',
            'Extract ID',
            'Image Code',
            'Project',
            'Collection Code',
            'Order',
            'Notes',
            'DNA concentration (ng/\u00b5l)',
            'Extract volume (\u00b5l)',
            'quantified volume',
            'Vol remaining',
            'Gel Results',
            'COI, ONT Sequencing Results',
            'Link to ELN PCR page',
            'Scan ID',
            'Target Number',
            'Object Index',
            'Source Scan Image',
            'HiRes Image',
            'Bottom Image',
            'Well Image',
            'Top Well Image',
            'Plating Confirmation'
        ];
    }

    function csvEscape(value) {
        var text = value === null || value === undefined ? '' : String(value);
        if (text.indexOf('"') >= 0 || text.indexOf(',') >= 0 || text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0) {
            return '"' + text.replace(/"/g, '""') + '"';
        }
        return text;
    }

    function csvLine(values) {
        var escaped = [];
        for (var i = 0; i < values.length; i++) {
            escaped.push(csvEscape(values[i]));
        }
        return escaped.join(',') + '\n';
    }

    function splitCsvLine(line) {
        var values = [];
        var current = '';
        var quoted = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line.charAt(i);
            if (quoted) {
                if (ch === '"') {
                    if (i + 1 < line.length && line.charAt(i + 1) === '"') {
                        current += '"';
                        i++;
                    }
                    else {
                        quoted = false;
                    }
                }
                else {
                    current += ch;
                }
            }
            else if (ch === '"') {
                quoted = true;
            }
            else if (ch === ',') {
                values.push(current);
                current = '';
            }
            else {
                current += ch;
            }
        }
        values.push(current);
        return values;
    }

    function normalizeCsvHeaderName(text) {
        return String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    function readPlateRows(plateNumber) {
        var file = plateCsvFile(plateNumber);
        var result = {
            headers: [],
            rows: []
        };
        if (!file.exists()) {
            return result;
        }

        var reader = new BufferedReader(new FileReader(file));
        try {
            var line = reader.readLine();
            var first = true;
            while (line !== null) {
                if (first) {
                    first = false;
                    result.headers = splitCsvLine(String(line));
                }
                else if (String(line).trim().length > 0) {
                    result.rows.push(splitCsvLine(String(line)));
                }
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }
        return result;
    }

    function plateRowsOnly(plateNumber) {
        return readPlateRows(plateNumber).rows;
    }

    function plateWellColumnIndex(plateData) {
        for (var i = 0; i < plateData.headers.length; i++) {
            var normalized = normalizeCsvHeaderName(plateData.headers[i]);
            if (normalized === 'wellnumber' || normalized === 'well' || normalized === 'wellname') {
                return i;
            }
        }
        return 3;
    }

    function plateCurrentStatusColumnIndex(plateData) {
        for (var i = 0; i < plateData.headers.length; i++) {
            var normalized = normalizeCsvHeaderName(plateData.headers[i]);
            if (normalized === 'currentstatus' || normalized === 'status' || normalized === 'notes') {
                return i;
            }
        }
        return -1;
    }

    function plateHeaderIndex(headers, headerName) {
        var normalizedName = normalizeCsvHeaderName(headerName);
        for (var i = 0; i < headers.length; i++) {
            if (normalizeCsvHeaderName(headers[i]) === normalizedName) {
                return i;
            }
        }
        return -1;
    }

    function plateRowValueByHeader(headers, row, headerName) {
        var index = plateHeaderIndex(headers, headerName);
        if (index < 0 || row.length <= index) {
            return '';
        }
        return row[index];
    }

    function setPlateRowValueByHeader(headers, row, headerName, value) {
        var index = plateHeaderIndex(headers, headerName);
        if (index < 0) {
            return;
        }
        while (row.length <= index) {
            row.push('');
        }
        row[index] = value === null || value === undefined ? '' : String(value);
    }

    function applyPlateTraceMetadata(headers, row, metadata) {
        if (!metadata) {
            return;
        }
        setPlateRowValueByHeader(headers, row, 'Scan ID', metadata.scanId || '');
        setPlateRowValueByHeader(headers, row, 'Target Number', metadata.targetNumber || '');
        setPlateRowValueByHeader(headers, row, 'Object Index', metadata.objectIndex || '');
        setPlateRowValueByHeader(headers, row, 'Source Scan Image', metadata.sourceScanImage || '');
        setPlateRowValueByHeader(headers, row, 'HiRes Image', metadata.hiResImage || '');
        setPlateRowValueByHeader(headers, row, 'Bottom Image', metadata.bottomImage || '');
        setPlateRowValueByHeader(headers, row, 'Well Image', metadata.wellImage || '');
        setPlateRowValueByHeader(headers, row, 'Top Well Image', metadata.topWellImage || '');
        setPlateRowValueByHeader(headers, row, 'Plating Confirmation', metadata.confirmation || '');
    }

    function plateRowForHeaders(sourceHeaders, sourceRow, targetHeaders) {
        var row = [];
        for (var i = 0; i < targetHeaders.length; i++) {
            var header = targetHeaders[i];
            var value = plateRowValueByHeader(sourceHeaders, sourceRow, header);
            if (header === 'Project' && String(value || '').trim().length === 0) {
                value = 'CIB';
            }
            else if (header === 'Notes' && String(value || '').trim().length === 0) {
                value = plateRowValueByHeader(sourceHeaders, sourceRow, 'Current Status');
            }
            row.push(value);
        }
        return row;
    }

    function plateExtractIdColumnIndex(plateData) {
        for (var i = 0; i < plateData.headers.length; i++) {
            var normalized = normalizeCsvHeaderName(plateData.headers[i]);
            if (normalized === 'extractid' || normalized === 'fieldid' || normalized === 'specimenid') {
                return i;
            }
        }
        return 4;
    }

    function rowMarksWellUnavailable(row, statusColumnIndex) {
        if (statusColumnIndex < 0 || row.length <= statusColumnIndex) {
            return false;
        }
        var status = normalizeCsvHeaderName(row[statusColumnIndex]);
        return status === 'empty'
            || status === 'emptyaftermanualreview'
            || status === 'unfilled'
            || status === 'failed'
            || status === 'failedpick'
            || status === 'failedplace'
            || status === 'ignore'
            || status === 'available';
    }

    function plateNumberColumnIndex(plateData) {
        for (var i = 0; i < plateData.headers.length; i++) {
            var normalized = normalizeCsvHeaderName(plateData.headers[i]);
            if (normalized === 'no' || normalized === 'number' || normalized === 'row') {
                return i;
            }
        }
        return 0;
    }

    function sortPlateSpreadsheetRows(plateNumber) {
        var file = plateCsvFile(plateNumber);
        if (!file.exists()) {
            return;
        }

        var plateData = readPlateRows(plateNumber);
        if (plateData.rows.length <= 1) {
            exportPlateXlsx(plateNumber);
            return;
        }

        var wellColumnIndex = plateWellColumnIndex(plateData);
        var numberColumnIndex = plateNumberColumnIndex(plateData);
        var rows = plateData.rows.slice(0);
        rows.sort(function(left, right) {
            var leftIndex = 9999;
            var rightIndex = 9999;
            try {
                if (left.length > wellColumnIndex && left[wellColumnIndex]) {
                    leftIndex = wellIndexForName(left[wellColumnIndex]);
                }
            }
            catch (leftError) {
                leftIndex = 9999;
            }
            try {
                if (right.length > wellColumnIndex && right[wellColumnIndex]) {
                    rightIndex = wellIndexForName(right[wellColumnIndex]);
                }
            }
            catch (rightError) {
                rightIndex = 9999;
            }
            if (leftIndex !== rightIndex) {
                return leftIndex - rightIndex;
            }
            return 0;
        });

        var output = csvLine(plateData.headers.length > 0 ? plateData.headers : plateCsvHeaders());
        for (var i = 0; i < rows.length; i++) {
            if (numberColumnIndex >= 0) {
                while (rows[i].length <= numberColumnIndex) {
                    rows[i].push('');
                }
                rows[i][numberColumnIndex] = String(i + 1);
            }
            output += csvLine(rows[i]);
        }
        writeText(file, output);
        exportPlateXlsx(plateNumber);
        print('Sorted plate spreadsheet by well order: ' + file.getAbsolutePath());
    }

    function plateHeadersMatchExpected(headers) {
        var expected = plateCsvHeaders();
        if (headers.length !== expected.length) {
            return false;
        }
        for (var i = 0; i < expected.length; i++) {
            if (String(headers[i]) !== String(expected[i])) {
                return false;
            }
        }
        return true;
    }

    function migratePlateSpreadsheetColumns(plateNumber) {
        var file = plateCsvFile(plateNumber);
        if (!file.exists()) {
            return;
        }
        var plateData = readPlateRows(plateNumber);
        var expectedHeaders = plateCsvHeaders();
        if (plateHeadersMatchExpected(plateData.headers)) {
            return;
        }
        var output = csvLine(expectedHeaders);
        for (var i = 0; i < plateData.rows.length; i++) {
            output += csvLine(plateRowForHeaders(plateData.headers, plateData.rows[i], expectedHeaders));
        }
        writeText(file, output);
        sortPlateSpreadsheetRows(plateNumber);
        print('Migrated plate spreadsheet columns to current format: ' + file.getAbsolutePath());
    }

    function occupiedWellSet(plateNumber) {
        var plateData = readPlateRows(plateNumber);
        var rows = plateData.rows;
        var wellColumnIndex = plateWellColumnIndex(plateData);
        var statusColumnIndex = plateCurrentStatusColumnIndex(plateData);
        var occupied = {};
        for (var i = 0; i < rows.length; i++) {
            if (rowMarksWellUnavailable(rows[i], statusColumnIndex)) {
                continue;
            }
            if (rows[i].length > wellColumnIndex && rows[i][wellColumnIndex]) {
                try {
                    occupied[normalizeWellName(rows[i][wellColumnIndex])] = true;
                }
                catch (wellError) {
                    print('Ignoring invalid well value in plate CSV row ' + (i + 2)
                        + ': ' + rows[i][wellColumnIndex]);
                }
            }
        }
        return occupied;
    }

    function occupiedWellCount(plateNumber) {
        var occupied = occupiedWellSet(plateNumber);
        var count = 0;
        for (var wellName in occupied) {
            if (occupied.hasOwnProperty(wellName)) {
                count++;
            }
        }
        return count;
    }

    function isPlateCompletelyFilled(plateNumber) {
        return occupiedWellCount(plateNumber) >= PLATE_FILLABLE_WELL_COUNT;
    }

    function plateRowForWell(plateContext, wellName, status, metadata) {
        var plateNumber = normalizePlateNumber(plateContext.plateNumber);
        metadata = metadata || {};
        return [
            '',
            plateNumber,
            plateContext.plateId,
            wellName,
            'DNA-' + plateNumber + '-' + wellName,
            imageCodeForWell(plateNumber, wellName),
            'CIB',
            plateContext.collectionCode,
            '',
            status || '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            metadata.scanId || '',
            metadata.targetNumber || '',
            metadata.objectIndex || '',
            metadata.sourceScanImage || '',
            metadata.hiResImage || '',
            metadata.bottomImage || '',
            metadata.wellImage || '',
            metadata.confirmation || ''
        ];
    }

    function wellReviewStateForPlate(plateContext) {
        var plateData = readPlateRows(plateContext.plateNumber);
        var wellColumnIndex = plateWellColumnIndex(plateData);
        var statusColumnIndex = plateCurrentStatusColumnIndex(plateData);
        var extractColumnIndex = plateExtractIdColumnIndex(plateData);
        var startIndex = wellIndexForName(plateContext.startWell);
        var byWell = {};

        for (var i = 0; i < plateData.rows.length; i++) {
            var row = plateData.rows[i];
            if (row.length <= wellColumnIndex || !row[wellColumnIndex]) {
                continue;
            }
            try {
                var wellName = normalizeWellName(row[wellColumnIndex]);
                if (!byWell[wellName]) {
                    byWell[wellName] = {
                        occupied: !rowMarksWellUnavailable(row, statusColumnIndex),
                        fieldId: row.length > extractColumnIndex ? String(row[extractColumnIndex] || '') : ''
                    };
                }
            }
            catch (wellError) {
                print('Ignoring invalid well value during plate review: ' + row[wellColumnIndex]);
            }
        }

        var states = {};
        for (var index = 0; index < 96; index++) {
            var name = wellNameForIndex(index);
            var existing = byWell[name];
            var occupied = existing ? Boolean(existing.occupied) : false;
            states[name] = {
                index: index,
                name: name,
                enabled: !isReservedPlateWellIndex(index),
                inRunRange: index >= startIndex && !isReservedPlateWellIndex(index),
                occupied: occupied,
                originalOccupied: occupied,
                fieldId: existing ? existing.fieldId : ''
            };
        }
        return states;
    }

    function syncPlateReviewStateToCsv(plateContext, states) {
        ensurePlateSpreadsheetHeader(plateContext);
        var plateData = readPlateRows(plateContext.plateNumber);
        var headers = plateData.headers.length > 0 ? plateData.headers : plateCsvHeaders();
        var wellColumnIndex = plateWellColumnIndex({ headers: headers, rows: plateData.rows });
        var statusColumnIndex = plateCurrentStatusColumnIndex({ headers: headers, rows: plateData.rows });
        var numberColumnIndex = plateNumberColumnIndex({ headers: headers, rows: plateData.rows });
        var rows = plateData.rows.slice(0);
        var rowByWell = {};

        if (statusColumnIndex < 0) {
            headers.push('Notes');
            statusColumnIndex = headers.length - 1;
        }

        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (row.length <= wellColumnIndex || !row[wellColumnIndex]) {
                continue;
            }
            try {
                var wellName = normalizeWellName(row[wellColumnIndex]);
                if (!rowByWell[wellName]) {
                    rowByWell[wellName] = row;
                }
            }
            catch (wellError) {
                print('Ignoring invalid well value while syncing plate review: ' + row[wellColumnIndex]);
            }
        }

        for (var index = 0; index < 96; index++) {
            var name = wellNameForIndex(index);
            if (isReservedPlateWellIndex(index) || !states[name]) {
                continue;
            }
            var state = states[name];
            var existingRow = rowByWell[name];
            if (existingRow) {
                while (existingRow.length <= statusColumnIndex) {
                    existingRow.push('');
                }
                existingRow[statusColumnIndex] = state.occupied
                    ? ''
                    : state.originalOccupied
                    ? 'empty after manual review'
                    : 'empty';
                if (state.occupied) {
                    recoverOccupiedWellReviewRow(plateContext, headers, existingRow, name);
                }
            }
            else if (state.occupied) {
                var newRow = plateRowForWell(plateContext, name, 'occupied');
                recoverOccupiedWellReviewRow(plateContext, headers, newRow, name);
                rows.push(newRow);
                rowByWell[name] = newRow;
            }
        }

        rows.sort(function(left, right) {
            var leftIndex = 9999;
            var rightIndex = 9999;
            try {
                if (left.length > wellColumnIndex && left[wellColumnIndex]) {
                    leftIndex = wellIndexForName(left[wellColumnIndex]);
                }
            }
            catch (leftError) {
                leftIndex = 9999;
            }
            try {
                if (right.length > wellColumnIndex && right[wellColumnIndex]) {
                    rightIndex = wellIndexForName(right[wellColumnIndex]);
                }
            }
            catch (rightError) {
                rightIndex = 9999;
            }
            return leftIndex - rightIndex;
        });

        var output = csvLine(headers);
        for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            if (numberColumnIndex >= 0) {
                while (rows[rowIndex].length <= numberColumnIndex) {
                    rows[rowIndex].push('');
                }
                rows[rowIndex][numberColumnIndex] = String(rowIndex + 1);
            }
            output += csvLine(rows[rowIndex]);
        }
        writeText(plateCsvFile(plateContext.plateNumber), output);
        sortPlateSpreadsheetRows(plateContext.plateNumber);
        print('Updated plate CSV from well review: ' + plateCsvFile(plateContext.plateNumber).getAbsolutePath());
    }

    function reviewExistingPlateWells(plateContext, dialogTitle, instructions) {
        var ActionListener = Packages.java.awt.event.ActionListener;
        var states = wellReviewStateForPlate(plateContext);
        var occupiedColor = new Color(190, 45, 45);
        var availableColor = new Color(38, 150, 86);
        var unavailableColor = new Color(130, 130, 130);
        var textColor = Color.WHITE;
        var buttons = {};

        function updateButton(name) {
            var button = buttons[name];
            var state = states[name];
            if (!button || !state) {
                return;
            }
            var label = '<html><center>' + state.name;
            if (state.fieldId && state.fieldId.length > 0) {
                label += '<br><font size="-2">' + state.fieldId + '</font>';
            }
            else {
                label += '<br><font size="-2">&nbsp;</font>';
            }
            label += '</center></html>';
            button.setText(label);
            button.setOpaque(true);
            button.setBorderPainted(true);
            button.setForeground(textColor);
            var isAvailableThisRun = state.enabled && state.inRunRange && !state.occupied;
            button.setBackground(state.occupied ? occupiedColor : isAvailableThisRun ? availableColor : unavailableColor);
            button.setToolTipText(
                state.enabled
                    ? (state.name + (state.occupied
                        ? ' marked occupied; click to make available'
                        : state.inRunRange
                        ? ' marked available for this run; click to make occupied'
                        : ' before starting well; click to make occupied'))
                    : (state.name + ' reserved negative control')
            );
        }

        var panel = new JPanel(new BorderLayout(10, 10));
        panel.add(
            new JLabel(
                '<html>' + (instructions || ('Verify plate ' + plateContext.plateNumber + '.'))
                    + ' Red wells are treated as occupied. Green wells are empty or available. '
                    + 'Click any well to toggle. ' + RESERVED_NEGATIVE_CONTROL_WELL
                    + ' remains reserved.</html>'
            ),
            BorderLayout.NORTH
        );

        var grid = new JPanel(new GridLayout(8, 12, 4, 4));
        for (var row = 0; row < 8; row++) {
            for (var column = 0; column < 12; column++) {
                var wellIndex = (row * 12) + column;
                var wellName = wellNameForIndex(wellIndex);
                var button = new JButton();
                button.setPreferredSize(new Dimension(82, 58));
                button.setEnabled(!isReservedPlateWellIndex(wellIndex));
                buttons[wellName] = button;
                updateButton(wellName);
                button.addActionListener(new ActionListener({
                    actionPerformed: (function(name) {
                        return function(event) {
                            states[name].occupied = !states[name].occupied;
                            updateButton(name);
                        };
                    })(wellName)
                }));
                grid.add(button);
            }
        }

        var legend = new JPanel(new GridLayout(1, 3, 8, 4));
        var redLabel = new JLabel('Red: occupied / skip');
        redLabel.setOpaque(true);
        redLabel.setBackground(occupiedColor);
        redLabel.setForeground(textColor);
        var greenLabel = new JLabel('Green: empty / available');
        greenLabel.setOpaque(true);
        greenLabel.setBackground(availableColor);
        greenLabel.setForeground(textColor);
        var grayLabel = new JLabel('Gray: reserved / before start');
        grayLabel.setOpaque(true);
        grayLabel.setBackground(unavailableColor);
        grayLabel.setForeground(textColor);
        legend.add(redLabel);
        legend.add(greenLabel);
        legend.add(grayLabel);

        var center = new JPanel(new BorderLayout(0, 8));
        center.add(grid, BorderLayout.CENTER);
        center.add(legend, BorderLayout.SOUTH);
        panel.add(center, BorderLayout.CENTER);

        var result = JOptionPane.showConfirmDialog(
            null,
            panel,
            dialogTitle || 'Review plate wells',
            JOptionPane.OK_CANCEL_OPTION,
            JOptionPane.QUESTION_MESSAGE
        );
        if (result !== JOptionPane.OK_OPTION) {
            throw new Error('Plate well review was cancelled.');
        }
        syncPlateReviewStateToCsv(plateContext, states);
        return states;
    }

    function reconcileEmptyWellsFromPlateMap(plateContext, states, emptyWells) {
        var byWell = {};
        var reconciled = [];
        for (var i = 0; i < emptyWells.length; i++) {
            byWell[String(emptyWells[i].name)] = emptyWells[i];
        }
        for (var index = 0; index < 96; index++) {
            if (isReservedPlateWellIndex(index)) {
                continue;
            }
            var name = wellNameForIndex(index);
            var state = states[name];
            if (!state || state.occupied) {
                continue;
            }
            if (byWell[name]) {
                reconciled.push(byWell[name]);
                continue;
            }
            if (!state.originalOccupied) {
                continue;
            }
            var latestAttempt = latestPlateAttemptForWell(plateContext, name);
            reconciled.push({
                index: index,
                name: name,
                reviewKind: 'well_occupancy',
                imageFile: latestAttempt === null ? null : resolveAttemptImageFile(latestAttempt, 'well'),
                hiResImageFile: latestAttempt === null ? null : resolveAttemptImageFile(latestAttempt, 'hires'),
                bottomImageFile: latestAttempt === null ? null : resolveAttemptImageFile(latestAttempt, 'bottom'),
                target: null,
                targetIndex: latestAttempt === null ? null : Number(latestAttempt.targetNumber || 1) - 1,
                reason: 'manually marked empty in plate map'
            });
        }
        reconciled.sort(function(left, right) {
            return Number(left.index) - Number(right.index);
        });
        return reconciled;
    }

    function archivePlateSpreadsheet(plateNumber) {
        var file = plateCsvFile(plateNumber);
        if (!file.exists()) {
            return null;
        }

        var normalizedPlateNumber = normalizePlateNumber(plateNumber);
        var archive = new File(
            plateSpreadsheetRoot(),
            normalizedPlateNumber + '.archived_' + timestamp() + '.csv'
        );
        Packages.java.nio.file.Files.move(
            file.toPath(),
            archive.toPath(),
            Packages.java.nio.file.StandardCopyOption.REPLACE_EXISTING
        );
        var xlsxFile = plateXlsxFile(plateNumber);
        if (xlsxFile.exists()) {
            var xlsxArchive = new File(
                plateSpreadsheetRoot(),
                normalizedPlateNumber + '.archived_' + timestamp() + '.xlsx'
            );
            Packages.java.nio.file.Files.move(
                xlsxFile.toPath(),
                xlsxArchive.toPath(),
                Packages.java.nio.file.StandardCopyOption.REPLACE_EXISTING
            );
            print('Archived formatted plate workbook to ' + xlsxArchive.getAbsolutePath());
        }
        print('Archived plate spreadsheet ' + file.getAbsolutePath()
            + ' to ' + archive.getAbsolutePath());
        return archive;
    }

    function imageCodeForWell(plateNumber, wellName) {
        return 'IMG-DNA-' + normalizePlateNumber(plateNumber) + '-' + normalizeWellName(wellName);
    }

    function plateImageFolder(plateNumber) {
        var dir = new File(plateImageRoot(), 'P-' + normalizePlateNumber(plateNumber));
        dir.mkdirs();
        return dir;
    }

    function copyImageFile(sourceImageFile, destination) {
        if (sourceImageFile === null || sourceImageFile === undefined || !sourceImageFile.exists()) {
            return null;
        }
        Packages.java.nio.file.Files.copy(
            sourceImageFile.toPath(),
            destination.toPath(),
            Packages.java.nio.file.StandardCopyOption.REPLACE_EXISTING
        );
        return destination;
    }

    function copyPlateSpecimenImages(scanDir, plateContext, well, target, hiResImageFile, bottomImageFile, wellImageFile, topWellImageFile) {
        var imageCode = imageCodeForWell(plateContext.plateNumber, well.name);
        var destinationDir = plateImageFolder(plateContext.plateNumber);
        var copied = 0;
        if (copyImageFile(hiResImageFile, new File(destinationDir, imageCode + '_hires.png')) !== null) {
            copied++;
        }
        if (copyImageFile(bottomImageFile, new File(destinationDir, imageCode + '_bottom.png')) !== null) {
            copied++;
        }
        var reviewWellImageFile = wellImageFile;
        if ((reviewWellImageFile === null || reviewWellImageFile === undefined || !reviewWellImageFile.exists())
                && topWellImageFile !== null
                && topWellImageFile !== undefined
                && topWellImageFile.exists()) {
            reviewWellImageFile = topWellImageFile;
            print('Using Lumen well image as the review image fallback for manually confirmed occupied well '
                + well.name + '.');
        }
        if (copyImageFile(reviewWellImageFile, new File(destinationDir, imageCode + '_well.png')) !== null) {
            copied++;
        }
        if (target !== null && target !== undefined && target.cropFile && String(target.cropFile).length > 0) {
            var scanImageFile = new File(scanDir, String(target.cropFile));
            if (copyImageFile(scanImageFile, new File(destinationDir, imageCode + '_scan.png')) !== null) {
                copied++;
            }
        }
        print('Copied ' + copied + ' plate review image(s) to ' + destinationDir.getAbsolutePath()
            + ' for ' + imageCode);
    }

    function resolveAttemptImageFile(attempt, kind) {
        if (!attempt || !attempt.scanDir) {
            return null;
        }
        var scanDir = new File(String(attempt.scanDir));
        var name = '';
        var candidates = [];
        if (kind === 'scan') {
            name = String(attempt.sourceScanImage || '');
            if (name.length > 0) {
                candidates.push(new File(scanDir, name));
            }
        }
        else if (kind === 'hires') {
            name = String(attempt.hiResImage || '');
            if (name.length > 0) {
                candidates.push(new File(scanDir, 'hires/' + name));
                candidates.push(new File(scanDir, name));
            }
        }
        else if (kind === 'bottom') {
            name = String(attempt.bottomImage || '');
            if (name.length > 0) {
                candidates.push(new File(scanDir, 'bottom_inspections/' + name));
                candidates.push(new File(scanDir, name));
            }
        }
        else if (kind === 'well_top') {
            name = String(attempt.topWellImage || '');
            if (name.length > 0) {
                candidates.push(new File(scanDir, 'qa/wells_top/' + name));
            }
        }
        else if (kind === 'well') {
            name = String(attempt.wellImage || '');
            if (name.length > 0) {
                candidates.push(new File(scanDir, 'qa/wells/' + name));
                candidates.push(new File(scanDir, name));
            }
            name = String(attempt.topWellImage || '');
            if (name.length > 0) {
                candidates.push(new File(scanDir, 'qa/wells_top/' + name));
            }
        }
        for (var i = 0; i < candidates.length; i++) {
            if (candidates[i].exists()) {
                return candidates[i];
            }
        }
        return null;
    }

    function latestPlateAttemptForWell(plateContext, wellName) {
        var file = plateAttemptLogFile(plateContext);
        if (!file.exists()) {
            return null;
        }
        var normalizedPlate = normalizePlateNumber(plateContext.plateNumber);
        var normalizedWell = normalizeWellName(wellName);
        var latest = null;
        var reader = new BufferedReader(new FileReader(file));
        try {
            var line = reader.readLine();
            while (line !== null) {
                var text = String(line || '').trim();
                if (text.length > 0) {
                    try {
                        var attempt = JSON.parse(text);
                        if (normalizePlateNumber(attempt.plate_number || normalizedPlate) === normalizedPlate
                                && normalizeWellName(attempt.well || '') === normalizedWell
                                && resolveAttemptImageFile(attempt, 'scan') !== null
                                && resolveAttemptImageFile(attempt, 'hires') !== null
                                && resolveAttemptImageFile(attempt, 'bottom') !== null
                                && resolveAttemptImageFile(attempt, 'well') !== null) {
                            latest = attempt;
                        }
                    }
                    catch (attemptError) {
                    }
                }
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }
        return latest;
    }

    function copyPlateSpecimenImagesFromAttempt(plateContext, well, attempt) {
        if (!attempt) {
            return 0;
        }
        var imageCode = imageCodeForWell(plateContext.plateNumber, well.name);
        var destinationDir = plateImageFolder(plateContext.plateNumber);
        var copied = 0;
        var kinds = ['scan', 'hires', 'bottom', 'well'];
        for (var i = 0; i < kinds.length; i++) {
            var kind = kinds[i];
            var source = resolveAttemptImageFile(attempt, kind);
            if (source !== null && copyImageFile(source, new File(destinationDir, imageCode + '_' + kind + '.png')) !== null) {
                copied++;
            }
        }
        print('Recovered ' + copied + ' review image(s) for manually occupied well '
            + well.name + ' from latest plate attempt.');
        return copied;
    }

    function plateTraceMetadataFromAttempt(attempt, confirmation) {
        return {
            scanId: attempt === null || attempt === undefined ? '' : String(attempt.scanId || ''),
            targetNumber: attempt === null || attempt === undefined ? '' : attempt.targetNumber,
            objectIndex: attempt === null || attempt === undefined ? '' : attempt.objectIndex,
            sourceScanImage: attempt === null || attempt === undefined ? '' : String(attempt.sourceScanImage || ''),
            hiResImage: attempt === null || attempt === undefined ? '' : String(attempt.hiResImage || ''),
            bottomImage: attempt === null || attempt === undefined ? '' : String(attempt.bottomImage || ''),
            wellImage: attempt === null || attempt === undefined
                ? ''
                : String(attempt.wellImage || attempt.topWellImage || ''),
            topWellImage: attempt === null || attempt === undefined ? '' : String(attempt.topWellImage || ''),
            confirmation: confirmation || 'manual occupied review recovered from latest attempt'
        };
    }

    function rowMissingPlateTraceMetadata(headers, row) {
        return String(plateRowValueByHeader(headers, row, 'Scan ID') || '').trim().length === 0
            || String(plateRowValueByHeader(headers, row, 'Target Number') || '').trim().length === 0
            || String(plateRowValueByHeader(headers, row, 'Source Scan Image') || '').trim().length === 0
            || String(plateRowValueByHeader(headers, row, 'Well Image') || '').trim().length === 0;
    }

    function recoverOccupiedWellReviewRow(plateContext, headers, row, wellName) {
        if (!rowMissingPlateTraceMetadata(headers, row)) {
            return false;
        }
        var attempt = latestPlateAttemptForWell(plateContext, wellName);
        if (attempt === null) {
            print('No recoverable latest attempt found for occupied well review ' + wellName + '.');
            return false;
        }
        var metadata = plateTraceMetadataFromAttempt(
            attempt,
            'occupied well review recovered from latest attempt'
        );
        applyPlateTraceMetadata(headers, row, metadata);
        copyPlateSpecimenImagesFromAttempt(
            plateContext,
            {
                name: normalizeWellName(wellName),
                index: wellIndexForName(wellName)
            },
            attempt
        );
        print('Backfilled occupied well review row for ' + wellName
            + ' from latest plate attempt ' + metadata.scanId + '.');
        return true;
    }

    function latestPlateAuditFile(plateContext) {
        return new File(plateAuditFolder(plateContext.plateNumber), 'plate_audit_latest.json');
    }

    function plateAuditFolder(plateNumber) {
        var dir = new File(plateAuditRoot(), 'P-' + normalizePlateNumber(plateNumber));
        dir.mkdirs();
        return dir;
    }

    function runCompletedPlateAudit(plateContext, triggerScanId) {
        var plateNumber = normalizePlateNumber(plateContext.plateNumber);
        var plateData = readPlateRows(plateNumber);
        var headers = plateData.headers.length > 0 ? plateData.headers : plateCsvHeaders();
        var wellColumnIndex = plateWellColumnIndex({ headers: headers, rows: plateData.rows });
        var statusColumnIndex = plateCurrentStatusColumnIndex({ headers: headers, rows: plateData.rows });
        var imageDir = plateImageFolder(plateNumber);
        var auditDir = plateAuditFolder(plateNumber);
        var expectedImageKinds = ['scan', 'hires', 'bottom', 'well'];
        var occupied = {};
        var duplicateWells = [];
        var invalidWellRows = [];
        var missingRows = [];
        var unavailableRows = [];
        var missingImages = [];
        var missingTraceMetadata = [];
        var suspectOccupiedWells = [];

        for (var rowIndex = 0; rowIndex < plateData.rows.length; rowIndex++) {
            var row = plateData.rows[rowIndex];
            if (rowMarksWellUnavailable(row, statusColumnIndex)) {
                unavailableRows.push(rowIndex + 2);
                continue;
            }
            if (row.length <= wellColumnIndex || !row[wellColumnIndex]) {
                missingRows.push(rowIndex + 2);
                continue;
            }
            try {
                var rowWell = normalizeWellName(row[wellColumnIndex]);
                if (isReservedPlateWellName(rowWell)) {
                    invalidWellRows.push({
                        row: rowIndex + 2,
                        well: rowWell,
                        reason: 'reserved negative-control well'
                    });
                    continue;
                }
                if (occupied[rowWell]) {
                    duplicateWells.push(rowWell);
                }
                occupied[rowWell] = true;
            }
            catch (wellError) {
                invalidWellRows.push({
                    row: rowIndex + 2,
                    well: row.length > wellColumnIndex ? String(row[wellColumnIndex]) : '',
                    reason: String(wellError.message || wellError)
                });
            }
        }

        for (var wellIndex = 0; wellIndex < 96; wellIndex++) {
            var wellName = wellNameForIndex(wellIndex);
            if (isReservedPlateWellName(wellName)) {
                continue;
            }
            if (!occupied[wellName]) {
                missingRows.push(wellName);
                continue;
            }
            var imageCode = imageCodeForWell(plateNumber, wellName);
            var missingForWell = [];
            for (var imageIndex = 0; imageIndex < expectedImageKinds.length; imageIndex++) {
                var kind = expectedImageKinds[imageIndex];
                var imageFile = new File(imageDir, imageCode + '_' + kind + '.png');
                if (!imageFile.exists()) {
                    missingForWell.push(kind);
                }
            }
            if (missingForWell.length > 0) {
                missingImages.push({
                    well: wellName,
                    missing: missingForWell
                });
            }
        }

        var scanIdColumn = plateHeaderIndex(headers, 'Scan ID');
        var targetNumberColumn = plateHeaderIndex(headers, 'Target Number');
        var sourceImageColumn = plateHeaderIndex(headers, 'Source Scan Image');
        for (var metadataRowIndex = 0; metadataRowIndex < plateData.rows.length; metadataRowIndex++) {
            var metadataRow = plateData.rows[metadataRowIndex];
            if (rowMarksWellUnavailable(metadataRow, statusColumnIndex)
                    || metadataRow.length <= wellColumnIndex
                    || !metadataRow[wellColumnIndex]) {
                continue;
            }
            var metadataWell = '';
            try {
                metadataWell = normalizeWellName(metadataRow[wellColumnIndex]);
            }
            catch (metadataWellError) {
                continue;
            }
            if (isReservedPlateWellName(metadataWell)) {
                continue;
            }
            if ((scanIdColumn >= 0 && String(metadataRow[scanIdColumn] || '').trim().length === 0)
                    || (targetNumberColumn >= 0 && String(metadataRow[targetNumberColumn] || '').trim().length === 0)
                    || (sourceImageColumn >= 0 && String(metadataRow[sourceImageColumn] || '').trim().length === 0)) {
                missingTraceMetadata.push(metadataWell);
            }
        }

        var latestAttemptsByWell = {};
        var attemptFile = plateAttemptLogFile(plateContext);
        if (attemptFile.exists()) {
            var attemptReader = new BufferedReader(new FileReader(attemptFile));
            try {
                var attemptLine = attemptReader.readLine();
                while (attemptLine !== null) {
                    var attemptText = String(attemptLine || '').trim();
                    if (attemptText.length > 0) {
                        try {
                            var attemptRecord = JSON.parse(attemptText);
                            if (normalizePlateNumber(attemptRecord.plate_number || plateNumber) === plateNumber
                                    && String(attemptRecord.well || '').trim().length > 0) {
                                latestAttemptsByWell[normalizeWellName(attemptRecord.well)] = attemptRecord;
                            }
                        }
                        catch (attemptParseError) {
                        }
                    }
                    attemptLine = attemptReader.readLine();
                }
            }
            finally {
                attemptReader.close();
            }
        }

        for (var suspectWellName in occupied) {
            if (!occupied.hasOwnProperty(suspectWellName) || isReservedPlateWellName(suspectWellName)) {
                continue;
            }
            var latestAttempt = latestAttemptsByWell[suspectWellName];
            if (latestAttempt === null || latestAttempt === undefined) {
                continue;
            }
            var latestConfirmation = String(latestAttempt.confirmation || '').toLowerCase();
            var bottomPresent = latestAttempt.bottom_bug_present === true
                || String(latestAttempt.bottom_bug_present || '').toLowerCase() === 'true';
            var relativeOnlyWell = latestAttempt.well_relative_only_occupancy === true
                || String(latestAttempt.well_relative_only_occupancy || '').toLowerCase() === 'true';
            if (latestConfirmation === 'well qa occupied' && (!bottomPresent || relativeOnlyWell)) {
                suspectOccupiedWells.push({
                    well: suspectWellName,
                    reason: relativeOnlyWell
                        ? 'well QA was relative-only texture'
                        : 'bottom inspection did not confirm specimen on nozzle',
                    scan_id: String(latestAttempt.scanId || ''),
                    target_number: String(latestAttempt.targetNumber || '')
                });
            }
        }

        var occupiedCount = 0;
        for (var occupiedWell in occupied) {
            if (occupied.hasOwnProperty(occupiedWell)) {
                occupiedCount++;
            }
        }

        var passed = occupiedCount >= PLATE_FILLABLE_WELL_COUNT
            && duplicateWells.length === 0
            && invalidWellRows.length === 0
            && missingRows.length === 0
            && missingImages.length === 0
            && missingTraceMetadata.length === 0;
        var report = {
            plate_number: plateNumber,
            audited_at: new Date().toISOString(),
            trigger_scan_id: triggerScanId || '',
            fillable_wells_expected: PLATE_FILLABLE_WELL_COUNT,
            occupied_wells_found: occupiedCount,
            reserved_negative_control_well: RESERVED_NEGATIVE_CONTROL_WELL,
            passed: passed,
            duplicate_wells: duplicateWells,
            invalid_well_rows: invalidWellRows,
            missing_or_unoccupied_wells: missingRows,
            unavailable_csv_rows: unavailableRows,
            missing_images: missingImages,
            missing_trace_metadata: missingTraceMetadata,
            suspect_occupied_wells: suspectOccupiedWells
        };
        var auditFile = new File(auditDir, 'plate_audit_' + timestamp() + '.json');
        writeText(auditFile, JSON.stringify(report, null, 2) + '\n');
        writeText(latestPlateAuditFile(plateContext), JSON.stringify(report, null, 2) + '\n');
        print('Completed plate audit for ' + plateNumber + ': '
            + (passed ? 'PASS' : 'CHECK NEEDED')
            + '. Report: ' + auditFile.getAbsolutePath());
        return report;
    }

    function auditProblemCount(auditReport) {
        return Number(auditReport.duplicate_wells.length)
            + Number(auditReport.invalid_well_rows.length)
            + Number(auditReport.missing_or_unoccupied_wells.length)
            + Number(auditReport.missing_images.length)
            + Number(auditReport.missing_trace_metadata.length);
    }

    function auditWarningCount(auditReport) {
        return auditReport.suspect_occupied_wells === undefined
            || auditReport.suspect_occupied_wells === null
            ? 0
            : Number(auditReport.suspect_occupied_wells.length);
    }

    function completedPlateAuditMessage(auditReport, taxonomyLaunched) {
        var problemCount = auditProblemCount(auditReport);
        var warningCount = auditWarningCount(auditReport);
        var message = 'Completed plate audit for ' + auditReport.plate_number + '.'
            + '\n\nOccupied wells found: ' + auditReport.occupied_wells_found
            + '/' + auditReport.fillable_wells_expected
            + '\nAudit status: ' + (auditReport.passed ? 'PASS' : 'NEEDS REVIEW')
            + '\nTaxonomy: ' + (auditReport.passed
                ? (taxonomyLaunched ? 'launched' : 'launch failed or unavailable')
                : 'not launched');
        if (problemCount > 0) {
            message += '\n\nProblems requiring review: ' + problemCount
                + '\nMissing/unoccupied wells: ' + auditReport.missing_or_unoccupied_wells.length
                + '\nMissing image sets: ' + auditReport.missing_images.length
                + '\nMissing trace metadata: ' + auditReport.missing_trace_metadata.length
                + '\nDuplicate wells: ' + auditReport.duplicate_wells.length
                + '\nInvalid rows: ' + auditReport.invalid_well_rows.length;
        }
        if (warningCount > 0) {
            message += '\n\nWarnings for review/training: ' + warningCount
                + ' occupied well(s) had bottom-inspection disagreement.'
                + '\nThese warnings no longer block taxonomy because bottom QA can be falsely negative.';
        }
        message += '\n\nReport folder:\n'
            + plateAuditFolder(auditReport.plate_number).getAbsolutePath();
        return message;
    }

    function showCompletedPlateAuditDialog(auditReport, taxonomyLaunched) {
        var warningCount = auditWarningCount(auditReport);
        if (auditReport.passed && warningCount === 0) {
            return;
        }
        var auditFolder = plateAuditFolder(auditReport.plate_number);
        var options = Java.to(['Open audit folder', 'OK'], 'java.lang.Object[]');
        var choice = JOptionPane.showOptionDialog(
            null,
            completedPlateAuditMessage(auditReport, taxonomyLaunched),
            auditReport.passed ? 'Plate audit passed with warnings' : 'Plate audit needs review',
            JOptionPane.YES_NO_OPTION,
            auditReport.passed ? JOptionPane.WARNING_MESSAGE : JOptionPane.ERROR_MESSAGE,
            null,
            options,
            options[0]
        );
        if (choice === 0) {
            try {
                Desktop.getDesktop().open(auditFolder);
            }
            catch (openError) {
                JOptionPane.showMessageDialog(
                    null,
                    'Could not open audit folder:\n' + String(openError) + '\n\n' + auditFolder.getAbsolutePath(),
                    'Open Audit Folder Failed',
                    JOptionPane.ERROR_MESSAGE
                );
            }
        }
    }

    function plateAttemptLogFile(plateContext) {
        return new File(plateImageFolder(plateContext.plateNumber), 'plate_attempts.jsonl');
    }

    function targetNumberForMetadata(target, targetIndex) {
        if (target !== null && target !== undefined && target.reviewNumber !== undefined) {
            return Number(target.reviewNumber);
        }
        if (targetIndex !== null && targetIndex !== undefined) {
            return Number(targetIndex) + 1;
        }
        return '';
    }

    function plateTraceMetadata(scanDir, scanId, target, targetIndex, hiResImageFile, bottomImageFile, wellImageFile, confirmation, topWellImageFile) {
        var sourceScanImage = '';
        if (target !== null && target !== undefined && target.cropFile && String(target.cropFile).length > 0) {
            sourceScanImage = String(target.cropFile);
        }
        var sizeMetadata = specimenSizeMetadata(target);
        return {
            scanId: scanId || (scanDir === null || scanDir === undefined ? '' : scanDir.getName()),
            scanDir: scanDir === null || scanDir === undefined ? '' : scanDir.getAbsolutePath(),
            targetNumber: targetNumberForMetadata(target, targetIndex),
            objectIndex: target === null || target === undefined ? '' : target.objectIndex,
            sourceScanImage: sourceScanImage,
            scan_bbox_width_px: sizeMetadata.bboxWidthPx,
            scan_bbox_height_px: sizeMetadata.bboxHeightPx,
            scan_bbox_area_px: sizeMetadata.bboxAreaPx,
            scan_bbox_width_mm: sizeMetadata.bboxWidthMm,
            scan_bbox_height_mm: sizeMetadata.bboxHeightMm,
            scan_bbox_area_mm2: sizeMetadata.bboxAreaMm2,
            scan_size_bin: sizeMetadata.sizeBin,
            hiResImage: hiResImageFile === null || hiResImageFile === undefined ? '' : hiResImageFile.getName(),
            bottomImage: bottomImageFile === null || bottomImageFile === undefined ? '' : bottomImageFile.getName(),
            wellImage: wellImageFile === null || wellImageFile === undefined ? '' : wellImageFile.getName(),
            topWellImage: topWellImageFile === null || topWellImageFile === undefined ? '' : topWellImageFile.getName(),
            confirmation: confirmation || ''
        };
    }

    function specimenSizeMetadata(target) {
        if (target === null || target === undefined) {
            return {
                bboxWidthPx: 0,
                bboxHeightPx: 0,
                bboxAreaPx: 0,
                bboxWidthMm: 0,
                bboxHeightMm: 0,
                bboxAreaMm2: 0,
                sizeBin: 'unknown'
            };
        }
        var widthPx = Math.max(0, Number(target.bboxWidth || 0));
        var heightPx = Math.max(0, Number(target.bboxHeight || 0));
        var areaPx = Math.max(0, Number(target.bboxArea || (widthPx * heightPx) || 0));
        var widthMm = widthPx * Math.abs(Number(target.unitsPerPixelX || 0));
        var heightMm = heightPx * Math.abs(Number(target.unitsPerPixelY || 0));
        var areaMm2 = Math.max(0, Number(target.bboxAreaMm || (widthMm * heightMm) || 0));
        return {
            bboxWidthPx: widthPx,
            bboxHeightPx: heightPx,
            bboxAreaPx: areaPx,
            bboxWidthMm: widthMm,
            bboxHeightMm: heightMm,
            bboxAreaMm2: areaMm2,
            sizeBin: specimenSizeBin(areaMm2)
        };
    }

    function specimenSizeBin(areaMm2) {
        var area = Number(areaMm2 || 0);
        if (!(area > 0)) {
            return 'unknown';
        }
        if (area < 1.0) {
            return 'tiny <1 mm2';
        }
        if (area < 3.0) {
            return 'small 1-3 mm2';
        }
        if (area < 7.0) {
            return 'medium 3-7 mm2';
        }
        if (area < 15.0) {
            return 'large 7-15 mm2';
        }
        return 'very large >=15 mm2';
    }

    function emptySizeBinStats(label) {
        return {
            label: label,
            attempts: 0,
            bottomPickSuccess: 0,
            successfulPlacements: 0,
            failedPickBottomEmpty: 0,
            failedPlace: 0,
            possibleMultipleOnNozzle: 0,
            bottomInspectionUnknown: 0,
            bottomPickSuccessRate: 0,
            placementSuccessRate: 0
        };
    }

    function sortedSizeBinStats(statsByBin) {
        var order = [
            'tiny <1 mm2',
            'small 1-3 mm2',
            'medium 3-7 mm2',
            'large 7-15 mm2',
            'very large >=15 mm2',
            'unknown'
        ];
        var result = [];
        for (var i = 0; i < order.length; i++) {
            var bin = order[i];
            if (statsByBin[bin] !== undefined) {
                var stats = statsByBin[bin];
                stats.bottomPickSuccessRate = stats.attempts > 0
                    ? (stats.bottomPickSuccess / stats.attempts) * 100.0
                    : 0;
                stats.placementSuccessRate = stats.attempts > 0
                    ? (stats.successfulPlacements / stats.attempts) * 100.0
                    : 0;
                result.push(stats);
            }
        }
        return result;
    }

    function appendPlateAttemptLog(scanDir, plateContext, well, target, targetIndex, hiResImageFile, bottomImageFile, wellImageFile, outcome, reason, scanId, extraMetadata) {
        var metadata = plateTraceMetadata(scanDir, scanId, target, targetIndex, hiResImageFile, bottomImageFile, wellImageFile, outcome);
        metadata.plate_number = normalizePlateNumber(plateContext.plateNumber);
        metadata.well = well === null || well === undefined ? '' : well.name;
        metadata.reason = reason || '';
        if (extraMetadata !== null && extraMetadata !== undefined) {
            for (var key in extraMetadata) {
                if (extraMetadata.hasOwnProperty(key)) {
                    metadata[key] = extraMetadata[key];
                }
            }
        }
        metadata.logged_at = new Date().toISOString();
        appendText(plateAttemptLogFile(plateContext), JSON.stringify(metadata) + '\n');
    }

    function currentPlateRunSummary(plateContext, scanId) {
        var plateNumber = normalizePlateNumber(plateContext.plateNumber);
        var occupied = occupiedWellSet(plateNumber);
        var filledCount = 0;
        for (var wellName in occupied) {
            if (occupied.hasOwnProperty(wellName) && !isReservedPlateWellName(wellName)) {
                filledCount++;
            }
        }
        var attempts = 0;
        var successfulThisRun = 0;
        var failedPickBottomEmpty = 0;
        var failedPlace = 0;
        var possibleMultipleOnNozzle = 0;
        var bottomInspectionUnknown = 0;
        var wellsWithMultiplePlacementAttempts = 0;
        var successfulSecondPlacementAttempts = 0;
        var sizeStatsByBin = {};
        var runAttemptGroups = {};
        var attemptFile = plateAttemptLogFile(plateContext);
        if (attemptFile.exists()) {
            var reader = new BufferedReader(new FileReader(attemptFile));
            try {
                var line = reader.readLine();
                while (line !== null) {
                    var text = String(line || '').trim();
                    if (text.length > 0) {
                        try {
                            var attempt = JSON.parse(text);
	                            if (normalizePlateNumber(attempt.plate_number || plateNumber) === plateNumber
	                                    && String(attempt.scanId || '') === String(scanId || '')) {
	                                var outcome = String(attempt.confirmation || '').toLowerCase();
	                                var groupKey = String(attempt.targetNumber || '') + '|' + String(attempt.well || '');
	                                if (runAttemptGroups[groupKey] === undefined) {
	                                    runAttemptGroups[groupKey] = {
	                                        hasMachineAttempt: false,
	                                        finalSuccess: false,
	                                        hasBottomBugPresent: false,
	                                        bottomBugPresent: false,
	                                        bottomPossibleMultiple: false,
	                                        maxPlacementAttempts: 1,
	                                        sizeBin: String(attempt.scan_size_bin || 'unknown')
	                                    };
	                                }
	                                var group = runAttemptGroups[groupKey];
	                                if (outcome === 'well qa occupied'
	                                        || outcome === 'well qa empty'
	                                        || outcome === 'bottom qa empty'
	                                        || outcome === 'bottom qa possible multiple') {
	                                    group.hasMachineAttempt = true;
	                                }
	                                if (outcome === 'well qa occupied'
	                                        || outcome.indexOf('manual occupied') >= 0) {
	                                    group.finalSuccess = true;
	                                }
	                                if (attempt.bottom_bug_present !== undefined
	                                        && attempt.bottom_bug_present !== null
	                                        && String(attempt.bottom_bug_present).length > 0) {
	                                    group.hasBottomBugPresent = true;
	                                    if (attempt.bottom_bug_present === true
	                                            || String(attempt.bottom_bug_present || '').toLowerCase() === 'true') {
	                                        group.bottomBugPresent = true;
	                                    }
	                                }
	                                if (attempt.bottom_possible_multiple === true
	                                        || String(attempt.bottom_possible_multiple || '').toLowerCase() === 'true') {
	                                    group.bottomPossibleMultiple = true;
	                                }
	                                group.maxPlacementAttempts = Math.max(
	                                    group.maxPlacementAttempts,
	                                    Number(attempt.placement_attempt_count || 1)
	                                );
	                                if (String(attempt.scan_size_bin || '').length > 0) {
	                                    group.sizeBin = String(attempt.scan_size_bin || 'unknown');
	                                }
	                            }
                        }
                        catch (parseError) {
                        }
                    }
                    line = reader.readLine();
                }
            }
            finally {
                reader.close();
            }
        }
        for (var groupKey in runAttemptGroups) {
            if (runAttemptGroups.hasOwnProperty(groupKey)) {
                var runGroup = runAttemptGroups[groupKey];
                if (!runGroup.hasMachineAttempt) {
                    continue;
                }
                attempts++;
                var runSizeBin = String(runGroup.sizeBin || 'unknown');
                if (sizeStatsByBin[runSizeBin] === undefined) {
                    sizeStatsByBin[runSizeBin] = emptySizeBinStats(runSizeBin);
                }
                var runSizeStats = sizeStatsByBin[runSizeBin];
                runSizeStats.attempts++;
                if (runGroup.finalSuccess) {
                    successfulThisRun++;
                    runSizeStats.successfulPlacements++;
                }
                if (!runGroup.hasBottomBugPresent) {
                    bottomInspectionUnknown++;
                    runSizeStats.bottomInspectionUnknown++;
                }
                else if (!runGroup.bottomBugPresent) {
                    failedPickBottomEmpty++;
                    runSizeStats.failedPickBottomEmpty++;
                }
                else {
                    runSizeStats.bottomPickSuccess++;
                }
                if (runGroup.bottomPossibleMultiple) {
                    possibleMultipleOnNozzle++;
                    runSizeStats.possibleMultipleOnNozzle++;
                }
                if (runGroup.bottomBugPresent && !runGroup.finalSuccess) {
                    failedPlace++;
                    runSizeStats.failedPlace++;
                }
                if (runGroup.maxPlacementAttempts > 1) {
                    wellsWithMultiplePlacementAttempts++;
                    if (runGroup.finalSuccess) {
                        successfulSecondPlacementAttempts++;
                    }
                }
            }
        }
        var emptyCount = Math.max(0, PLATE_FILLABLE_WELL_COUNT - filledCount);
        var runSuccessRate = attempts > 0 ? (successfulThisRun / attempts) * 100.0 : 0.0;
        return {
            plateNumber: plateNumber,
            filledCount: filledCount,
            emptyCount: emptyCount,
            percentFilled: (filledCount / PLATE_FILLABLE_WELL_COUNT) * 100.0,
            attempts: attempts,
            successfulThisRun: successfulThisRun,
            runSuccessRate: runSuccessRate,
            failedPickBottomEmpty: failedPickBottomEmpty,
            failedPlace: failedPlace,
            possibleMultipleOnNozzle: possibleMultipleOnNozzle,
            bottomInspectionUnknown: bottomInspectionUnknown,
            wellsWithMultiplePlacementAttempts: wellsWithMultiplePlacementAttempts,
            successfulSecondPlacementAttempts: successfulSecondPlacementAttempts,
            sizeBins: sortedSizeBinStats(sizeStatsByBin)
        };
    }

    function formatPlateRunSummary(summary) {
        return 'Plate ' + summary.plateNumber
            + ': this run ' + summary.successfulThisRun + '/' + summary.attempts
            + ' successful (' + Number(summary.runSuccessRate || 0).toFixed(1) + '%)'
            + '\nCurrent plate total: ' + summary.filledCount + '/' + PLATE_FILLABLE_WELL_COUNT
            + ' wells filled; empty wells: ' + summary.emptyCount
            + '\nFailed picks - bottom inspection empty: ' + summary.failedPickBottomEmpty
            + '\nFailed places - bottom had specimen, well empty: ' + summary.failedPlace
            + '\nPossible multiple/poor pickup on nozzle: ' + summary.possibleMultipleOnNozzle
            + '\nWells requiring a second placement attempt: ' + summary.wellsWithMultiplePlacementAttempts
            + '\nSuccessful second placement attempts: ' + summary.successfulSecondPlacementAttempts
            + (summary.bottomInspectionUnknown > 0
                ? '\nAttempts with no bottom-inspection metadata: ' + summary.bottomInspectionUnknown
                : '')
            + formatSizeBinSummary(summary.sizeBins);
    }

    function formatSizeBinSummary(sizeBins) {
        if (sizeBins === null || sizeBins === undefined || sizeBins.length === 0) {
            return '';
        }
        var lines = ['\n\nPick success by scan-estimated body size:'];
        for (var i = 0; i < sizeBins.length; i++) {
            var bin = sizeBins[i];
            lines.push(
                bin.label + ': '
                + bin.bottomPickSuccess + '/' + bin.attempts
                + ' picked (' + Number(bin.bottomPickSuccessRate).toFixed(1) + '%), '
                + bin.successfulPlacements + '/' + bin.attempts
                + ' plated (' + Number(bin.placementSuccessRate).toFixed(1) + '%)'
            );
        }
        return lines.join('\n');
    }

    function scanTargetSummary(scanDir, scanId) {
        var file = new File(scanDir, 'objects.jsonl');
        var targetCount = 0;
        var sizeStatsByBin = {};
        if (file.exists()) {
            var reader = new BufferedReader(new FileReader(file));
            try {
                var line = reader.readLine();
                while (line !== null) {
                    var text = String(line || '').trim();
                    if (text.length > 0) {
                        try {
                            var record = JSON.parse(text);
                            targetCount++;
                            var widthPx = Math.max(0, Number(record.bbox_width_px || 0));
                            var heightPx = Math.max(0, Number(record.bbox_height_px || 0));
                            var widthMm = widthPx * Math.abs(Number(record.units_per_pixel_x_mm || 0));
                            var heightMm = heightPx * Math.abs(Number(record.units_per_pixel_y_mm || 0));
                            var areaMm2 = widthMm * heightMm;
                            var sizeBin = specimenSizeBin(areaMm2);
                            if (sizeStatsByBin[sizeBin] === undefined) {
                                sizeStatsByBin[sizeBin] = {
                                    label: sizeBin,
                                    targets: 0
                                };
                            }
                            sizeStatsByBin[sizeBin].targets++;
                        }
                        catch (parseError) {
                        }
                    }
                    line = reader.readLine();
                }
            }
            finally {
                reader.close();
            }
        }
        return {
            scanId: scanId || '',
            targetsFound: targetCount,
            sizeBins: sortedScanSizeBinStats(sizeStatsByBin)
        };
    }

    function sortedScanSizeBinStats(statsByBin) {
        var order = [
            'tiny <1 mm2',
            'small 1-3 mm2',
            'medium 3-7 mm2',
            'large 7-15 mm2',
            'very large >=15 mm2',
            'unknown'
        ];
        var result = [];
        for (var i = 0; i < order.length; i++) {
            var bin = order[i];
            if (statsByBin[bin] !== undefined) {
                result.push(statsByBin[bin]);
            }
        }
        return result;
    }

    function formatScanTargetSummary(summary) {
        var lines = [
            'Scan ' + summary.scanId + ' completed.',
            'Detected targets before manual review: ' + summary.targetsFound
        ];
        if (summary.sizeBins !== null && summary.sizeBins !== undefined && summary.sizeBins.length > 0) {
            lines.push('');
            lines.push('Detected targets by scan-estimated body size:');
            for (var i = 0; i < summary.sizeBins.length; i++) {
                lines.push(summary.sizeBins[i].label + ': ' + summary.sizeBins[i].targets);
            }
        }
        lines.push('');
        lines.push('No pick/place attempts were recorded for this scan.');
        return lines.join('\n');
    }

    function writeRunSuccessSummary(scanDir, scanId, summaries) {
        var record = {
            scan_id: scanId || '',
            written_at: new Date().toISOString(),
            fillable_wells_expected: PLATE_FILLABLE_WELL_COUNT,
            reserved_negative_control_well: RESERVED_NEGATIVE_CONTROL_WELL,
            plates: summaries
        };
        writeText(new File(scanDir, 'run_success_summary.json'), JSON.stringify(record, null, 2) + '\n');
    }

    function showPlatingRunSummary(scanDir, scanId, plateContexts, title, prefixMessage) {
        var summaries = [];
        var messages = [];
        for (var i = 0; i < plateContexts.length; i++) {
            var summary = currentPlateRunSummary(plateContexts[i], scanId);
            summaries.push(summary);
            messages.push(formatPlateRunSummary(summary));
        }
        writeRunSuccessSummary(scanDir, scanId, summaries);
        JOptionPane.showMessageDialog(
            null,
            String(prefixMessage || 'Plating run summary.')
                + '\n\nRun summary:\n' + messages.join('\n\n'),
            String(title || 'Plating Run Summary'),
            JOptionPane.INFORMATION_MESSAGE
        );
    }

    function ensurePlateSpreadsheetHeader(plateContext) {
        var file = plateCsvFile(plateContext.plateNumber);
        if (!file.exists()) {
            writeText(file, csvLine(plateCsvHeaders()));
            print('Created plate spreadsheet CSV: ' + file.getAbsolutePath());
        }
        else {
            migratePlateSpreadsheetColumns(plateContext.plateNumber);
        }
        return file;
    }

    function appendPlateSpreadsheetRow(plateContext, well, metadata) {
        if (isReservedPlateWellName(well.name)) {
            throw new Error('Refusing to plate reserved negative control well ' + well.name + '.');
        }
        var file = ensurePlateSpreadsheetHeader(plateContext);
        var plateData = readPlateRows(plateContext.plateNumber);
        var wellColumnIndex = plateWellColumnIndex(plateData);
        var statusColumnIndex = plateCurrentStatusColumnIndex(plateData);
        var rows = plateData.rows;
        for (var existingIndex = 0; existingIndex < rows.length; existingIndex++) {
            var existingRow = rows[existingIndex];
            if (existingRow.length <= wellColumnIndex || !existingRow[wellColumnIndex]) {
                continue;
            }
            try {
                if (normalizeWellName(existingRow[wellColumnIndex]) === well.name) {
                    if (!rowMarksWellUnavailable(existingRow, statusColumnIndex)) {
                        var headers = plateData.headers.length > 0 ? plateData.headers : plateCsvHeaders();
                        var scanId = plateRowValueByHeader(headers, existingRow, 'Scan ID');
                        var sourceScanImage = plateRowValueByHeader(headers, existingRow, 'Source Scan Image');
                        var wellImage = plateRowValueByHeader(headers, existingRow, 'Well Image');
                        if (String(scanId || '').trim().length === 0
                                || String(sourceScanImage || '').trim().length === 0
                                || String(wellImage || '').trim().length === 0) {
                            applyPlateTraceMetadata(headers, existingRow, metadata);
                            var refreshed = csvLine(headers);
                            for (var refreshIndex = 0; refreshIndex < rows.length; refreshIndex++) {
                                refreshed += csvLine(rows[refreshIndex]);
                            }
                            writeText(file, refreshed);
                            sortPlateSpreadsheetRows(plateContext.plateNumber);
                            print('Backfilled trace metadata for existing occupied well ' + well.name + '.');
                        }
                        else {
                            print('Plate spreadsheet already has well ' + well.name + '; not adding a duplicate row.');
                        }
                        return;
                    }
                    if (statusColumnIndex >= 0) {
                        while (existingRow.length <= statusColumnIndex) {
                            existingRow.push('');
                        }
                        existingRow[statusColumnIndex] = '';
                    }
                    applyPlateTraceMetadata(plateData.headers.length > 0 ? plateData.headers : plateCsvHeaders(), existingRow, metadata);
                    var updated = csvLine(plateData.headers.length > 0 ? plateData.headers : plateCsvHeaders());
                    for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
                        updated += csvLine(rows[rowIndex]);
                    }
                    writeText(file, updated);
                    sortPlateSpreadsheetRows(plateContext.plateNumber);
                    print('Reactivated existing plate spreadsheet row for filled well ' + well.name + '.');
                    return;
                }
            }
            catch (wellError) {
                print('Ignoring invalid well value while appending plate row: ' + existingRow[wellColumnIndex]);
            }
        }
        var nextNumber = plateRowsOnly(plateContext.plateNumber).length + 1;
        var row = plateRowForWell(plateContext, well.name, '', metadata);
        row[0] = nextNumber;
        appendText(file, csvLine(row));
        sortPlateSpreadsheetRows(plateContext.plateNumber);
        print('Recorded plated specimen in ' + file.getAbsolutePath() + ' well ' + well.name);
    }

    function wellQueueFromStart(plateContext) {
        var startIndex = wellIndexForName(plateContext.startWell);
        var occupied = occupiedWellSet(plateContext.plateNumber);
        var wells = [];
        for (var i = startIndex; i < 96; i++) {
            var name = wellNameForIndex(i);
            if (!isReservedPlateWellIndex(i) && !occupied[name]) {
                wells.push(i);
            }
        }
        return wells;
    }

    function wellQueueContains(wells, wellIndex) {
        for (var i = 0; i < wells.length; i++) {
            if (Number(wells[i]) === Number(wellIndex)) {
                return true;
            }
        }
        return false;
    }

    function refillThenRemainingWellQueue(plateContext, refillWells, reviewedEmptyWells) {
        var queue = [];
        var refillSet = {};
        for (var i = 0; i < refillWells.length; i++) {
            var refillIndex = Number(refillWells[i].index);
            if (!isReservedPlateWellIndex(refillIndex) && !wellQueueContains(queue, refillIndex)) {
                queue.push(refillIndex);
            }
            refillSet[String(refillIndex)] = true;
        }

        var excludedReviewedWells = {};
        if (reviewedEmptyWells) {
            for (var reviewedIndex = 0; reviewedIndex < reviewedEmptyWells.length; reviewedIndex++) {
                var reviewedWellIndex = Number(reviewedEmptyWells[reviewedIndex].index);
                if (!refillSet[String(reviewedWellIndex)]) {
                    excludedReviewedWells[String(reviewedWellIndex)] = true;
                }
            }
        }

        var remaining = wellQueueFromStart(plateContext);
        for (var remainingIndex = 0; remainingIndex < remaining.length; remainingIndex++) {
            if (!excludedReviewedWells[String(Number(remaining[remainingIndex]))]
                    && !wellQueueContains(queue, remaining[remainingIndex])) {
                queue.push(Number(remaining[remainingIndex]));
            }
        }
        return queue;
    }

    function promptRetryEmptyWells(emptyWells, remainingTargetCount) {
        if (!emptyWells || emptyWells.length === 0) {
            return {
                wells: [],
                occupiedWells: [],
                mode: 'cancel'
            };
        }

        var panel = new JPanel(new BorderLayout(8, 8));
        var listPanel = new JPanel(new GridLayout(0, 1, 6, 6));
        var checkboxes = [];
        for (var i = 0; i < emptyWells.length; i++) {
            var row = new JPanel(new BorderLayout(6, 6));
            var isBottomNozzleReview = String(emptyWells[i].reviewKind || '') === 'bottom_nozzle';
            var checkbox = null;
            if (isBottomNozzleReview) {
                row.add(
                    new JLabel(
                        '<html><b>' + emptyWells[i].name + ': refill required</b><br>'
                            + 'Nozzle image (not a well image) - the pickup was rejected before plating.<br>'
                            + String(emptyWells[i].reason || 'Bottom-camera QA rejected the pickup')
                            + '</html>'
                    ),
                    BorderLayout.NORTH
                );
            }
            else {
                checkbox = new JCheckBox(
                    emptyWells[i].name + ': well is empty - refill it',
                    true
                );
                checkbox.setToolTipText(String(emptyWells[i].reason || 'Well was not confirmed occupied'));
                row.add(checkbox, BorderLayout.NORTH);
            }
            checkboxes.push(checkbox);
            if (emptyWells[i].imageFile !== null && emptyWells[i].imageFile.exists()) {
                var icon = scaledIconForFile(emptyWells[i].imageFile, Packages.javax.swing.ImageIcon, Packages.java.awt.Image, 360, 220);
                if (icon !== null) {
                    var imageLabel = new JLabel(icon);
                    row.add(imageLabel, BorderLayout.CENTER);
                }
            }
            listPanel.add(row);
        }

        panel.add(
            new JLabel(
                '<html>Review wells not confirmed occupied. '
                    + 'Return specimens from recovery tray to sorting tray. '
                    + '<br><b>Well images:</b> leave checked when the well is empty; uncheck when it contains a specimen. '
                    + '<br><b>Nozzle images:</b> the pickup never reached the well, so the well will be refilled automatically.'
                    + (Number(remainingTargetCount || 0) > 0
                        ? '<br>' + Number(remainingTargetCount || 0)
                            + ' approved target(s) from the previous scan were not picked yet.'
                        : '')
                    + '</html>'
            ),
            BorderLayout.NORTH
        );
        var scroll = new JScrollPane(listPanel);
        scroll.setPreferredSize(new Dimension(520, Math.min(640, 120 + (emptyWells.length * 90))));
        panel.add(scroll, BorderLayout.CENTER);

        var result = JOptionPane.showConfirmDialog(
            null,
            panel,
            'Empty well review',
            JOptionPane.OK_CANCEL_OPTION,
            JOptionPane.WARNING_MESSAGE
        );
        if (result !== JOptionPane.OK_OPTION) {
            return {
                wells: [],
                occupiedWells: [],
                mode: 'cancel'
            };
        }

        var selectedWells = [];
        var occupiedWells = [];
        for (var selectedIndex = 0; selectedIndex < emptyWells.length; selectedIndex++) {
            if (checkboxes[selectedIndex] === null || checkboxes[selectedIndex].isSelected()) {
                selectedWells.push(emptyWells[selectedIndex]);
            }
            else {
                occupiedWells.push(emptyWells[selectedIndex]);
            }
        }
        if (selectedWells.length === 0) {
            return {
                wells: [],
                occupiedWells: occupiedWells,
                mode: 'manual_occupied_only'
            };
        }

        if (Number(remainingTargetCount || 0) <= 0) {
            return {
                wells: selectedWells,
                occupiedWells: occupiedWells,
                mode: 'rescan'
            };
        }

        var modeChoice = JOptionPane.showOptionDialog(
            null,
            'Fill ' + selectedWells.length + ' missed well(s) using the remaining target(s) from this scan, or rescan the sorting tray first?',
            'Fill missed wells',
            JOptionPane.YES_NO_CANCEL_OPTION,
            JOptionPane.QUESTION_MESSAGE,
            null,
            Java.to(['Continue previous scan', 'Rescan sorting tray', 'Cancel refill'], 'java.lang.Object[]'),
            'Continue previous scan'
        );
        if (modeChoice === 0) {
            return {
                wells: selectedWells,
                occupiedWells: occupiedWells,
                mode: 'continue_previous_scan'
            };
        }
        if (modeChoice === 1) {
            return {
                wells: selectedWells,
                occupiedWells: occupiedWells,
                mode: 'rescan'
            };
        }
        return {
            wells: [],
            occupiedWells: occupiedWells,
            mode: 'cancel'
        };
    }

    function recordManuallyConfirmedOccupiedWells(scanDir, plateContext, occupiedWells) {
        if (!occupiedWells || occupiedWells.length === 0) {
            return;
        }
        for (var i = 0; i < occupiedWells.length; i++) {
            var reviewed = occupiedWells[i];
            var well = {
                name: reviewed.name,
                index: Number(reviewed.index)
            };
            var target = reviewed.target || null;
            var hiResImageFile = reviewed.hiResImageFile || hiResImageFileForTarget(scanDir, target);
            var bottomImageFile = reviewed.bottomImageFile || null;
            var wellImageFile = reviewed.wellImageFile || null;
            var topWellImageFile = reviewed.topWellImageFile || reviewed.imageFile || null;
            var latestAttempt = null;
            if (wellImageFile === null || wellImageFile === undefined || !wellImageFile.exists()) {
                latestAttempt = latestPlateAttemptForWell(plateContext, well.name);
                if (latestAttempt === null) {
                    print('Manual occupied review for ' + reviewed.name
                        + ' has no well QA image and no recoverable attempt; skipping CSV/image backfill.');
                    continue;
                }
            }
            var metadata = latestAttempt === null
                ? plateTraceMetadata(
                    scanDir,
                    scanDir === null || scanDir === undefined ? '' : scanDir.getName(),
                    target,
                    reviewed.targetIndex,
                    hiResImageFile,
                    bottomImageFile,
                    wellImageFile,
                    'manual occupied review',
                    topWellImageFile
                )
                : plateTraceMetadataFromAttempt(latestAttempt, 'manual occupied review recovered from latest attempt');
            if (latestAttempt === null) {
                copyPlateSpecimenImages(scanDir, plateContext, well, target, hiResImageFile, bottomImageFile, wellImageFile, topWellImageFile);
            }
            else {
                copyPlateSpecimenImagesFromAttempt(plateContext, well, latestAttempt);
            }
            appendPlateSpreadsheetRow(plateContext, well, metadata);
	            appendPlateAttemptLog(
	                latestAttempt === null ? scanDir : new File(String(latestAttempt.scanDir || '')),
	                plateContext,
	                well,
	                target,
                latestAttempt === null ? reviewed.targetIndex : Number(latestAttempt.targetNumber || 1) - 1,
                latestAttempt === null ? hiResImageFile : resolveAttemptImageFile(latestAttempt, 'hires'),
                latestAttempt === null ? bottomImageFile : resolveAttemptImageFile(latestAttempt, 'bottom'),
	                latestAttempt === null ? wellImageFile : resolveAttemptImageFile(latestAttempt, 'well'),
	                metadata.confirmation,
	                reviewed.reason || '',
	                metadata.scanId,
	                latestAttempt === null
	                    ? {
	                        topWellImage: topWellImageFile === null || topWellImageFile === undefined
	                            ? ''
	                            : topWellImageFile.getName()
	                    }
	                    : {
	                        topWellImage: latestAttempt.topWellImage,
	                        bottom_bug_present: latestAttempt.bottom_bug_present,
	                        bottom_possible_multiple: latestAttempt.bottom_possible_multiple,
	                        bottom_component_count: latestAttempt.bottom_component_count,
	                        bottom_largest_area_px: latestAttempt.bottom_largest_area_px,
	                        bottom_dark_fraction: latestAttempt.bottom_dark_fraction
	                    }
	            );
            print('Recorded manually confirmed occupied well ' + reviewed.name
                + ' in plate CSV and review image folder.');
        }
    }

    function writePickingPreview(scanDir, scanId, target, targetIndex, totalTargets, moveX, moveY, extraFields) {
        var detectionStatusFile = new File(projectDir, 'control/detection_status.json');
        var previewFile = target.overlayFile && target.overlayFile.length > 0
            ? new File(scanDir, target.overlayFile)
            : target.contextFile && target.contextFile.length > 0
            ? new File(scanDir, target.contextFile)
            : new File(scanDir, target.cropFile);
        var record = {
            status: 'detected',
            scan_dir: scanDir.getAbsolutePath(),
            updated_at: new Date().toISOString(),
            frame_index: target.frameIndex,
            source_file: target.sourceFile,
            overlay_file: target.overlayFile,
            preview_file: previewFile.getAbsolutePath(),
            detections_in_frame: 1,
            duplicates_in_frame: 0,
            unique_object_count: totalTargets,
            duplicate_count: 0,
            label: 'Picking Target ' + (targetIndex + 1),
            centroid_x_px: target.centroidX,
            centroid_y_px: target.centroidY,
            score: target.score,
            pick_x_mm: moveX,
            pick_y_mm: moveY
        };
        if (extraFields) {
            for (var key in extraFields) {
                if (extraFields.hasOwnProperty(key)) {
                    record[key] = extraFields[key];
                }
            }
        }
        writeText(detectionStatusFile, JSON.stringify(record, null, 2) + '\n');
        writeText(
            new File(scanDir, 'pick_command_' + pad(targetIndex + 1, 3) + '.json'),
            JSON.stringify(record, null, 2) + '\n'
        );
    }

    function writeInspectionPreview(scanDir, scanId, target, targetIndex, totalTargets, imageFile, x, y, z) {
        var detectionStatusFile = new File(projectDir, 'control/detection_status.json');
        var record = {
            status: 'detected',
            scan_dir: scanDir.getAbsolutePath(),
            updated_at: new Date().toISOString(),
            frame_index: target.frameIndex,
            source_file: imageFile.getName(),
            preview_file: imageFile.getAbsolutePath(),
            detections_in_frame: 1,
            duplicates_in_frame: 0,
            unique_object_count: totalTargets,
            duplicate_count: 0,
            label: 'Bottom inspection Target ' + (targetIndex + 1),
            centroid_x_px: target.centroidX,
            centroid_y_px: target.centroidY,
            score: target.score,
            inspection_x_mm: x,
            inspection_y_mm: y,
            inspection_z_mm: z
        };
        writeText(detectionStatusFile, JSON.stringify(record, null, 2) + '\n');
    }

    function writeQaPreview(scanDir, scanId, target, targetIndex, totalTargets, imageFile, label, x, y, z, result) {
        var detectionStatusFile = new File(projectDir, 'control/detection_status.json');
        var record = {
            status: 'detected',
            scan_dir: scanDir.getAbsolutePath(),
            updated_at: new Date().toISOString(),
            frame_index: target.frameIndex,
            source_file: imageFile.getName(),
            preview_file: imageFile.getAbsolutePath(),
            detections_in_frame: 1,
            duplicates_in_frame: 0,
            unique_object_count: totalTargets,
            duplicate_count: 0,
            label: label,
            centroid_x_px: target.centroidX,
            centroid_y_px: target.centroidY,
            score: target.score,
            qa_x_mm: x,
            qa_y_mm: y,
            qa_z_mm: z
        };
        if (result) {
            record.qa_mode = result.mode;
            record.qa_well_empty = result.well_empty;
            record.qa_bug_present = result.bug_present;
            record.qa_dark_fraction = result.dark_fraction;
            record.qa_largest_area_px = result.largest_area_px;
        }
        writeText(detectionStatusFile, JSON.stringify(record, null, 2) + '\n');
        writeText(
            new File(scanDir, 'qa_command_' + pad(targetIndex + 1, 3) + '.json'),
            JSON.stringify(record, null, 2) + '\n'
        );
    }

    function writeHiResPreview(scanDir, target, targetIndex, totalTargets, imageFile, label, x, y, z, sharpnessScore) {
        var detectionStatusFile = new File(projectDir, 'control/detection_status.json');
        var record = {
            status: 'detected',
            scan_dir: scanDir.getAbsolutePath(),
            updated_at: new Date().toISOString(),
            frame_index: target.frameIndex,
            source_file: imageFile.getName(),
            preview_file: imageFile.getAbsolutePath(),
            detections_in_frame: 1,
            duplicates_in_frame: 0,
            unique_object_count: totalTargets,
            duplicate_count: 0,
            label: label,
            centroid_x_px: target.centroidX,
            centroid_y_px: target.centroidY,
            score: target.score,
            hires_x_mm: x,
            hires_y_mm: y,
            hires_z_mm: z,
            hires_sharpness_score: sharpnessScore
        };
        writeText(detectionStatusFile, JSON.stringify(record, null, 2) + '\n');
    }

    function haltRequested(stopFile, statusFile, scanId, frameIndex, totalFrames) {
        if (!stopFile.exists()) {
            return false;
        }

        print('Halt requested before frame ' + frameIndex + '. Stopping scan.');
        writeStatus(statusFile, 'halted', scanId, frameIndex, totalFrames, 'Halt requested before next move');
        return true;
    }

    function waitWhilePaused(pauseFile, stopFile, statusFile, scanId, frameIndex, totalFrames) {
        var announcedPause = false;

        while (pauseFile.exists()) {
            if (haltRequested(stopFile, statusFile, scanId, frameIndex, totalFrames)) {
                return false;
            }
            if (!announcedPause) {
                print('Pause requested before frame ' + frameIndex + '. Waiting for resume.');
                writeStatus(statusFile, 'paused', scanId, frameIndex, totalFrames, 'Paused before next move');
                announcedPause = true;
            }
            Packages.java.lang.Thread.sleep(500);
        }

        if (announcedPause) {
            print('Resume requested. Continuing at frame ' + frameIndex + '.');
            writeStatus(statusFile, 'running', scanId, frameIndex, totalFrames, 'Resumed scan');
        }

        return true;
    }

    function launchHaltGui(controlDir) {
        var guiScript = new File(scriptsDir, '00_Halt_Control.py').getAbsolutePath();
        var stdoutLog = new File(controlDir, 'halt_gui.out.log');
        var stderrLog = new File(controlDir, 'halt_gui.err.log');

        try {
            var builder = new Packages.java.lang.ProcessBuilder(python, guiScript);
            builder.directory(projectDir);
            builder.redirectOutput(stdoutLog);
            builder.redirectError(stderrLog);
            builder.start();
            print('Launched halt control GUI.');
        }
        catch (error) {
            print('Failed to launch halt control GUI: ' + error);
            print('See: ' + stderrLog.getAbsolutePath());
        }
    }

    function launchSegmentation(scanDir, controlDir) {
        var segmentScript = new File(scriptsDir, '02_Segment_Scan_Objects.py').getAbsolutePath();
        var stdoutLog = new File(controlDir, 'segmentation.out.log');
        var stderrLog = new File(controlDir, 'segmentation.err.log');
        var detectorMode = new File(controlDir, 'bug_detector.flag').exists() ? 'bug' : 'resistor';

        function startWithPython(pythonCommand) {
            var builder = new Packages.java.lang.ProcessBuilder(
                pythonCommand,
                segmentScript,
                scanDir.getAbsolutePath(),
                '--detector',
                detectorMode,
                '--watch'
            );
            builder.directory(projectDir);
            builder.redirectOutput(stdoutLog);
            builder.redirectError(stderrLog);
            return builder.start();
        }

        try {
            var process = startWithPython(python);
            print('Launched ' + detectorMode + ' segmentation for: ' + scanDir.getAbsolutePath()
                + ' using ' + python);
            return process;
        }
        catch (error) {
            appendText(
                stderrLog,
                new Date().toISOString()
                    + ' Failed to launch segmentation with ' + python + ': '
                    + String(error) + '\n'
            );
            print('Failed to launch segmentation with configured Python: ' + error);
            try {
                var fallbackProcess = startWithPython('python3');
                print('Launched ' + detectorMode + ' segmentation with fallback python3 for: '
                    + scanDir.getAbsolutePath());
                return fallbackProcess;
            }
            catch (fallbackError) {
                appendText(
                    stderrLog,
                    new Date().toISOString()
                        + ' Failed to launch segmentation with fallback python3: '
                        + String(fallbackError) + '\n'
                );
                print('Failed to launch segmentation: ' + fallbackError);
                print('See: ' + stderrLog.getAbsolutePath());
                return null;
            }
        }
    }

    function runInsectDebrisClassifier(scanDir, controlDir) {
        var classifierScript = new File(scriptsDir, '05_Classify_Review_Targets.py').getAbsolutePath();
        var stdoutLog = new File(controlDir, 'insect_debris_classifier.out.log');
        var stderrLog = new File(controlDir, 'insect_debris_classifier.err.log');

        try {
            var builder = new Packages.java.lang.ProcessBuilder(
                python,
                classifierScript,
                scanDir.getAbsolutePath()
            );
            builder.directory(projectDir);
            builder.redirectOutput(stdoutLog);
            builder.redirectError(stderrLog);
            var process = builder.start();
            var exitCode = process.waitFor();
            if (exitCode === 0) {
                print('Classified target crops for review: ' + scanDir.getAbsolutePath());
                return true;
            }
            print('Insect/debris classifier exited with code ' + exitCode + '. Review will continue without model labels.');
            print('See: ' + stderrLog.getAbsolutePath());
            return false;
        }
        catch (error) {
            print('Failed to run insect/debris classifier: ' + error);
            print('See: ' + stderrLog.getAbsolutePath());
            return false;
        }
    }

    function taxonomyClassifierMode() {
        try {
            var savedCalibration = loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
            var mode = savedCalibration.multiConfig && savedCalibration.multiConfig.shared
                ? String(savedCalibration.multiConfig.shared.taxonomy_classifier_mode || 'train')
                : 'train';
            return mode === 'auto' ? 'auto' : 'train';
        }
        catch (error) {
            print('Could not read taxonomy classifier mode; defaulting to train: ' + error);
            return 'train';
        }
    }

    function launchPlateTaxonomyClassifier(plateContext, triggerScanId) {
        var plateNumber = normalizePlateNumber(plateContext.plateNumber);
        var taxonomyScript = new File(scriptsDir, '08_Classify_Plate_Taxonomy.py').getAbsolutePath();
        var taxonomyDir = new File(plateTaxonomyRoot(), 'P-' + plateNumber);
        taxonomyDir.mkdirs();
        var stdoutLog = new File(taxonomyDir, 'taxonomy_classifier.out.log');
        var stderrLog = new File(taxonomyDir, 'taxonomy_classifier.err.log');

        try {
            var mode = taxonomyClassifierMode();
            var builder = new Packages.java.lang.ProcessBuilder(
                python,
                taxonomyScript,
                '--openpnp-root',
                projectDir.getAbsolutePath(),
                '--plate',
                plateNumber,
                '--mode',
                mode
            );
            builder.directory(projectDir);
            builder.redirectOutput(stdoutLog);
            builder.redirectError(stderrLog);
            var process = builder.start();
            showTaxonomyProgressWindow(plateNumber, mode, taxonomyDir, stdoutLog, stderrLog, process);
            print('Launched ' + mode + ' taxonomy classifier for plate ' + plateNumber
                + ' after audit pass. Logs: ' + stdoutLog.getAbsolutePath());
            return true;
        }
        catch (error) {
            appendText(
                stderrLog,
                new Date().toISOString()
                    + ' Failed to launch taxonomy classifier for ' + plateNumber
                    + ' after scan ' + String(triggerScanId || '')
                    + ': ' + String(error) + '\n'
            );
            print('Failed to launch taxonomy classifier for ' + plateNumber + ': ' + error);
            print('See: ' + stderrLog.getAbsolutePath());
            return false;
        }
    }

    function readTail(file, maxChars) {
        if (!file.exists()) {
            return '';
        }
        var reader = new BufferedReader(new FileReader(file));
        var builder = new StringBuilder();
        try {
            var line = reader.readLine();
            while (line !== null) {
                builder.append(line).append('\n');
                if (builder.length() > maxChars * 2) {
                    builder.delete(0, builder.length() - maxChars);
                }
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }
        if (builder.length() > maxChars) {
            return builder.substring(builder.length() - maxChars);
        }
        return builder.toString();
    }

    function showTaxonomyProgressWindow(plateNumber, mode, taxonomyDir, stdoutLog, stderrLog, process) {
        var frame = new JFrame('BugPicker Taxonomy - ' + plateNumber);
        frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
        frame.setLayout(new BorderLayout(8, 8));

        var statusLabel = new JLabel('Running ' + mode + ' taxonomy for plate ' + plateNumber + '...');
        statusLabel.setBorder(BorderFactory.createEmptyBorder(8, 8, 0, 8));
        frame.add(statusLabel, BorderLayout.NORTH);

        var logArea = new JTextArea(22, 90);
        logArea.setEditable(false);
        logArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        frame.add(new JScrollPane(logArea), BorderLayout.CENTER);

        var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
        var folderButton = new JButton('Open Folder');
        var closeButton = new JButton('Close');
        buttons.add(folderButton);
        buttons.add(closeButton);
        frame.add(buttons, BorderLayout.SOUTH);

        folderButton.addActionListener(new java.awt.event.ActionListener({
            actionPerformed: function(event) {
                try {
                    Desktop.getDesktop().open(taxonomyDir);
                }
                catch (openError) {
                    JOptionPane.showMessageDialog(
                        frame,
                        'Could not open folder:\n' + String(openError) + '\n\n' + taxonomyDir.getAbsolutePath(),
                        'Open Folder Failed',
                        JOptionPane.ERROR_MESSAGE
                    );
                }
            }
        }));
        closeButton.addActionListener(new java.awt.event.ActionListener({
            actionPerformed: function(event) {
                frame.dispose();
            }
        }));

        var timer = new Timer(1000, null);
        timer.addActionListener(new java.awt.event.ActionListener({
            actionPerformed: function(event) {
                var text = readTail(stdoutLog, 12000);
                var errorText = readTail(stderrLog, 6000);
                if (errorText.length > 0) {
                    text = text + '\n--- stderr ---\n' + errorText;
                }
                if (text.length === 0) {
                    text = 'Waiting for taxonomy output...';
                }
                logArea.setText(text);
                logArea.setCaretPosition(logArea.getDocument().getLength());
                try {
                    var exitCode = process.exitValue();
                    timer.stop();
                    statusLabel.setText(
                        exitCode === 0
                            ? 'Taxonomy finished for plate ' + plateNumber + '.'
                            : 'Taxonomy exited with code ' + exitCode + ' for plate ' + plateNumber + '.'
                    );
                }
                catch (stillRunning) {
                    statusLabel.setText('Running ' + mode + ' taxonomy for plate ' + plateNumber + '...');
                }
            }
        }));

        frame.pack();
        frame.setLocationRelativeTo(null);
        frame.setVisible(true);
        timer.start();
    }

    function touchTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames) {
        var touchHeadName = 'H1';
        var touchNozzleName = 'N1';
        var touchNozzleLabel = 'left nozzle N1';
        var touchZ = 6.0;
        var touchDwellMs = 250;
        var dryRunFile = new File(projectDir, 'control/touch_dry_run.flag');
        var dryRun = dryRunFile.exists();
        var touchTool = findPickTool(touchHeadName, touchNozzleName);
        var nozzle = touchTool.nozzle;
        printNozzleLocations(touchTool.head);
        var travelZ = nozzle.location.z;
        var touchCorrection = readTouchCorrection();
        var targets = readPickTargets(scanDir);

        print('Touch sequence has ' + targets.length + ' unique target(s).');
        print('Touch tool is ' + touchNozzleLabel + ' on head ' + touchHeadName
            + '; travel Z for XY moves: ' + travelZ.toFixed(3)
            + '; touch Z=' + touchZ.toFixed(3));
        print('Touch correction: dX=' + touchCorrection.x.toFixed(3)
            + ' dY=' + touchCorrection.y.toFixed(3)
            + ' source=' + touchCorrection.source);
        if (dryRun) {
            print('Touch dry run flag is present: ' + dryRunFile.getAbsolutePath());
        }
        if (targets.length === 0) {
            writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan completed; no touch targets found');
            return;
        }

        for (var i = 0; i < targets.length; i++) {
            if (!waitWhilePaused(pauseFile, stopFile, statusFile, scanId, i, targets.length)
                    || haltRequested(stopFile, statusFile, scanId, i, targets.length)) {
                print('Halt requested during touch sequence. Stopping before target ' + (i + 1) + '.');
                return;
            }

            var target = targets[i];
            var moveX = target.x + touchCorrection.x;
            var moveY = target.y + touchCorrection.y;
            writeStatus(
                statusFile,
                'touching',
                scanId,
                i + 1,
                targets.length,
                'Touching target at X ' + moveX.toFixed(3) + ', Y ' + moveY.toFixed(3)
            );

            debugTouchTarget(scanDir, target, nozzle, travelZ, dryRun, touchCorrection, moveX, moveY);
            print('Moving ' + touchNozzleLabel + ' above object ' + target.objectIndex
                + ' at X=' + moveX.toFixed(3)
                + ' Y=' + moveY.toFixed(3)
                + ' travel Z=' + travelZ.toFixed(3));
            moveNozzleToXyAtZ(nozzle, moveX, moveY, travelZ);

            if (dryRun) {
                writeStatus(
                    statusFile,
                    'awaiting_calibration',
                    scanId,
                    i + 1,
                    targets.length,
                    'Jog N1 to the true target center, then click Record N1 Position'
                );
                showTouchCalibrationWindow(scanDir, statusFile, scanId, targets.length, target, nozzle, touchCorrection, moveX, moveY);
                print('Touch dry run finished above target. Waiting for jog-and-record calibration.');
                return;
            }

            print('Descending to touch object ' + target.objectIndex
                + ' at X=' + moveX.toFixed(3)
                + ' Y=' + moveY.toFixed(3)
                + ' Z=' + touchZ.toFixed(3));
            moveNozzleToXyAtZ(nozzle, moveX, moveY, touchZ);
            Packages.java.lang.Thread.sleep(touchDwellMs);
            moveNozzleToXyAtZ(nozzle, moveX, moveY, travelZ);
        }

        writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan and touch sequence completed');
    }

    function readTouchCorrection() {
        return {
            x: 0.0,
            y: 0.0,
            z: -44.7,
            source: 'no BugPicker XY correction'
        };
    }

    function medianNumber(values) {
        var copy = values.slice(0);
        copy.sort(function(a, b) {
            return a - b;
        });
        var middle = Math.floor(copy.length / 2);
        if (copy.length % 2 === 1) {
            return copy[middle];
        }
        return (copy[middle - 1] + copy[middle]) / 2.0;
    }

    function showTouchCalibrationWindow(scanDir, statusFile, scanId, totalTargets, target, nozzle, appliedCorrection, moveX, moveY) {
        var calibrationFile = new File(projectDir, 'control/touch_calibration.jsonl');
        var scanCalibrationFile = new File(scanDir, 'touch_calibration.jsonl');
        var runnable = new Packages.java.lang.Runnable({
            run: function() {
                var JFrame = Packages.javax.swing.JFrame;
                var JPanel = Packages.javax.swing.JPanel;
                var JLabel = Packages.javax.swing.JLabel;
                var JButton = Packages.javax.swing.JButton;
                var ImageIcon = Packages.javax.swing.ImageIcon;
                var BorderLayout = Packages.java.awt.BorderLayout;
                var GridLayout = Packages.java.awt.GridLayout;
                var FlowLayout = Packages.java.awt.FlowLayout;
                var Image = Packages.java.awt.Image;
                var EmptyBorder = Packages.javax.swing.border.EmptyBorder;
                var ActionListener = Packages.java.awt.event.ActionListener;

                var frame = new JFrame('Record N1 Touch Calibration');
                frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
                frame.setAlwaysOnTop(true);

                var panel = new JPanel(new BorderLayout(8, 8));
                panel.setBorder(new EmptyBorder(12, 12, 12, 12));

                var details = new JPanel(new GridLayout(0, 1, 2, 2));
                details.add(new JLabel('Detected target: object ' + target.objectIndex));
                details.add(new JLabel('Raw estimate X=' + target.x.toFixed(3) + ' Y=' + target.y.toFixed(3)));
                details.add(new JLabel('Applied correction dX=' + appliedCorrection.x.toFixed(3)
                    + ' dY=' + appliedCorrection.y.toFixed(3)));
                details.add(new JLabel('Commanded N1 X=' + moveX.toFixed(3) + ' Y=' + moveY.toFixed(3)));
                details.add(new JLabel('Jog N1 to the true target center, then record.'));
                details.add(new JLabel('Writes: ' + calibrationFile.getAbsolutePath()));
                panel.add(details, BorderLayout.CENTER);

                var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
                var recordButton = new JButton('Record N1 Position');
                var closeButton = new JButton('Close');
                buttons.add(closeButton);
                buttons.add(recordButton);
                panel.add(buttons, BorderLayout.SOUTH);

                recordButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        var recorded = nozzle.location;
                        var record = {
                            scan_id: scanId,
                            scan_dir: scanDir.getAbsolutePath(),
                            object_index: target.objectIndex,
                            raw_commanded_x_mm: target.x,
                            raw_commanded_y_mm: target.y,
                            applied_correction_x_mm: appliedCorrection.x,
                            applied_correction_y_mm: appliedCorrection.y,
                            commanded_x_mm: moveX,
                            commanded_y_mm: moveY,
                            recorded_x_mm: recorded.x,
                            recorded_y_mm: recorded.y,
                            recorded_z_mm: recorded.z,
                            recorded_rotation: recorded.rotation,
                            residual_correction_x_mm: recorded.x - moveX,
                            residual_correction_y_mm: recorded.y - moveY,
                            total_correction_x_mm: appliedCorrection.x + (recorded.x - moveX),
                            total_correction_y_mm: appliedCorrection.y + (recorded.y - moveY),
                            correction_x_mm: recorded.x - moveX,
                            correction_y_mm: recorded.y - moveY,
                            raw_estimate_x_mm: target.estimatedX,
                            raw_estimate_y_mm: target.estimatedY,
                            requested_frame_estimated_x_mm: target.requestedEstimateX,
                            requested_frame_estimated_y_mm: target.requestedEstimateY,
                            frame_x_mm: target.frameX,
                            frame_y_mm: target.frameY,
                            frame_requested_x_mm: target.requestedFrameX,
                            frame_requested_y_mm: target.requestedFrameY,
                            recorded_at: new Date().toISOString()
                        };
                        var line = JSON.stringify(record) + '\n';
                        appendText(calibrationFile, line);
                        appendText(scanCalibrationFile, line);
                        writeStatus(
                            statusFile,
                            'completed',
                            scanId,
                            1,
                            totalTargets,
                            'Recorded N1 total touch correction: dX '
                                + record.total_correction_x_mm.toFixed(3)
                                + ', dY '
                                + record.total_correction_y_mm.toFixed(3)
                        );
                        print('Recorded N1 touch calibration: ' + line);
                        frame.dispose();
                    }
                }));

                closeButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        frame.dispose();
                    }
                }));

                frame.setContentPane(panel);
                frame.pack();
                frame.setLocationRelativeTo(null);
                frame.setVisible(true);
            }
        });
        Packages.javax.swing.SwingUtilities.invokeLater(runnable);
    }

    function interactiveReviewTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames) {
        var state = makeInteractiveReviewState(scanDir);
        var targets = readPickTargets(scanDir);

        print('Interactive pick review has ' + targets.length + ' unique target(s).');
        print('Interactive correction starts at dX=' + state.touchCorrection.x.toFixed(3)
            + ' dY=' + state.touchCorrection.y.toFixed(3)
            + ' source=' + state.touchCorrection.source);
        if (targets.length === 0) {
            writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan completed; no interactive targets found');
            return;
        }

        while (state.reviewedCount < targets.length) {
            if (!interactiveReviewNextAvailableTarget(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames, state)) {
                return;
            }
            targets = readPickTargets(scanDir);
        }

        writeStatus(statusFile, 'completed', scanId, targets.length, targets.length, 'Interactive target review completed');
    }

    function interactiveReviewTargetsAsync(scanDir, statusFile, scanId, totalFrames) {
        var state = makeInteractiveReviewState(scanDir);
        var targets = readPickTargets(scanDir);

        print('Async interactive pick review has ' + targets.length + ' unique target(s).');
        print('Async interactive correction starts at dX=' + state.touchCorrection.x.toFixed(3)
            + ' dY=' + state.touchCorrection.y.toFixed(3)
            + ' Z=' + state.touchCorrection.z.toFixed(3)
            + ' source=' + state.touchCorrection.source);
        if (targets.length === 0) {
            writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan completed; no interactive targets found');
            return;
        }

        moveInteractiveReviewTargetAsync(scanDir, statusFile, scanId, targets, state);
    }

    function makeInteractiveReviewState(scanDir) {
        return {
            headName: 'H1',
            nozzleName: 'N1',
            reviewedCount: 0,
            touchCorrection: readTouchCorrection(),
            reviewFile: new File(projectDir, 'control/interactive_pick_review.jsonl'),
            scanReviewFile: new File(scanDir, 'interactive_pick_review.jsonl')
        };
    }

    function interactiveReviewNextAvailableTarget(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames, state) {
        var targets = readPickTargets(scanDir, true);
        if (state.reviewedCount >= targets.length) {
            return true;
        }

        var targetIndex = state.reviewedCount;
        var target = targets[targetIndex];
        while (true) {
            if (!waitWhilePaused(pauseFile, stopFile, statusFile, scanId, targetIndex, targets.length)
                    || haltRequested(stopFile, statusFile, scanId, targetIndex, targets.length)) {
                print('Halt requested during interactive review. Stopping before target ' + (targetIndex + 1) + '.');
                return false;
            }

            var pickTool = findPickTool(state.headName, state.nozzleName);
            var nozzle = pickTool.nozzle;
            var travelZ = nozzle.location.z;
            var moveX = target.x + state.touchCorrection.x;
            var moveY = target.y + state.touchCorrection.y;
            var reviewZ = state.touchCorrection.z;

            writeStatus(
                statusFile,
                'awaiting_feedback',
                scanId,
                targetIndex + 1,
                targets.length,
                'Review target ' + (targetIndex + 1) + ' with nozzle ' + state.nozzleName
            );
            print('Interactive review target ' + (targetIndex + 1) + '/' + targets.length
                + ' object=' + target.objectIndex
                + ' nozzle=' + state.nozzleName
                + ' corrected X=' + moveX.toFixed(3)
                + ' Y=' + moveY.toFixed(3)
                + ' review Z=' + reviewZ.toFixed(3)
                + ' travel Z=' + travelZ.toFixed(3));

            moveNozzleToXyAtZ(nozzle, moveX, moveY, travelZ);
            moveNozzleToXyAtZ(nozzle, moveX, moveY, reviewZ);

            var feedback = showInteractiveReviewWindow(
                scanDir,
                scanId,
                targetIndex,
                targets.length,
                target,
                nozzle,
                state.nozzleName,
                state.touchCorrection,
                moveX,
                moveY,
                reviewZ
            );
            var recorded = nozzle.location;
            moveNozzleToXyAtZ(nozzle, recorded.x, recorded.y, travelZ);

            if (feedback.action === 'stop') {
                writeStatus(statusFile, 'halted', scanId, targetIndex + 1, targets.length, 'Interactive review stopped by user');
                return false;
            }
            if (feedback.action === 'switch') {
                parkNozzlesForScan(pickTool.head);
                state.nozzleName = state.nozzleName === 'N1' ? 'N2' : 'N1';
                print('Interactive review parked nozzles, switched configured nozzle to '
                    + state.nozzleName
                    + ', and will retry current target.');
                continue;
            }
            if (feedback.action === 'skip') {
                appendInteractiveReviewRecord(state.reviewFile, state.scanReviewFile, scanId, scanDir, target, state.nozzleName, 'skip', state.touchCorrection, moveX, moveY, recorded, null);
                state.reviewedCount++;
                parkNozzlesForScan(pickTool.head);
                return true;
            }
            if (feedback.action === 'save') {
                var residualX = recorded.x - moveX;
                var residualY = recorded.y - moveY;
                var sampledCorrection = {
                    x: recorded.x - target.x,
                    y: recorded.y - target.y,
                    z: recorded.z,
                    source: 'interactive save target ' + target.objectIndex
                };
                appendInteractiveReviewRecord(state.reviewFile, state.scanReviewFile, scanId, scanDir, target, state.nozzleName, 'save', sampledCorrection, moveX, moveY, recorded, {
                    residualX: residualX,
                    residualY: residualY
                });
                appendTouchCorrectionRecord(scanDir, scanId, target, sampledCorrection, moveX, moveY, recorded, residualX, residualY);
                state.touchCorrection = readTouchCorrection();
                state.reviewedCount++;
                parkNozzlesForScan(pickTool.head);
                return true;
            }

            appendInteractiveReviewRecord(state.reviewFile, state.scanReviewFile, scanId, scanDir, target, state.nozzleName, 'correct', state.touchCorrection, moveX, moveY, recorded, null);
            state.reviewedCount++;
            parkNozzlesForScan(pickTool.head);
            return true;
        }
    }

    function moveInteractiveReviewTargetAsync(scanDir, statusFile, scanId, targets, state) {
        if (state.reviewedCount >= targets.length) {
            writeStatus(statusFile, 'completed', scanId, targets.length, targets.length, 'Interactive target review completed');
            return;
        }

        var UiUtils = Packages.org.openpnp.util.UiUtils;
        UiUtils['submitUiMachineTask(Thrunnable)'](function() {
            var targetIndex = state.reviewedCount;
            var target = targets[targetIndex];
            parkNozzlesForScan(machine.defaultHead);
            var pickTool = findPickTool(state.headName, state.nozzleName);
            var nozzle = pickTool.nozzle;
            var travelZ = nozzle.location.z;
            var moveX = target.x + state.touchCorrection.x;
            var moveY = target.y + state.touchCorrection.y;
            var reviewZ = state.touchCorrection.z;

            writeStatus(
                statusFile,
                'awaiting_feedback',
                scanId,
                targetIndex + 1,
                targets.length,
                'Review target ' + (targetIndex + 1) + ' with nozzle ' + state.nozzleName
            );
            print('Async interactive review target ' + (targetIndex + 1) + '/' + targets.length
                + ' object=' + target.objectIndex
                + ' nozzle=' + state.nozzleName
                + ' corrected X=' + moveX.toFixed(3)
                + ' Y=' + moveY.toFixed(3)
                + ' review Z=' + reviewZ.toFixed(3)
                + ' travel Z=' + travelZ.toFixed(3));

            moveNozzleToXyAtZ(nozzle, moveX, moveY, travelZ);
            moveNozzleToXyAtZ(nozzle, moveX, moveY, reviewZ);
            showInteractiveReviewWindowAsync(
                scanDir,
                statusFile,
                scanId,
                targetIndex,
                targets.length,
                target,
                nozzle,
                state,
                targets,
                moveX,
                moveY,
                reviewZ
            );
        });
    }

    function showInteractiveReviewWindow(scanDir, scanId, targetIndex, totalTargets, target, nozzle, nozzleName, correction, moveX, moveY, reviewZ) {
        var queue = new Packages.java.util.concurrent.ArrayBlockingQueue(1);
        var runnable = new Packages.java.lang.Runnable({
            run: function() {
                var JFrame = Packages.javax.swing.JFrame;
                var JPanel = Packages.javax.swing.JPanel;
                var JLabel = Packages.javax.swing.JLabel;
                var JButton = Packages.javax.swing.JButton;
                var ImageIcon = Packages.javax.swing.ImageIcon;
                var BorderLayout = Packages.java.awt.BorderLayout;
                var GridLayout = Packages.java.awt.GridLayout;
                var FlowLayout = Packages.java.awt.FlowLayout;
                var Image = Packages.java.awt.Image;
                var EmptyBorder = Packages.javax.swing.border.EmptyBorder;
                var ActionListener = Packages.java.awt.event.ActionListener;

                var frame = new JFrame('Interactive Pick Review');
                frame.setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);
                frame.setAlwaysOnTop(true);

                var panel = new JPanel(new BorderLayout(8, 8));
                panel.setBorder(new EmptyBorder(12, 12, 12, 12));

                var details = new JPanel(new GridLayout(0, 1, 2, 2));
                details.add(new JLabel('Target ' + (targetIndex + 1) + ' of ' + totalTargets + ' (object ' + target.objectIndex + ')'));
                details.add(new JLabel('Current nozzle: ' + nozzleName));
                details.add(new JLabel('Commanded X=' + moveX.toFixed(3) + ' Y=' + moveY.toFixed(3) + ' Z=' + reviewZ.toFixed(3)));
                details.add(new JLabel('Correction dX=' + correction.x.toFixed(3) + ' dY=' + correction.y.toFixed(3)));
                details.add(new JLabel('Jog if needed, then choose feedback.'));
                panel.add(details, BorderLayout.CENTER);

                var imageLabel = makeTargetImageLabel(scanDir, target, ImageIcon, JLabel, Image);
                if (imageLabel !== null) {
                    panel.add(imageLabel, BorderLayout.NORTH);
                }

                var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
                var stopButton = new JButton('Stop');
                var skipButton = new JButton('Skip');
                var switchButton = new JButton('Switch Nozzle');
                var saveButton = new JButton('Save Jogged Position');
                var correctButton = new JButton('Correct');
                buttons.add(stopButton);
                buttons.add(skipButton);
                buttons.add(switchButton);
                buttons.add(saveButton);
                buttons.add(correctButton);
                panel.add(buttons, BorderLayout.SOUTH);

                function choose(action) {
                    queue.offer(JSON.stringify({ action: action }));
                    frame.dispose();
                }

                correctButton.addActionListener(new ActionListener({ actionPerformed: function(event) { choose('correct'); } }));
                saveButton.addActionListener(new ActionListener({ actionPerformed: function(event) { choose('save'); } }));
                switchButton.addActionListener(new ActionListener({ actionPerformed: function(event) { choose('switch'); } }));
                skipButton.addActionListener(new ActionListener({ actionPerformed: function(event) { choose('skip'); } }));
                stopButton.addActionListener(new ActionListener({ actionPerformed: function(event) { choose('stop'); } }));

                frame.setContentPane(panel);
                frame.pack();
                frame.setLocationRelativeTo(null);
                frame.setVisible(true);
            }
        });

        Packages.javax.swing.SwingUtilities.invokeLater(runnable);
        return JSON.parse(String(queue.take()));
    }

    function showInteractiveReviewWindowAsync(scanDir, statusFile, scanId, targetIndex, totalTargets, target, initialNozzle, state, targets, moveX, moveY, reviewZ) {
        var runnable = new Packages.java.lang.Runnable({
            run: function() {
                var JFrame = Packages.javax.swing.JFrame;
                var JPanel = Packages.javax.swing.JPanel;
                var JLabel = Packages.javax.swing.JLabel;
                var JButton = Packages.javax.swing.JButton;
                var ImageIcon = Packages.javax.swing.ImageIcon;
                var BorderLayout = Packages.java.awt.BorderLayout;
                var GridLayout = Packages.java.awt.GridLayout;
                var FlowLayout = Packages.java.awt.FlowLayout;
                var Image = Packages.java.awt.Image;
                var EmptyBorder = Packages.javax.swing.border.EmptyBorder;
                var ActionListener = Packages.java.awt.event.ActionListener;
                var UiUtils = Packages.org.openpnp.util.UiUtils;

                var currentNozzle = initialNozzle;
                var currentNozzleName = state.nozzleName;
                var currentMoveX = moveX;
                var currentMoveY = moveY;
                var currentReviewZ = reviewZ;

                var frame = new JFrame('Interactive Pick Review');
                frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
                frame.setAlwaysOnTop(true);

                var panel = new JPanel(new BorderLayout(8, 8));
                panel.setBorder(new EmptyBorder(12, 12, 12, 12));

                var details = new JPanel(new GridLayout(0, 1, 2, 2));
                var nozzleLabel = new JLabel('');
                var commandLabel = new JLabel('');
                details.add(new JLabel('Target ' + (targetIndex + 1) + ' of ' + totalTargets + ' (object ' + target.objectIndex + ')'));
                details.add(nozzleLabel);
                details.add(commandLabel);
                details.add(new JLabel('Correction dX=' + state.touchCorrection.x.toFixed(3)
                    + ' dY=' + state.touchCorrection.y.toFixed(3)
                    + ' Z=' + state.touchCorrection.z.toFixed(3)));
                details.add(new JLabel('Jog if needed, then choose feedback.'));
                panel.add(details, BorderLayout.CENTER);

                var imageLabel = makeTargetImageLabel(scanDir, target, ImageIcon, JLabel, Image);
                if (imageLabel !== null) {
                    panel.add(imageLabel, BorderLayout.NORTH);
                }

                var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
                var stopButton = new JButton('Stop');
                var skipButton = new JButton('Skip');
                var switchButton = new JButton('Switch Nozzle');
                var saveButton = new JButton('Save Jogged Position');
                var correctButton = new JButton('Correct');
                buttons.add(stopButton);
                buttons.add(skipButton);
                buttons.add(switchButton);
                buttons.add(saveButton);
                buttons.add(correctButton);
                panel.add(buttons, BorderLayout.SOUTH);

                function refreshLabels() {
                    nozzleLabel.setText('Current configured nozzle: ' + currentNozzleName);
                    commandLabel.setText('Commanded X=' + currentMoveX.toFixed(3)
                        + ' Y=' + currentMoveY.toFixed(3)
                        + ' Z=' + currentReviewZ.toFixed(3));
                }

                function finish(action, saveCorrection) {
                    var recorded = currentNozzle.location;
                    var residual = null;
                    var recordedCorrection = state.touchCorrection;
                    if (saveCorrection) {
                        var residualX = recorded.x - currentMoveX;
                        var residualY = recorded.y - currentMoveY;
                        residual = {
                            residualX: residualX,
                            residualY: residualY
                        };
                        var sampledCorrection = {
                            x: recorded.x - target.x,
                            y: recorded.y - target.y,
                            z: recorded.z,
                            source: 'interactive save target ' + target.objectIndex
                        };
                        appendTouchCorrectionRecord(scanDir, scanId, target, sampledCorrection, currentMoveX, currentMoveY, recorded, residualX, residualY);
                        state.touchCorrection = readTouchCorrection();
                        recordedCorrection = sampledCorrection;
                    }
                    appendInteractiveReviewRecord(state.reviewFile, state.scanReviewFile, scanId, scanDir, target, currentNozzleName, action, recordedCorrection, currentMoveX, currentMoveY, recorded, residual);
                    state.reviewedCount = targetIndex + 1;
                    writeStatus(statusFile, 'awaiting_feedback', scanId, state.reviewedCount, totalTargets, 'Interactive target review recorded: ' + action);
                    frame.dispose();
                    moveInteractiveReviewTargetAsync(scanDir, statusFile, scanId, targets, state);
                }

                correctButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        finish('correct', false);
                    }
                }));
                saveButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        finish('save', true);
                    }
                }));
                skipButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        finish('skip', false);
                    }
                }));
                stopButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        writeStatus(statusFile, 'halted', scanId, targetIndex + 1, totalTargets, 'Interactive review stopped by user');
                        frame.dispose();
                    }
                }));
                switchButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        UiUtils['submitUiMachineTask(Thrunnable)'](function() {
                            parkNozzlesForScan(machine.defaultHead);
                            currentNozzleName = currentNozzleName === 'N1' ? 'N2' : 'N1';
                            state.nozzleName = currentNozzleName;
                            var pickTool = findPickTool(state.headName, currentNozzleName);
                            currentNozzle = pickTool.nozzle;
                            var travelZ = currentNozzle.location.z;
                            moveNozzleToXyAtZ(currentNozzle, currentMoveX, currentMoveY, travelZ);
                            moveNozzleToXyAtZ(currentNozzle, currentMoveX, currentMoveY, currentReviewZ);
                            Packages.javax.swing.SwingUtilities.invokeLater(new Packages.java.lang.Runnable({
                                run: function() {
                                    refreshLabels();
                                }
                            }));
                        });
                    }
                }));

                refreshLabels();
                frame.setContentPane(panel);
                frame.pack();
                frame.setLocationRelativeTo(null);
                frame.setVisible(true);
            }
        });
        Packages.javax.swing.SwingUtilities.invokeLater(runnable);
    }

    function makeTargetImageLabel(scanDir, target, ImageIcon, JLabel, Image) {
        var relativePath = target.contextFile && target.contextFile.length > 0
            ? target.contextFile
            : target.overlayFile && target.overlayFile.length > 0
            ? target.overlayFile
            : target.sourceFile && target.sourceFile.length > 0
            ? target.sourceFile
            : target.cropFile;
        if (!relativePath || relativePath.length === 0) {
            return null;
        }

        var imageFile = new File(scanDir, relativePath);
        if (!imageFile.exists()) {
            return null;
        }

        var icon = new ImageIcon(imageFile.getAbsolutePath());
        var image = icon.getImage();
        var width = icon.getIconWidth();
        var height = icon.getIconHeight();
        var maxWidth = 720;
        var maxHeight = 420;
        if (width > maxWidth || height > maxHeight) {
            var scale = Math.min(maxWidth / width, maxHeight / height);
            image = image.getScaledInstance(
                Math.max(1, Math.round(width * scale)),
                Math.max(1, Math.round(height * scale)),
                Image.SCALE_SMOOTH
            );
            icon = new ImageIcon(image);
        }

        var label = new JLabel(icon);
        return label;
    }

    function makeScaledImageLabel(imageFile, ImageIcon, JLabel, Image, maxWidth, maxHeight) {
        if (!imageFile.exists()) {
            return null;
        }

        var icon = new ImageIcon(imageFile.getAbsolutePath());
        var image = icon.getImage();
        var width = icon.getIconWidth();
        var height = icon.getIconHeight();
        if (width > maxWidth || height > maxHeight) {
            var scale = Math.min(maxWidth / width, maxHeight / height);
            image = image.getScaledInstance(
                Math.max(1, Math.round(width * scale)),
                Math.max(1, Math.round(height * scale)),
                Image.SCALE_SMOOTH
            );
            icon = new ImageIcon(image);
        }

        return new JLabel(icon);
    }

    function readJsonFile(file) {
        if (!file.exists()) {
            return null;
        }
        var reader = new BufferedReader(new FileReader(file));
        var text = '';
        try {
            var line = reader.readLine();
            while (line !== null) {
                text += String(line);
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }
        return JSON.parse(text);
    }

    function reviewDecisionFile(scanDir) {
        return new File(scanDir, 'pick_review_decisions.jsonl');
    }

    function readPickReviewDecisions(scanDir) {
        var file = reviewDecisionFile(scanDir);
        var decisions = {};
        if (!file.exists()) {
            return decisions;
        }

        var reader = new BufferedReader(new FileReader(file));
        try {
            var line = reader.readLine();
            while (line !== null) {
                line = String(line).trim();
                if (line.length > 0) {
                    try {
                        var record = JSON.parse(line);
                        decisions[String(record.object_index)] = record;
                    }
                    catch (parseError) {
                        print('Skipping unreadable pick review decision: ' + parseError);
                    }
                }
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }
        return decisions;
    }

    function classifierPredictionFile(scanDir) {
        return new File(scanDir, 'classifier_predictions.jsonl');
    }

    function readClassifierPredictions(scanDir) {
        var file = classifierPredictionFile(scanDir);
        var predictions = {};
        if (!file.exists()) {
            return predictions;
        }

        var reader = new BufferedReader(new FileReader(file));
        try {
            var line = reader.readLine();
            while (line !== null) {
                line = String(line).trim();
                if (line.length > 0) {
                    try {
                        var record = JSON.parse(line);
                        predictions[String(record.object_index)] = record;
                    }
                    catch (parseError) {
                        print('Skipping unreadable classifier prediction: ' + parseError);
                    }
                }
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }
        return predictions;
    }

    function attachClassifierPredictions(scanDir, targets) {
        var predictions = readClassifierPredictions(scanDir);
        for (var i = 0; i < targets.length; i++) {
            var target = targets[i];
            var prediction = predictions[String(target.originalObjectIndex)];
            if (!prediction) {
                prediction = predictions[String(target.objectIndex)];
            }
            if (prediction) {
                target.classifierClass = String(prediction['class'] || 'unknown');
                target.classifierWouldPick = Boolean(prediction.would_pick);
                target.classifierInsectProbability = prediction.insect_probability === null || prediction.insect_probability === undefined
                    ? null
                    : Number(prediction.insect_probability);
                target.classifierDebrisProbability = prediction.debris_probability === null || prediction.debris_probability === undefined
                    ? null
                    : Number(prediction.debris_probability);
                target.classifierThreshold = prediction.threshold === null || prediction.threshold === undefined
                    ? null
                    : Number(prediction.threshold);
                target.classifierError = String(prediction.error || '');
            }
        }
    }

    function appendClassifierFeedback(scanDir, scanId, record) {
        var feedbackDir = new File(scriptsDir, 'Data/classifier_feedback');
        feedbackDir.mkdirs();
        var feedbackFile = new File(feedbackDir, 'insect_debris_feedback.jsonl');
        var scanFeedbackFile = new File(scanDir, 'classifier_feedback.jsonl');
        var payload = JSON.stringify(record) + '\n';

        var writer = new FileWriter(feedbackFile, true);
        try {
            writer.write(payload);
        }
        finally {
            writer.close();
        }

        var scanWriter = new FileWriter(scanFeedbackFile, true);
        try {
            scanWriter.write(payload);
        }
        finally {
            scanWriter.close();
        }
    }

    function debrisClassifierMode() {
        var calibration = loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        var mode = calibration.multiConfig && calibration.multiConfig.shared
            ? String(calibration.multiConfig.shared.debris_classifier_mode || 'train')
            : 'train';
        return mode === 'auto' ? 'auto' : 'train';
    }

    function classifierDecisionForTarget(target) {
        return target.classifierClass === 'debris' ? 'debris' : 'specimen';
    }

    function sanitizeTrainingLabel(label) {
        var text = String(label || '').toLowerCase();
        text = text.replace(/[^a-z0-9]+/g, '_');
        text = text.replace(/^_+|_+$/g, '');
        return text.length > 0 ? text : 'unspecified';
    }

    function mlTrainingDir(scanDir, scanId) {
        return new File(scanDir, 'ml_training_' + sanitizeTrainingLabel(scanId));
    }

    function copyReviewImage(scanDir, scanId, target, decision, debrisSubtype, kind) {
        var sourceName = kind === 'context' ? target.contextFile : target.cropFile;
        if (!sourceName || sourceName.length === 0) {
            return null;
        }
        var sourceFile = new File(scanDir, sourceName);
        if (!sourceFile.exists()) {
            return null;
        }

        var folder = new File(mlTrainingDir(scanDir, scanId), decision);
        if (decision === 'debris') {
            folder = new File(folder, sanitizeTrainingLabel(debrisSubtype));
        }
        folder.mkdirs();
        var extension = sourceFile.getName().lastIndexOf('.') >= 0
            ? sourceFile.getName().substring(sourceFile.getName().lastIndexOf('.'))
            : '.png';
        var targetName = 'object_' + pad(target.objectIndex, 6)
            + '_frame_' + pad(target.frameIndex, 5)
            + '_' + kind
            + extension;
        var targetFile = new File(folder, targetName);
        Packages.java.nio.file.Files.copy(
            sourceFile.toPath(),
            targetFile.toPath(),
            Packages.java.nio.file.StandardCopyOption.REPLACE_EXISTING
        );
        return targetFile.getPath();
    }

    function writePickReviewDecisions(scanDir, scanId, targets, decisions, debrisSubtypes, reviewSource, correctedPickPoints) {
        var file = reviewDecisionFile(scanDir);
        var writer = new FileWriter(file);
        var source = reviewSource === undefined ? 'manual' : String(reviewSource);
        var corrections = correctedPickPoints || {};
        try {
            for (var i = 0; i < targets.length; i++) {
                var target = targets[i];
                var decision = decisions[String(target.objectIndex)] || 'specimen';
                var debrisSubtype = decision === 'debris'
                    ? String(debrisSubtypes[String(target.objectIndex)] || 'uncertain')
                    : '';
                var corrected = corrections[String(target.objectIndex)] || null;
                var cropCopy = copyReviewImage(scanDir, scanId, target, decision, debrisSubtype, 'crop');
                var contextCopy = copyReviewImage(scanDir, scanId, target, decision, debrisSubtype, 'context');
                var record = {
                    scan_id: scanId,
                    scan_dir: scanDir.getAbsolutePath(),
                    ml_training_dir: mlTrainingDir(scanDir, scanId).getPath(),
                    object_index: target.objectIndex,
                    original_object_index: target.originalObjectIndex,
                    candidate_index: target.candidateIndex,
                    recovered_duplicate: Boolean(target.recoveredDuplicate),
                    duplicate_of_object_index: target.duplicateOfObjectIndex,
                    decision: decision,
                    debris_subtype: debrisSubtype,
                    pick: decision === 'specimen' && !target.unsafeForPick,
                    unsafe_for_pick: Boolean(target.unsafeForPick),
                    unsafe_reason: String(target.unsafeReason || ''),
                    unsafe_neighbor_object_index: target.unsafeNeighborObjectIndex,
                    unsafe_neighbor_distance_mm: target.unsafeNeighborDistanceMm,
                    bbox_area_mm2: target.bboxAreaMm === undefined ? null : target.bboxAreaMm,
                    source_file: target.sourceFile,
                    crop_file: target.cropFile,
                    context_file: target.contextFile,
                    overlay_file: target.overlayFile,
                    copied_crop_file: cropCopy,
                    copied_context_file: contextCopy,
                    frame_index: target.frameIndex,
                    pick_x_mm: target.x,
                    pick_y_mm: target.y,
                    corrected_pick: corrected !== null,
                    corrected_pick_source_x_px: corrected === null ? null : corrected.sourceX,
                    corrected_pick_source_y_px: corrected === null ? null : corrected.sourceY,
                    corrected_requested_frame_estimated_x_mm: corrected === null ? null : corrected.requestedFrameX,
                    corrected_requested_frame_estimated_y_mm: corrected === null ? null : corrected.requestedFrameY,
                    detection_score: target.score,
                    detection_quality_score: targetQualityScore(target),
                    classifier_prediction: String(target.classifierClass || ''),
                    classifier_would_pick: target.classifierWouldPick === undefined ? null : Boolean(target.classifierWouldPick),
                    classifier_insect_probability: target.classifierInsectProbability,
                    classifier_debris_probability: target.classifierDebrisProbability,
                    classifier_threshold: target.classifierThreshold,
                    classifier_error: String(target.classifierError || ''),
                    review_source: source,
                    reviewed_at: new Date().toISOString()
                };
                writer.write(JSON.stringify(record) + '\n');
                if (source === 'manual') {
                    appendClassifierFeedback(scanDir, scanId, record);
                }
            }
        }
        finally {
            writer.close();
        }
        print('Saved pick review decisions: ' + file.getAbsolutePath());
    }

    function imageFileForTarget(scanDir, target) {
        var markedFile = markedReviewImageForTarget(scanDir, target);
        if (markedFile !== null && markedFile.exists()) {
            return markedFile;
        }

        var candidates = [
            target.overlayFile,
            target.contextFile,
            target.cropFile,
            target.sourceFile
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (candidates[i] && candidates[i].length > 0) {
                var file = new File(scanDir, candidates[i]);
                if (file.exists()) {
                    return file;
                }
            }
        }
        return null;
    }

    function markedReviewImageForTarget(scanDir, target) {
        var sourceName = target.contextFile || target.cropFile;
        if (!sourceName || sourceName.length === 0) {
            return null;
        }
        var sourceFile = new File(scanDir, sourceName);
        if (!sourceFile.exists()) {
            return null;
        }

        var reviewDir = new File(scanDir, 'pick_review_targets');
        reviewDir.mkdirs();
        var markedFile = new File(
            reviewDir,
            'target_' + pad(target.objectIndex, 6)
                + '_frame_' + pad(target.frameIndex, 5)
                + '_marked_v3.png'
        );
        if (markedFile.exists()) {
            return markedFile;
        }

        try {
            var ImageIO = Packages.javax.imageio.ImageIO;
            var Color = Packages.java.awt.Color;
            var BasicStroke = Packages.java.awt.BasicStroke;
            var Font = Packages.java.awt.Font;
            var RenderingHints = Packages.java.awt.RenderingHints;
            var image = ImageIO.read(sourceFile);
            if (image === null) {
                return null;
            }

            var contextPaddingPx = 900;
            var sourceX0 = Math.max(0, target.bboxX - contextPaddingPx);
            var sourceY0 = Math.max(0, target.bboxY - contextPaddingPx);
            var rectX = Math.max(0, Math.round(target.bboxX - sourceX0));
            var rectY = Math.max(0, Math.round(target.bboxY - sourceY0));
            if (rectX >= image.getWidth() - 1 || rectY >= image.getHeight() - 1) {
                return null;
            }
            var rectW = Math.max(1, Math.round(target.bboxWidth));
            var rectH = Math.max(1, Math.round(target.bboxHeight));
            rectW = Math.min(rectW, Math.max(1, image.getWidth() - rectX - 1));
            rectH = Math.min(rectH, Math.max(1, image.getHeight() - rectY - 1));
            if (rectW <= 1 || rectH <= 1) {
                return null;
            }

            var g = image.createGraphics();
            try {
                g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

                var strokeWidth = 2;
                g.setStroke(new BasicStroke(strokeWidth));
                g.setColor(new Color(255, 0, 255));
                g.drawRect(rectX, rectY, rectW, rectH);
                g.setStroke(new BasicStroke(1));
                g.setColor(new Color(255, 255, 0));
                g.drawRect(rectX + 2, rectY + 2, Math.max(1, rectW - 4), Math.max(1, rectH - 4));

                var centerX = Math.round(rectX + (rectW / 2));
                var centerY = Math.round(rectY + (rectH / 2));
                var crossSize = Math.max(8, Math.round(Math.min(rectW, rectH) * 0.18));
                g.setStroke(new BasicStroke(1));
                g.drawLine(centerX - crossSize, centerY, centerX + crossSize, centerY);
                g.drawLine(centerX, centerY - crossSize, centerX, centerY + crossSize);

                var label = 'target ' + Number(target.reviewNumber || (Number(target.objectIndex) + 1));
                var fontSize = Math.max(12, Math.round(Math.min(image.getWidth(), image.getHeight()) / 42));
                g.setFont(new Font('SansSerif', Font.BOLD, fontSize));
                var metrics = g.getFontMetrics();
                var labelX = 10;
                var labelY = metrics.getAscent() + 10;
                g.setColor(new Color(0, 0, 0, 140));
                g.fillRect(labelX, labelY - metrics.getAscent() - 5,
                    metrics.stringWidth(label) + 10,
                    metrics.getAscent() + metrics.getDescent() + 8);
                g.setColor(new Color(255, 255, 0));
                g.drawString(label, labelX + 5, labelY);
            }
            finally {
                g.dispose();
            }

            ImageIO.write(image, 'png', markedFile);
            return markedFile;
        }
        catch (error) {
            print('Could not create marked review image for object ' + target.objectIndex + ': ' + error);
            return null;
        }
    }

    function correctedReviewImageForTarget(scanDir, target, correction) {
        if (correction === null || correction === undefined) {
            return markedReviewImageForTarget(scanDir, target);
        }
        var baseFile = markedReviewImageForTarget(scanDir, target);
        if (baseFile === null || !baseFile.exists()) {
            return null;
        }
        try {
            var ImageIO = Packages.javax.imageio.ImageIO;
            var Color = Packages.java.awt.Color;
            var BasicStroke = Packages.java.awt.BasicStroke;
            var image = ImageIO.read(baseFile);
            if (image === null) {
                return null;
            }
            var origin = {
                x: Math.max(0, Number(target.bboxX || 0) - 900),
                y: Math.max(0, Number(target.bboxY || 0) - 900)
            };
            var markerX = Math.round(Number(correction.sourceX) - origin.x);
            var markerY = Math.round(Number(correction.sourceY) - origin.y);
            var g = image.createGraphics();
            try {
                g.setColor(new Color(0, 255, 255));
                g.setStroke(new BasicStroke(3));
                var size = 18;
                g.drawLine(markerX - size, markerY, markerX + size, markerY);
                g.drawLine(markerX, markerY - size, markerX, markerY + size);
                g.drawOval(markerX - size, markerY - size, size * 2, size * 2);
            }
            finally {
                g.dispose();
            }
            var reviewDir = new File(scanDir, 'pick_review_targets');
            reviewDir.mkdirs();
            var correctedFile = new File(
                reviewDir,
                'target_' + pad(target.objectIndex, 6)
                    + '_frame_' + pad(target.frameIndex, 5)
                    + '_corrected_pick.png'
            );
            ImageIO.write(image, 'png', correctedFile);
            return correctedFile;
        }
        catch (error) {
            print('Could not create corrected pick review image for object ' + target.objectIndex + ': ' + error);
            return baseFile;
        }
    }

    function scaledIconForFile(imageFile, ImageIcon, Image, maxWidth, maxHeight) {
        if (imageFile === null || !imageFile.exists()) {
            return null;
        }
        var icon = new ImageIcon(imageFile.getAbsolutePath());
        var image = icon.getImage();
        var width = icon.getIconWidth();
        var height = icon.getIconHeight();
        if (width > maxWidth || height > maxHeight) {
            var scale = Math.min(maxWidth / width, maxHeight / height);
            image = image.getScaledInstance(
                Math.max(1, Math.round(width * scale)),
                Math.max(1, Math.round(height * scale)),
                Image.SCALE_SMOOTH
            );
            icon = new ImageIcon(image);
        }
        return icon;
    }

    function showDetectionSummaryAndConfirm(scanDir, statusFile, scanId, totalFrames) {
        var complete = readJsonFile(new File(scanDir, 'segmentation_complete.json'));
        var summaryFile = complete !== null && complete.summary_file
            ? new File(scanDir, String(complete.summary_file))
            : new File(scanDir, 'detection_summary.png');
        runInsectDebrisClassifier(scanDir, new File(projectDir, 'control'));
        var targets = readPickTargets(scanDir, true, true, true);
        attachClassifierPredictions(scanDir, targets);
        targets.sort(function(a, b) {
            return Number(a.objectIndex) - Number(b.objectIndex);
        });
        if (debrisClassifierMode() === 'auto') {
            var autoDecisions = {};
            var autoDebrisSubtypes = {};
            var autoSpecimenCount = 0;
            var autoDebrisCount = 0;
            for (var autoIndex = 0; autoIndex < targets.length; autoIndex++) {
                var autoTarget = targets[autoIndex];
                var autoDecision = classifierDecisionForTarget(autoTarget);
                autoDecisions[String(autoTarget.objectIndex)] = autoDecision;
                autoDebrisSubtypes[String(autoTarget.objectIndex)] = autoDecision === 'debris'
                    ? 'classifier'
                    : 'uncertain';
                if (autoDecision === 'debris') {
                    autoDebrisCount++;
                }
                else {
                    autoSpecimenCount++;
                }
            }
            writePickReviewDecisions(scanDir, scanId, targets, autoDecisions, autoDebrisSubtypes, 'classifier_auto');
            print('Auto-classified debris before picking: specimens=' + autoSpecimenCount
                + ' debris=' + autoDebrisCount
                + ' total=' + targets.length);
            return true;
        }
        var queue = new Packages.java.util.concurrent.ArrayBlockingQueue(1);
        var runnable = new Packages.java.lang.Runnable({
            run: function() {
                var JFrame = Packages.javax.swing.JFrame;
                var JPanel = Packages.javax.swing.JPanel;
                var JLabel = Packages.javax.swing.JLabel;
                var JButton = Packages.javax.swing.JButton;
                var JRadioButton = Packages.javax.swing.JRadioButton;
                var ButtonGroup = Packages.javax.swing.ButtonGroup;
                var JComboBox = Packages.javax.swing.JComboBox;
                var DefaultComboBoxModel = Packages.javax.swing.DefaultComboBoxModel;
                var JScrollPane = Packages.javax.swing.JScrollPane;
                var ImageIcon = Packages.javax.swing.ImageIcon;
                var BorderLayout = Packages.java.awt.BorderLayout;
                var GridLayout = Packages.java.awt.GridLayout;
                var FlowLayout = Packages.java.awt.FlowLayout;
                var Image = Packages.java.awt.Image;
                var Dimension = Packages.java.awt.Dimension;
                var Font = Packages.java.awt.Font;
                var EmptyBorder = Packages.javax.swing.border.EmptyBorder;
                var ActionListener = Packages.java.awt.event.ActionListener;
                var WindowAdapter = Packages.java.awt.event.WindowAdapter;
                var MouseAdapter = Packages.java.awt.event.MouseAdapter;
                var ImageIO = Packages.javax.imageio.ImageIO;

                var frame = new JFrame('Detected Target Review');
                frame.setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);
                frame.setAlwaysOnTop(true);

                var panel = new JPanel(new BorderLayout(8, 8));
                panel.setBorder(new EmptyBorder(12, 12, 12, 12));

                var details = new JPanel(new GridLayout(0, 1, 2, 2));
                details.setFont(new Font('Dialog', Font.PLAIN, 18));
                var objectCount = complete === null ? 0 : Number(complete.object_count || 0);
                var candidateCount = complete === null ? 0 : Number(complete.candidate_count || 0);
                var duplicateCount = complete === null ? 0 : Number(complete.duplicate_count || 0);
                var uniqueLabel = new JLabel('Unique targets: ' + objectCount);
                var candidateLabel = new JLabel('Frame candidates: ' + candidateCount + '   Duplicates: ' + duplicateCount);
                uniqueLabel.setFont(new Font('Dialog', Font.PLAIN, 18));
                candidateLabel.setFont(new Font('Dialog', Font.PLAIN, 18));
                details.add(uniqueLabel);
                details.add(candidateLabel);
                panel.add(details, BorderLayout.NORTH);

                var centerPanel = new JPanel(new GridLayout(1, 2, 10, 0));
                var imageLabel = makeScaledImageLabel(summaryFile, ImageIcon, JLabel, Image, 900, 900);
                if (imageLabel !== null) {
                    var summaryScroll = new JScrollPane(imageLabel);
                    summaryScroll.setPreferredSize(new Dimension(940, 820));
                    centerPanel.add(summaryScroll);
                }
                else {
                    centerPanel.add(new JLabel('No detection summary image found: ' + summaryFile.getAbsolutePath()));
                }

                var reviewPanel = new JPanel(new BorderLayout(6, 6));
                var targetLabel = new JLabel('');
                var classifierLabel = new JLabel('');
                var correctionLabel = new JLabel('Pick point: detector centroid');
                var zoomLabel = new JLabel('');
                zoomLabel.setHorizontalAlignment(JLabel.CENTER);
                var zoomScroll = new JScrollPane(zoomLabel);
                zoomScroll.setPreferredSize(new Dimension(940, 640));
                var specimenButton = new JRadioButton('pick - specimen');
                var debrisButton = new JRadioButton("don't pick - debris");
                var debrisSubtypeLabel = new JLabel('debris type');
                var debrisSubtypeModel = new DefaultComboBoxModel();
                debrisSubtypeModel.addElement('uncertain');
                debrisSubtypeModel.addElement('clumped/overlapping specimens');
                debrisSubtypeModel.addElement('insect part');
                debrisSubtypeModel.addElement('mostly off-screen specimen');
                debrisSubtypeModel.addElement('plant debris');
                debrisSubtypeModel.addElement('non-insect specimen');
                debrisSubtypeModel.addElement('shadow/artifact');
                var debrisSubtypeBox = new JComboBox(debrisSubtypeModel);
                var resetPickPointButton = new JButton('Reset pick point');
                var selectionCountLabel = new JLabel('');
                var pinnedSelectionCountLabel = new JLabel('');
                var reviewFont = new Font('Dialog', Font.PLAIN, 20);
                var reviewBoldFont = new Font('Dialog', Font.BOLD, 20);
                targetLabel.setFont(reviewBoldFont);
                classifierLabel.setFont(reviewBoldFont);
                correctionLabel.setFont(reviewFont);
                specimenButton.setFont(reviewFont);
                debrisButton.setFont(reviewFont);
                debrisSubtypeLabel.setFont(reviewFont);
                debrisSubtypeBox.setFont(reviewFont);
                resetPickPointButton.setFont(reviewFont);
                selectionCountLabel.setFont(reviewFont);
                pinnedSelectionCountLabel.setFont(reviewBoldFont);
                var group = new ButtonGroup();
                group.add(specimenButton);
                group.add(debrisButton);
                var decisions = {};
                var debrisSubtypes = {};
                var correctedPickPoints = {};
                var currentIndex = 0;

                for (var targetIndex = 0; targetIndex < targets.length; targetIndex++) {
                    targets[targetIndex].reviewNumber = targetIndex + 1;
                    decisions[String(targets[targetIndex].objectIndex)] = targets[targetIndex].classifierClass === 'debris'
                        ? 'debris'
                        : 'specimen';
                    debrisSubtypes[String(targets[targetIndex].objectIndex)] = 'uncertain';
                }

                function selectedSpecimenCount() {
                    var count = 0;
                    for (var countIndex = 0; countIndex < targets.length; countIndex++) {
                        if (!targets[countIndex].unsafeForPick
                                && (decisions[String(targets[countIndex].objectIndex)] || 'specimen') === 'specimen') {
                            count++;
                        }
                    }
                    return count;
                }

                function unsafeTargetCount() {
                    var count = 0;
                    for (var unsafeIndex = 0; unsafeIndex < targets.length; unsafeIndex++) {
                        if (targets[unsafeIndex].unsafeForPick) {
                            count++;
                        }
                    }
                    return count;
                }

                function updateSelectionCount() {
                    var countText = 'Initial targets: ' + targets.length
                        + '   Selected to pick: ' + selectedSpecimenCount()
                        + '   Unsafe targets: ' + unsafeTargetCount();
                    selectionCountLabel.setText(countText);
                    pinnedSelectionCountLabel.setText(countText);
                }

                function updateDebrisSubtypeEnabled() {
                    var enabled = debrisButton.isSelected();
                    debrisSubtypeLabel.setEnabled(enabled);
                    debrisSubtypeBox.setEnabled(enabled);
                }

                function saveCurrentDecision() {
                    if (targets.length === 0) {
                        updateSelectionCount();
                        updateDebrisSubtypeEnabled();
                        return;
                    }
                    var target = targets[currentIndex];
                    decisions[String(target.objectIndex)] = debrisButton.isSelected() ? 'debris' : 'specimen';
                    debrisSubtypes[String(target.objectIndex)] = String(debrisSubtypeBox.getSelectedItem() || 'uncertain');
                    updateSelectionCount();
                    updateDebrisSubtypeEnabled();
                }

                function contextOriginForTarget(target) {
                    var contextPaddingPx = 900;
                    return {
                        x: Math.max(0, Number(target.bboxX || 0) - contextPaddingPx),
                        y: Math.max(0, Number(target.bboxY || 0) - contextPaddingPx)
                    };
                }

                function clickedImagePoint(label, event) {
                    var icon = label.getIcon();
                    if (icon === null) {
                        return null;
                    }
                    var iconX = Math.max(0, Math.floor((label.getWidth() - icon.getIconWidth()) / 2));
                    var iconY = Math.max(0, Math.floor((label.getHeight() - icon.getIconHeight()) / 2));
                    var x = Number(event.getX()) - iconX;
                    var y = Number(event.getY()) - iconY;
                    if (x < 0 || y < 0 || x >= icon.getIconWidth() || y >= icon.getIconHeight()) {
                        return null;
                    }
                    return {
                        x: x,
                        y: y,
                        width: icon.getIconWidth(),
                        height: icon.getIconHeight()
                    };
                }

                function correctedMachinePointForTarget(target, imageFile, point) {
                    var image = ImageIO.read(imageFile);
                    if (image === null) {
                        return null;
                    }
                    var origin = contextOriginForTarget(target);
                    var imageX = Number(point.x) * (Number(image.getWidth()) / Number(point.width));
                    var imageY = Number(point.y) * (Number(image.getHeight()) / Number(point.height));
                    var sourceX = origin.x + imageX;
                    var sourceY = origin.y + imageY;
                    var centerX = Number(target.imageWidth || image.getWidth()) / 2.0;
                    var centerY = Number(target.imageHeight || image.getHeight()) / 2.0;
                    var frameX = isNaN(Number(target.requestedFrameX)) ? Number(target.frameX) : Number(target.requestedFrameX);
                    var frameY = isNaN(Number(target.requestedFrameY)) ? Number(target.frameY) : Number(target.requestedFrameY);
                    var correctedX = frameX + ((sourceX - centerX) * Number(target.unitsPerPixelX || 0));
                    var correctedY = frameY - ((sourceY - centerY) * Number(target.unitsPerPixelY || 0));
                    return {
                        sourceX: sourceX,
                        sourceY: sourceY,
                        requestedFrameX: correctedX,
                        requestedFrameY: correctedY
                    };
                }

                function updateCorrectionLabel(target) {
                    var correction = correctedPickPoints[String(target.objectIndex)];
                    correctionLabel.setText(correction
                        ? 'Pick point: manually corrected X=' + Number(correction.requestedFrameX).toFixed(3)
                            + ' Y=' + Number(correction.requestedFrameY).toFixed(3)
                        : 'Pick point: detector centroid');
                }

                function showTarget(index) {
                    if (targets.length === 0) {
                        targetLabel.setText('No unique targets available.');
                        classifierLabel.setText('');
                        zoomLabel.setIcon(null);
                        specimenButton.setEnabled(false);
                        debrisButton.setEnabled(false);
                        debrisSubtypeLabel.setEnabled(false);
                        debrisSubtypeBox.setEnabled(false);
                        correctionLabel.setText('Pick point: detector centroid');
                        updateSelectionCount();
                        return;
                    }
                    currentIndex = Math.max(0, Math.min(index, targets.length - 1));
                    var target = targets[currentIndex];
                    var decision = decisions[String(target.objectIndex)] || 'specimen';
                    specimenButton.setSelected(decision === 'specimen');
                    debrisButton.setSelected(decision === 'debris');
                    debrisSubtypeBox.setSelectedItem(debrisSubtypes[String(target.objectIndex)] || 'uncertain');
                    updateDebrisSubtypeEnabled();
                    updateCorrectionLabel(target);
                    targetLabel.setText('Target ' + target.reviewNumber
                        + ' of ' + targets.length
                        + ' | tray ' + target.sortingTraySlot
                        + ' event ' + target.collectionEventSlot
                        + ' | object ' + target.objectIndex
                        + ' | frame ' + target.frameIndex
                        + (target.recoveredDuplicate ? ' | recovered duplicate' : '')
                        + (target.unsafeForPick
                            ? ' | UNSAFE '
                                + target.unsafeReason
                                + (target.unsafeNeighborDistanceMm === null
                                    ? ''
                                    : ' | neighbor '
                                        + target.unsafeNeighborObjectIndex
                                        + ' at '
                                        + Number(target.unsafeNeighborDistanceMm).toFixed(2)
                                        + 'mm')
                            : ''));
                    var probabilityText = target.classifierInsectProbability === null || target.classifierInsectProbability === undefined
                        ? ''
                        : ' | insect p=' + Number(target.classifierInsectProbability).toFixed(2)
                            + ' debris p=' + Number(target.classifierDebrisProbability).toFixed(2)
                            + ' threshold=' + Number(target.classifierThreshold).toFixed(2);
                    classifierLabel.setText('Classifier: '
                        + (target.classifierClass || 'not available')
                        + probabilityText
                        + (target.classifierError ? ' | ' + target.classifierError : ''));
                    var targetImage = correctedReviewImageForTarget(
                        scanDir,
                        target,
                        correctedPickPoints[String(target.objectIndex)]
                    );
                    if (targetImage === null) {
                        targetImage = imageFileForTarget(scanDir, target);
                    }
                    var icon = scaledIconForFile(targetImage, ImageIcon, Image, 860, 540);
                    if (icon !== null) {
                        zoomLabel.setText('');
                        zoomLabel.setIcon(icon);
                    }
                    else {
                        zoomLabel.setIcon(null);
                        zoomLabel.setText('No target image found for object ' + target.objectIndex);
                    }
                }

                var nav = new JPanel(new BorderLayout(8, 4));
                var prevButton = new JButton('<');
                var nextButton = new JButton('>');
                prevButton.setFont(reviewBoldFont);
                nextButton.setFont(reviewBoldFont);
                prevButton.setPreferredSize(new Dimension(72, 44));
                nextButton.setPreferredSize(new Dimension(72, 44));
                prevButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        saveCurrentDecision();
                        showTarget(currentIndex - 1);
                    }
                }));
                nextButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        saveCurrentDecision();
                        showTarget(currentIndex + 1);
                    }
                }));
                var targetHeader = new JPanel(new BorderLayout(8, 2));
                targetHeader.add(targetLabel, BorderLayout.CENTER);
                var targetHeaderSouth = new JPanel(new GridLayout(0, 1, 2, 2));
                targetHeaderSouth.add(classifierLabel);
                targetHeaderSouth.add(pinnedSelectionCountLabel);
                targetHeader.add(targetHeaderSouth, BorderLayout.SOUTH);
                nav.add(prevButton, BorderLayout.WEST);
                nav.add(targetHeader, BorderLayout.CENTER);
                nav.add(nextButton, BorderLayout.EAST);

                var choicePanel = new JPanel(new FlowLayout(FlowLayout.CENTER));
                choicePanel.add(specimenButton);
                choicePanel.add(debrisButton);
                choicePanel.add(debrisSubtypeLabel);
                choicePanel.add(debrisSubtypeBox);
                choicePanel.add(resetPickPointButton);
                choicePanel.add(selectionCountLabel);
                specimenButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        saveCurrentDecision();
                    }
                }));
                debrisSubtypeBox.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        saveCurrentDecision();
                    }
                }));
                debrisButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        saveCurrentDecision();
                    }
                }));
                resetPickPointButton.addActionListener(new ActionListener({
                    actionPerformed: function(event) {
                        if (targets.length > 0) {
                            delete correctedPickPoints[String(targets[currentIndex].objectIndex)];
                            updateCorrectionLabel(targets[currentIndex]);
                            showTarget(currentIndex);
                        }
                    }
                }));
                zoomLabel.addMouseListener(new MouseAdapter({
                    mouseClicked: function(event) {
                        if (targets.length === 0) {
                            return;
                        }
                        var target = targets[currentIndex];
                        var targetImage = imageFileForTarget(scanDir, target);
                        if (targetImage === null || !targetImage.exists()) {
                            return;
                        }
                        var point = clickedImagePoint(zoomLabel, event);
                        if (point === null) {
                            return;
                        }
                        var corrected = correctedMachinePointForTarget(target, targetImage, point);
                        if (corrected === null) {
                            return;
                        }
                        correctedPickPoints[String(target.objectIndex)] = corrected;
                        specimenButton.setSelected(true);
                        saveCurrentDecision();
                        updateCorrectionLabel(target);
                        showTarget(currentIndex);
                    }
                }));

                reviewPanel.add(nav, BorderLayout.NORTH);
                reviewPanel.add(zoomScroll, BorderLayout.CENTER);
                reviewPanel.add(choicePanel, BorderLayout.SOUTH);
                centerPanel.add(reviewPanel);
                panel.add(centerPanel, BorderLayout.CENTER);

                var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
                var startButton = new JButton('Start Picking');
                startButton.setFont(reviewBoldFont);
                startButton.setPreferredSize(new Dimension(190, 52));
                buttons.add(startButton);
                panel.add(buttons, BorderLayout.SOUTH);

                function startPicking() {
                    saveCurrentDecision();
                    writePickReviewDecisions(scanDir, scanId, targets, decisions, debrisSubtypes, 'manual', correctedPickPoints);
                    queue.offer('start');
                    frame.dispose();
                }

                function cancelPicking() {
                    queue.offer('cancel');
                    frame.dispose();
                }

                startButton.addActionListener(new ActionListener({ actionPerformed: function(event) { startPicking(); } }));
                frame.addWindowListener(new WindowAdapter({ windowClosing: function(event) { cancelPicking(); } }));

                showTarget(0);
                frame.setContentPane(panel);
                frame.pack();
                var screenSize = Packages.java.awt.Toolkit.getDefaultToolkit().getScreenSize();
                var maxFrameWidth = Math.max(1200, Number(screenSize.width) - 120);
                var maxFrameHeight = Math.max(900, Number(screenSize.height) - 120);
                if (frame.getWidth() > maxFrameWidth || frame.getHeight() > maxFrameHeight) {
                    frame.setSize(
                        Math.min(frame.getWidth(), maxFrameWidth),
                        Math.min(frame.getHeight(), maxFrameHeight)
                    );
                }
                frame.setLocationRelativeTo(null);
                frame.setVisible(true);
            }
        });

        Packages.javax.swing.SwingUtilities.invokeLater(runnable);
        var action = String(queue.take());
        if (action !== 'start') {
            print('Detection review canceled. Pick/drop sequence will not run.');
            writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Detection review canceled; pick/drop skipped');
            return false;
        }
        print('Detection summary accepted. Starting pick/drop.');
        return true;
    }

    function appendInteractiveReviewRecord(reviewFile, scanReviewFile, scanId, scanDir, target, nozzleName, action, correction, moveX, moveY, recorded, residual) {
        var record = {
            scan_id: scanId,
            scan_dir: scanDir.getAbsolutePath(),
            object_index: target.objectIndex,
            action: action,
            nozzle_name: nozzleName,
            raw_x_mm: target.x,
            raw_y_mm: target.y,
            source_file: target.sourceFile,
            crop_file: target.cropFile,
            context_file: target.contextFile,
            overlay_file: target.overlayFile,
            coordinate_transform_version: target.coordinateTransformVersion,
            bbox_x_px: target.bboxX,
            bbox_y_px: target.bboxY,
            bbox_width_px: target.bboxWidth,
            bbox_height_px: target.bboxHeight,
            bbox_area_px: target.bboxArea,
            image_width_px: target.imageWidth,
            image_height_px: target.imageHeight,
            detection_score: target.score,
            detection_quality_score: targetQualityScore(target),
            commanded_x_mm: moveX,
            commanded_y_mm: moveY,
            recorded_x_mm: recorded.x,
            recorded_y_mm: recorded.y,
            recorded_z_mm: recorded.z,
            applied_correction_x_mm: correction.x,
            applied_correction_y_mm: correction.y,
            residual_correction_x_mm: residual === null ? null : residual.residualX,
            residual_correction_y_mm: residual === null ? null : residual.residualY,
            recorded_at: new Date().toISOString()
        };
        var line = JSON.stringify(record) + '\n';
        appendText(reviewFile, line);
        appendText(scanReviewFile, line);
        print('Interactive review record: ' + line);
    }

    function appendTouchCorrectionRecord(scanDir, scanId, target, totalCorrection, moveX, moveY, recorded, residualX, residualY) {
        var calibrationFile = new File(projectDir, 'control/touch_calibration.jsonl');
        var scanCalibrationFile = new File(scanDir, 'touch_calibration.jsonl');
        var record = {
            scan_id: scanId,
            scan_dir: scanDir.getAbsolutePath(),
            object_index: target.objectIndex,
            raw_commanded_x_mm: target.x,
            raw_commanded_y_mm: target.y,
            source_file: target.sourceFile,
            crop_file: target.cropFile,
            context_file: target.contextFile,
            overlay_file: target.overlayFile,
            coordinate_transform_version: target.coordinateTransformVersion,
            bbox_x_px: target.bboxX,
            bbox_y_px: target.bboxY,
            bbox_width_px: target.bboxWidth,
            bbox_height_px: target.bboxHeight,
            bbox_area_px: target.bboxArea,
            image_width_px: target.imageWidth,
            image_height_px: target.imageHeight,
            detection_score: target.score,
            detection_quality_score: targetQualityScore(target),
            commanded_x_mm: moveX,
            commanded_y_mm: moveY,
            recorded_x_mm: recorded.x,
            recorded_y_mm: recorded.y,
            recorded_z_mm: recorded.z,
            residual_correction_x_mm: residualX,
            residual_correction_y_mm: residualY,
            total_correction_x_mm: totalCorrection.x,
            total_correction_y_mm: totalCorrection.y,
            correction_x_mm: residualX,
            correction_y_mm: residualY,
            recorded_at: new Date().toISOString()
        };
        var line = JSON.stringify(record) + '\n';
        appendText(calibrationFile, line);
        appendText(scanCalibrationFile, line);
        print('Updated touch calibration from interactive review: ' + line);
    }

    function debugTouchTarget(scanDir, target, nozzle, travelZ, dryRun, touchCorrection, moveX, moveY) {
        print('Touch coordinate debug for object ' + target.objectIndex + ':'
            + ' scan=' + scanDir.getName()
            + ' chosen X=' + target.x.toFixed(3)
            + ' Y=' + target.y.toFixed(3)
            + ' corrected-command X=' + moveX.toFixed(3)
            + ' Y=' + moveY.toFixed(3)
            + ' correction X=' + touchCorrection.x.toFixed(3)
            + ' Y=' + touchCorrection.y.toFixed(3)
            + ' raw-estimate X=' + target.estimatedX.toFixed(3)
            + ' Y=' + target.estimatedY.toFixed(3)
            + ' requested-frame estimate X=' + target.requestedEstimateX.toFixed(3)
            + ' Y=' + target.requestedEstimateY.toFixed(3)
            + ' frame camera X=' + target.frameX.toFixed(3)
            + ' Y=' + target.frameY.toFixed(3)
            + ' frame requested X=' + target.requestedFrameX.toFixed(3)
            + ' Y=' + target.requestedFrameY.toFixed(3)
            + ' current nozzle=' + formatLocation(nozzle.location)
            + ' travel Z=' + travelZ.toFixed(3)
            + ' dry_run=' + dryRun);
    }

    function findHeadByName(headName) {
        try {
            var heads = machine.getHeads();
            for (var i = 0; i < heads.size(); i++) {
                var head = heads.get(i);
                if (head.getName() === headName) {
                    return head;
                }
            }
        }
        catch (error) {
            print('Could not enumerate heads; using default head: ' + error);
            if (machine.defaultHead.getName() === headName) {
                return machine.defaultHead;
            }
        }
        throw new Error('Requested pick head not found: ' + headName);
    }

    function findNozzleOnHead(head, nozzleName) {
        try {
            var nozzles = head.getNozzles();
            for (var i = 0; i < nozzles.size(); i++) {
                var nozzle = nozzles.get(i);
                if (nozzle.getName() === nozzleName) {
                    return nozzle;
                }
            }
        }
        catch (error) {
            print('Could not enumerate nozzles; using default nozzle: ' + error);
            if (head.defaultNozzle.getName() === nozzleName) {
                return head.defaultNozzle;
            }
        }
        throw new Error('Requested pick nozzle not found on head ' + head.getName() + ': ' + nozzleName);
    }

    function findPickTool(headName, nozzleName) {
        var head = findHeadByName(headName);
        var nozzle = findNozzleOnHead(head, nozzleName);
        print('Pick tool selected: head=' + head.getName()
            + ' nozzle=' + nozzle.getName()
            + ' nozzle location=' + formatLocation(nozzle.location));
        return {
            head: head,
            nozzle: nozzle
        };
    }

    function printNozzleLocations(head) {
        try {
            var nozzles = head.getNozzles();
            for (var i = 0; i < nozzles.size(); i++) {
                var nozzle = nozzles.get(i);
                print('Nozzle state: ' + nozzle.getName() + ' location=' + formatLocation(nozzle.location));
            }
        }
        catch (error) {
            print('Could not enumerate nozzle states: ' + error);
        }
    }

    function parkNozzlesForScan(head) {
        print('Parking nozzles before scan XY motion.');
        printNozzleLocations(head);
        try {
            var nozzles = head.getNozzles();
            for (var i = 0; i < nozzles.size(); i++) {
                parkNozzle(nozzles.get(i));
            }
        }
        catch (error) {
            print('Could not enumerate nozzles for parking: ' + error);
            try {
                parkNozzle(head.defaultNozzle);
            }
            catch (defaultError) {
                print('Could not park default nozzle: ' + defaultError);
            }
        }
        print('Nozzle states after parking:');
        printNozzleLocations(head);
    }

    function parkNozzle(nozzle) {
        try {
            nozzle.moveToSafeZ();
            print('Parked nozzle with OpenPnP safe Z: ' + nozzle.getName()
                + ' location=' + formatLocation(nozzle.location));
            return;
        }
        catch (safeZError) {
            print('OpenPnP safe Z park failed for ' + nozzle.getName()
                + '; using fallback park Z: ' + safeZError);
        }

        var parkZ = fallbackParkZForNozzle(nozzle);
        moveNozzleToXyAtZ(nozzle, nozzle.location.x, nozzle.location.y, parkZ);
        print('Parked nozzle with fallback Z: ' + nozzle.getName()
            + ' location=' + formatLocation(nozzle.location));
    }

    function fallbackParkZForNozzle(nozzle) {
        if (nozzle.getName() === 'N1') {
            return -15.3;
        }
        if (nozzle.getName() === 'N2') {
            return 26.5;
        }
        return nozzle.location.z;
    }

    function findVacuumActuator(head, nozzle) {
        var actuatorName = 'VAC1';

        try {
            actuatorName = nozzle.getVacuumActuatorName();
        }
        catch (error) {
            print('Could not read nozzle vacuum actuator name; using VAC1: ' + error);
        }

        try {
            return head.getActuatorByName(actuatorName);
        }
        catch (headError) {
            print('Could not get head actuator ' + actuatorName + ': ' + headError);
        }

        try {
            return machine.getActuatorByName(actuatorName);
        }
        catch (machineError) {
            print('Could not get machine actuator ' + actuatorName + ': ' + machineError);
        }

        throw new Error('Vacuum actuator not found: ' + actuatorName);
    }

    function setVacuum(vacuumActuator, enabled) {
        vacuumActuator.actuate(enabled);
        Packages.java.lang.Thread.sleep(200);
    }

    function readVacuumLevel(vacuumActuator) {
        var value = null;
        try {
            value = vacuumActuator.read();
        }
        catch (readError) {
            try {
                value = vacuumActuator.readDouble();
            }
            catch (readDoubleError) {
                try {
                    value = vacuumActuator.getLastValue();
                }
                catch (lastValueError) {
                    print('Could not read vacuum pressure from actuator '
                        + vacuumActuator.getName() + ': ' + readError
                        + '; ' + readDoubleError + '; ' + lastValueError);
                    return null;
                }
            }
        }

        if (value === null || value === undefined) {
            return null;
        }
        var numeric = Number(value);
        if (isNaN(numeric)) {
            print('Vacuum pressure read was non-numeric: ' + value);
            return null;
        }
        return numeric;
    }

    function vacuumIndicatesPartOn(vacuumLevel) {
        if (vacuumLevel === null) {
            return null;
        }
        return vacuumLevel >= 206.0 && vacuumLevel <= 226.5;
    }

    function pickWithVacuumCheck(scanDir, target, nozzle, vacuumActuator, moveX, moveY, travelZ, pickZ, targetIndex, statusFile, scanId, totalTargets) {
        var retryStepMm = 0.5;
        var maxAttempts = 3;
        var readableVacuum = true;

        setVacuum(vacuumActuator, true);
        for (var attempt = 0; attempt < maxAttempts; attempt++) {
            var attemptZ = pickZ - (retryStepMm * attempt);
            warnDualNozzleZClearance(attemptZ, 'pick descent attempt ' + (attempt + 1));
            print('Pick attempt ' + (attempt + 1) + ' for target ' + (targetIndex + 1)
                + ' at X=' + moveX.toFixed(3)
                + ' Y=' + moveY.toFixed(3)
                + ' Z=' + attemptZ.toFixed(3));
            moveNozzleToXyAtZ(nozzle, moveX, moveY, attemptZ);
            Packages.java.lang.Thread.sleep(1000);

            var vacuumLevel = readVacuumLevel(vacuumActuator);
            var partOn = vacuumIndicatesPartOn(vacuumLevel);
            if (partOn === null) {
                readableVacuum = false;
                print('Vacuum pressure unavailable; continuing without pressure-based retry.');
                writePickingPreview(scanDir, scanId, target, targetIndex, totalTargets, moveX, moveY, {
                    label: 'Picking Target ' + (targetIndex + 1) + ' | Vacuum unreadable',
                    vacuum_level: null,
                    vacuum_part_on: null,
                    vacuum_attempt: attempt + 1,
                    pick_z_mm: attemptZ
                });
                break;
            }

            print('Vacuum pressure after pick attempt ' + (attempt + 1)
                + ': ' + vacuumLevel.toFixed(3)
                + ' part-on=' + partOn);
            writePickingPreview(scanDir, scanId, target, targetIndex, totalTargets, moveX, moveY, {
                label: 'Picking Target ' + (targetIndex + 1)
                    + ' | Vacuum ' + vacuumLevel.toFixed(1)
                    + (partOn ? ' part on' : ' no part'),
                vacuum_level: vacuumLevel,
                vacuum_part_on: partOn,
                vacuum_attempt: attempt + 1,
                pick_z_mm: attemptZ
            });
            if (partOn) {
                return {
                    success: true,
                    z: attemptZ,
                    vacuumLevel: vacuumLevel,
                    attempts: attempt + 1
                };
            }

            if (attempt + 1 < maxAttempts) {
                writeStatus(
                    statusFile,
                    'picking',
                    scanId,
                    targetIndex + 1,
                    totalTargets,
                    'Vacuum did not confirm target ' + (targetIndex + 1)
                        + '; retrying 0.5mm lower'
                );
            }
        }

        return {
            success: !readableVacuum,
            z: pickZ - (retryStepMm * (readableVacuum ? maxAttempts - 1 : 0)),
            vacuumLevel: null,
            attempts: readableVacuum ? maxAttempts : 1
        };
    }

    function pickAssumingSuccess(scanDir, target, nozzle, vacuumActuator, moveX, moveY, pickZ, targetIndex, scanId, totalTargets) {
        warnDualNozzleZClearance(pickZ, 'net-tray pick descent');
        writePickingPreview(scanDir, scanId, target, targetIndex, totalTargets, moveX, moveY, {
            label: 'Picking Target ' + (targetIndex + 1) + ' | assumed pickup',
            pick_z_mm: pickZ
        });
        setVacuum(vacuumActuator, true);
        print('Assumed-success net-tray pick for target ' + (targetIndex + 1)
            + ' at X=' + moveX.toFixed(3)
            + ' Y=' + moveY.toFixed(3)
            + ' Z=' + pickZ.toFixed(3));
        twoStagePickDescent(nozzle, moveX, moveY, Number(nozzle.location.z), pickZ);
        Packages.java.lang.Thread.sleep(300);
        return {
            success: true,
            z: pickZ,
            vacuumLevel: null,
            attempts: 1
        };
    }

    function bottomInspectionHomeLocation() {
        var bottomCamera = findCameraByName('Bottom');
        var bottomLocation = bottomCamera.getLocation();
        var n2ToN1BottomCameraOffsetX = 45.905;
        var n2ToN1BottomCameraOffsetY = 0.994;
        return {
            x: bottomLocation.x + n2ToN1BottomCameraOffsetX,
            y: bottomLocation.y + n2ToN1BottomCameraOffsetY,
            offsetX: n2ToN1BottomCameraOffsetX,
            offsetY: n2ToN1BottomCameraOffsetY
        };
    }

    function parkPickerAtBottomInspectionHome(nozzle, travelZ) {
        var home = bottomInspectionHomeLocation();
        print('Parking N1 at bottom-camera inspection home XY, staying at travel height X=' + home.x.toFixed(3)
            + ' Y=' + home.y.toFixed(3)
            + ' travel Z=' + travelZ.toFixed(3));
        moveNozzleToXyAtZ(nozzle, nozzle.location.x, nozzle.location.y, travelZ);
        moveNozzleToXyAtZ(nozzle, home.x, home.y, travelZ);
    }

    function parkHeadAtMaxXy(topCamera, head) {
        var maxX = 433.0;
        var maxY = 487.0;
        print('Parking head out of the way at max X=' + maxX.toFixed(3)
            + ' Y=' + maxY.toFixed(3));
        parkNozzlesForScan(head);
        moveCameraToXy(topCamera, maxX, maxY);
        print('Top camera after max-XY park: ' + formatLocation(topCamera.getLocation()));
    }

    function inspectPickedTargetOnBottomCamera(scanDir, scanId, target, targetIndex, totalTargets, nozzle, travelZ, inspectionLabel, sampleCount) {
        var bottomCamera = findCameraByName('Bottom');
        var inspectionZ = -75.0;
        var inspectionHome = bottomInspectionHomeLocation();
        var inspectionX = inspectionHome.x;
        var inspectionY = inspectionHome.y;
        var inspectionDir = new File(scanDir, 'bottom_inspections');
        inspectionDir.mkdirs();

        var captureCount = Math.max(1, Number(sampleCount || 1));

        print('Moving N1 to Bottom camera for target ' + (targetIndex + 1)
            + ' at X=' + inspectionX.toFixed(3)
            + ' Y=' + inspectionY.toFixed(3)
            + ' (Bottom camera location plus N2->N1 offset dX='
            + inspectionHome.offsetX.toFixed(3)
            + ' dY=' + inspectionHome.offsetY.toFixed(3) + ')'
            + ' travel Z=' + travelZ.toFixed(3)
            + ' inspection Z=' + inspectionZ.toFixed(3));
        moveNozzleToXyAtZ(nozzle, inspectionX, inspectionY, travelZ);
        warnDualNozzleZClearance(inspectionZ, 'bottom-camera inspection descent');
        moveNozzleToXyAtZ(nozzle, inspectionX, inspectionY, inspectionZ);
        Packages.java.lang.Thread.sleep(500);

        var captures = [];
        for (var captureIndex = 0; captureIndex < captureCount; captureIndex++) {
            var imageBaseName = 'target_' + pad(targetIndex + 1, 3)
                + '_object_' + pad(target.objectIndex, 6)
                + '_' + timestamp()
                + (inspectionLabel ? '_' + String(inspectionLabel).replace(/[^A-Za-z0-9_-]+/g, '_') : '')
                + (captureCount > 1 ? '_sample_' + (captureIndex + 1) : '');
            var fullImageFile = new File(inspectionDir, imageBaseName + '_bottom_full.png');
            var cropImageFile = new File(inspectionDir, imageBaseName + '_bottom.png');
            var image = bottomCamera.settleAndCapture();
            ImageIO.write(image, 'PNG', fullImageFile);

            var cropFraction = 0.50;
            var cropWidth = Math.max(1, Math.round(image.getWidth() * cropFraction));
            var cropHeight = Math.max(1, Math.round(image.getHeight() * cropFraction));
            var cropX = Math.max(0, Math.round((image.getWidth() - cropWidth) / 2));
            var cropY = Math.max(0, Math.round((image.getHeight() - cropHeight) / 2));
            var cropImage = image.getSubimage(cropX, cropY, cropWidth, cropHeight);
            ImageIO.write(cropImage, 'PNG', cropImageFile);
            captures.push({
                fullImageFile: fullImageFile,
                cropImageFile: cropImageFile
            });

            print('Saved bottom-camera inspection sample ' + (captureIndex + 1)
                + ' of ' + captureCount + ': ' + cropImageFile.getAbsolutePath()
                + ' (full frame: ' + fullImageFile.getAbsolutePath() + ')');
            writeInspectionPreview(
                scanDir,
                scanId,
                target,
                targetIndex,
                totalTargets,
                cropImageFile,
                inspectionX,
                inspectionY,
                inspectionZ
            );
            if (captureIndex + 1 < captureCount) {
                Packages.java.lang.Thread.sleep(200);
            }
        }
        moveNozzleToXyAtZ(nozzle, inspectionX, inspectionY, travelZ);
        return {
            fullImageFile: captures[0].fullImageFile,
            cropImageFile: captures[0].cropImageFile,
            samples: captures
        };
    }

    function inspectNozzleWithConservativeQa(scanDir, scanId, target, targetIndex, totalTargets, nozzle, travelZ, label) {
        var samples = [];
        var bugPresent = false;
        var possibleMultiple = false;
        var strongest = null;
        var inspection = inspectPickedTargetOnBottomCamera(
            scanDir,
            scanId,
            target,
            targetIndex,
            totalTargets,
            nozzle,
            travelZ,
            label,
            2
        );
        for (var sampleIndex = 0; sampleIndex < inspection.samples.length; sampleIndex++) {
            var sample = inspection.samples[sampleIndex];
            var qa = runQaInspection(scanDir, sample.fullImageFile, 'nozzle', targetIndex);
            qa.fullImageFile = sample.fullImageFile;
            qa.cropImageFile = sample.cropImageFile;
            samples.push(qa);
            bugPresent = bugPresent || Boolean(qa.bug_present);
            possibleMultiple = possibleMultiple || Boolean(qa.possible_multiple);
            if (strongest === null
                    || Number(qa.total_area_px || 0) > Number(strongest.total_area_px || 0)) {
                strongest = qa;
            }
        }
        var combined = {};
        for (var key in strongest) {
            if (strongest.hasOwnProperty(key)) {
                combined[key] = strongest[key];
            }
        }
        combined.bug_present = bugPresent;
        combined.possible_multiple = possibleMultiple;
        combined.samples = samples;
        combined.sample_count = samples.length;
        print('Conservative bottom-camera QA ' + label
            + ': specimen present if either frame is positive; samples='
            + samples.map(function(sample) { return String(Boolean(sample.bug_present)); }).join(',')
            + ' combined=' + bugPresent);
        return combined;
    }

    function hiResImageFileForTarget(scanDir, target) {
        if (scanDir === null || scanDir === undefined || target === null || target === undefined) {
            return null;
        }
        if (target.hiResImageFile && String(target.hiResImageFile).length > 0) {
            var recorded = new File(String(target.hiResImageFile));
            if (recorded.exists()) {
                return recorded;
            }
        }
        var hiResDir = new File(scanDir, 'hires');
        if (!hiResDir.exists()) {
            return null;
        }
        var objectText = pad(target.objectIndex, 6);
        var files = hiResDir.listFiles();
        if (files === null) {
            return null;
        }
        for (var i = 0; i < files.length; i++) {
            if (String(files[i].getName()).indexOf('_object_' + objectText + '_') >= 0
                    && String(files[i].getName()).indexOf('_hires.png') >= 0) {
                return files[i];
            }
        }
        return null;
    }

    function imageSharpnessScore(image, focusMode) {
        var width = image.getWidth();
        var height = image.getHeight();
        if (width < 3 || height < 3) {
            return 0.0;
        }
        var sum = 0.0;
        var sumSquares = 0.0;
        var count = 0;
        var specimenMode = String(focusMode || '') === 'specimen';
        var stepX = specimenMode
            ? Math.max(8, Math.floor(width / 160))
            : Math.max(1, Math.floor(width / 640));
        var stepY = specimenMode
            ? Math.max(8, Math.floor(height / 120))
            : Math.max(1, Math.floor(height / 480));
        var centerCropFraction = specimenMode ? 0.62 : 1.0;
        var xStart = Math.max(stepX, Math.floor((width * (1.0 - centerCropFraction)) / 2.0));
        var xStop = Math.min(width - stepX, Math.ceil(width - xStart));
        var yStart = Math.max(stepY, Math.floor((height * (1.0 - centerCropFraction)) / 2.0));
        var yStop = Math.min(height - stepY, Math.ceil(height - yStart));
        var medianStepX = specimenMode ? Math.max(20, Math.floor(width / 40)) : Math.max(1, Math.floor(width / 80));
        var medianStepY = specimenMode ? Math.max(20, Math.floor(height / 30)) : Math.max(1, Math.floor(height / 60));
        var backgroundSum = 0.0;
        var backgroundCount = 0;

        function grayAt(x, y) {
            var rgb = image.getRGB(x, y);
            var red = (rgb >> 16) & 0xff;
            var green = (rgb >> 8) & 0xff;
            var blue = rgb & 0xff;
            return (0.299 * red) + (0.587 * green) + (0.114 * blue);
        }

        function saturationAt(x, y) {
            var rgb = image.getRGB(x, y);
            var red = (rgb >> 16) & 0xff;
            var green = (rgb >> 8) & 0xff;
            var blue = rgb & 0xff;
            var maxValue = Math.max(red, Math.max(green, blue));
            var minValue = Math.min(red, Math.min(green, blue));
            return maxValue - minValue;
        }

        for (var medianY = yStart; medianY < yStop; medianY += medianStepY) {
            for (var medianX = xStart; medianX < xStop; medianX += medianStepX) {
                backgroundSum += grayAt(medianX, medianY);
                backgroundCount++;
            }
        }
        var localBackground = backgroundCount > 0 ? backgroundSum / backgroundCount : 180.0;

        for (var y = yStart; y < yStop; y += stepY) {
            for (var x = xStart; x < xStop; x += stepX) {
                var gray = grayAt(x, y);
                if (specimenMode
                        && !(gray < localBackground - 20.0
                            || gray < 115.0
                            || (saturationAt(x, y) > 28.0 && gray < 190.0))) {
                    continue;
                }
                var laplacian = (4.0 * grayAt(x, y))
                    - grayAt(x - stepX, y)
                    - grayAt(x + stepX, y)
                    - grayAt(x, y - stepY)
                    - grayAt(x, y + stepY);
                sum += laplacian;
                sumSquares += laplacian * laplacian;
                count++;
            }
        }
        if (specimenMode && count < 20) {
            return imageSharpnessScore(image, 'center');
        }
        if (count === 0) {
            return 0.0;
        }
        var mean = sum / count;
        return (sumSquares / count) - (mean * mean);
    }

    function imageExposureStats(image, focusMode) {
        var width = image.getWidth();
        var height = image.getHeight();
        var specimenMode = String(focusMode || '') === 'specimen';
        var cropFraction = specimenMode ? 0.62 : 1.0;
        var xStart = Math.max(0, Math.floor((width * (1.0 - cropFraction)) / 2.0));
        var xStop = Math.min(width, Math.ceil(width - xStart));
        var yStart = Math.max(0, Math.floor((height * (1.0 - cropFraction)) / 2.0));
        var yStop = Math.min(height, Math.ceil(height - yStart));
        var stepX = Math.max(8, Math.floor(width / 120));
        var stepY = Math.max(8, Math.floor(height / 90));
        var sum = 0.0;
        var count = 0;
        var whiteCount = 0;
        var darkCount = 0;

        for (var y = yStart; y < yStop; y += stepY) {
            for (var x = xStart; x < xStop; x += stepX) {
                var rgb = image.getRGB(x, y);
                var red = (rgb >> 16) & 0xff;
                var green = (rgb >> 8) & 0xff;
                var blue = rgb & 0xff;
                var gray = (0.299 * red) + (0.587 * green) + (0.114 * blue);
                sum += gray;
                count++;
                if (gray >= 245.0) {
                    whiteCount++;
                }
                if (gray <= 120.0) {
                    darkCount++;
                }
            }
        }
        if (count === 0) {
            return {
                mean: 255.0,
                whiteFraction: 1.0,
                darkFraction: 0.0,
                overexposed: true
            };
        }
        var mean = sum / count;
        var whiteFraction = whiteCount / count;
        var darkFraction = darkCount / count;
        return {
            mean: mean,
            whiteFraction: whiteFraction,
            darkFraction: darkFraction,
            overexposed: whiteFraction >= 0.55 || (mean >= 242.0 && darkFraction < 0.01)
        };
    }

    function focusSweepPositions(centerZ, stepMm) {
        var center = Math.max(hiResMinimumZ, Number(centerZ));
        var step = isNaN(Number(stepMm)) ? hiResFocusFastStepMm : Math.abs(Number(stepMm));
        return [
            Math.max(hiResMinimumZ, center - step),
            center,
            Math.max(hiResMinimumZ, center + step)
        ];
    }

    function isCameraFailureImage(image) {
        if (image === null || image === undefined) {
            return true;
        }
        var width = image.getWidth();
        var height = image.getHeight();
        var stepX = Math.max(1, Math.floor(width / 80));
        var stepY = Math.max(1, Math.floor(height / 60));
        var sampled = 0;
        var red = 0;
        var gray = 0;
        for (var y = 0; y < height; y += stepY) {
            for (var x = 0; x < width; x += stepX) {
                var rgb = Number(image.getRGB(x, y));
                var r = (rgb >> 16) & 255;
                var g = (rgb >> 8) & 255;
                var b = rgb & 255;
                sampled++;
                if (r >= 220 && g <= 40 && b <= 40) {
                    red++;
                }
                if (Math.abs(r - g) <= 2 && Math.abs(g - b) <= 2 && r >= 45 && r <= 80) {
                    gray++;
                }
            }
        }
        return red >= 5 && gray >= Math.floor(sampled * 0.70);
    }

    function captureHiResWithRecovery(camera) {
        var image = camera.settleAndCapture();
        if (isCameraFailureImage(image)) {
            throw new Error('HiRes camera returned the red-X failure image. '
                + 'Stopping before the specimen is picked. Restart OpenPnP after restoring the Teslong USB connection; '
                + 'this OpenPnP capture backend cannot safely reopen a disconnected camera in-process.');
        }
        return image;
    }

    function captureBestHiResImage(scanDir, scanId, target, targetIndex, totalTargets, hiResCamera, hiResMotionNozzle, x, y, focusCenterZ, travelZ, statusFile, label, outputDir, outputName, focusMode, focusStepMm) {
        var hiResDir = outputDir || new File(scanDir, 'hires');
        hiResDir.mkdirs();
        var bestImage = null;
        var safeFocusCenterZ = Math.max(hiResMinimumZ, Number(focusCenterZ));
        var bestZ = safeFocusCenterZ;
        var bestScore = -1.0;
        var fallbackImage = null;
        var fallbackZ = safeFocusCenterZ;
        var fallbackScore = -1.0;
        var fallbackWhiteFraction = 1.0;
        var focusStep = isNaN(Number(focusStepMm)) ? hiResFocusFastStepMm : Math.abs(Number(focusStepMm));
        var focusPositions = focusSweepPositions(safeFocusCenterZ, focusStep);
        var scoreMode = focusMode || 'whole_frame';

        print('HiRes autofocus for target ' + (targetIndex + 1)
            + ' at X=' + x.toFixed(3)
            + ' Y=' + y.toFixed(3)
            + ' focus center Z=' + safeFocusCenterZ.toFixed(3)
            + ' focus step=' + focusStep.toFixed(3)
            + ' minimum allowed Z=' + hiResMinimumZ.toFixed(3)
            + ' focus score mode=' + scoreMode
            + ' using camera ' + hiResCamera.getName());
        moveNozzleToXyAtZ(hiResMotionNozzle, hiResMotionNozzle.location.x, hiResMotionNozzle.location.y, travelZ);
        moveNozzleToXyAtZ(hiResMotionNozzle, x, y, travelZ);

        setHiResLight(true);
        try {
            for (var i = 0; i < focusPositions.length; i++) {
                var z = Number(focusPositions[i]);
                moveNozzleToXyAtZ(hiResMotionNozzle, x, y, z);
                Packages.java.lang.Thread.sleep(80);
                var image = captureHiResWithRecovery(hiResCamera);
                var exposure = imageExposureStats(image, scoreMode);
                var score = imageSharpnessScore(image, scoreMode);
                var rejectForExposure = String(scoreMode) === 'specimen' && exposure.overexposed;
                if (String(scoreMode) === 'specimen') {
                    print('HiRes autofocus candidate target ' + (targetIndex + 1)
                        + ' Z=' + z.toFixed(3)
                        + ' sharpness=' + score.toFixed(3)
                        + ' mean=' + Number(exposure.mean).toFixed(1)
                        + ' white_fraction=' + Number(exposure.whiteFraction).toFixed(3)
                        + (rejectForExposure ? ' OVEREXPOSED' : ''));
                }
                if (fallbackImage === null
                        || exposure.whiteFraction < fallbackWhiteFraction
                        || (Math.abs(exposure.whiteFraction - fallbackWhiteFraction) < 0.02
                            && score > fallbackScore)) {
                    fallbackScore = score;
                    fallbackZ = z;
                    fallbackImage = image;
                    fallbackWhiteFraction = exposure.whiteFraction;
                }
                if (!rejectForExposure && score > bestScore) {
                    bestScore = score;
                    bestZ = z;
                    bestImage = image;
                }
            }

            if (bestImage === null && fallbackImage !== null) {
                bestImage = fallbackImage;
                bestZ = fallbackZ;
                bestScore = fallbackScore;
                print('All HiRes autofocus candidates were overexposed for target ' + (targetIndex + 1)
                    + '; using least-bad candidate at Z=' + bestZ.toFixed(3)
                    + ' white_fraction=' + Number(fallbackWhiteFraction).toFixed(3));
            }

            if (String(scoreMode) !== 'specimen') {
                moveNozzleToXyAtZ(hiResMotionNozzle, x, y, bestZ);
                Packages.java.lang.Thread.sleep(80);
                bestImage = captureHiResWithRecovery(hiResCamera);
            }
        }
        finally {
            setHiResLight(false);
        }
        var imageName = outputName || ('target_' + pad(targetIndex + 1, 3)
            + '_object_' + pad(target.objectIndex, 6)
            + '_' + timestamp()
            + '_hires.png');
        var imageFile = new File(hiResDir, imageName);
        ImageIO.write(bestImage, 'PNG', imageFile);
        if (outputDir === null || outputDir === undefined) {
            target.hiResImageFile = imageFile.getAbsolutePath();
            target.hiResFocusZ = bestZ;
            target.hiResSharpnessScore = bestScore;
        }
        writeHiResPreview(
            scanDir,
            target,
            targetIndex,
            totalTargets,
            imageFile,
            label + ' HiRes Z ' + bestZ.toFixed(3),
            x,
            y,
            bestZ,
            bestScore
        );
        writeStatus(
            statusFile,
            'hires',
            scanId,
            targetIndex + 1,
            totalTargets,
            label + ' HiRes image saved at Z ' + bestZ.toFixed(3)
        );
        print('Saved HiRes image for target ' + (targetIndex + 1)
            + ': ' + imageFile.getAbsolutePath()
            + ' best Z=' + bestZ.toFixed(3)
            + ' sharpness=' + bestScore.toFixed(3));
        moveNozzleToXyAtZ(hiResMotionNozzle, x, y, travelZ);
        return imageFile;
    }

    function runQaInspection(scanDir, imageFile, mode, targetIndex) {
        var qaScript = new File(scriptsDir, '03_QA_Inspect_Image.py').getAbsolutePath();
        var qaDir = new File(scanDir, 'qa');
        qaDir.mkdirs();
        var resultFile = new File(qaDir, mode + '_target_' + pad(targetIndex + 1, 3)
            + '_' + timestamp() + '.json');
        var stdoutLog = new File(qaDir, 'qa_' + mode + '.out.log');
        var stderrLog = new File(qaDir, 'qa_' + mode + '.err.log');

        var builder = new Packages.java.lang.ProcessBuilder(
            python,
            qaScript,
            imageFile.getAbsolutePath(),
            '--mode',
            mode,
            '--out',
            resultFile.getAbsolutePath()
        );
        builder.environment().put('OMP_NUM_THREADS', '1');
        builder.environment().put('MKL_NUM_THREADS', '1');
        builder.environment().put('OPENBLAS_NUM_THREADS', '1');
        builder.directory(projectDir);
        builder.redirectOutput(stdoutLog);
        builder.redirectError(stderrLog);
        var process = builder.start();
        var exitCode = process.waitFor();
        if (exitCode !== 0 || !resultFile.exists()) {
            throw new Error('QA inspection failed for ' + imageFile.getAbsolutePath()
                + ' mode=' + mode
                + ' exit=' + exitCode
                + ' stderr=' + stderrLog.getAbsolutePath());
        }
        return JSON.parse(readText(resultFile));
    }

    function moveCameraToXy(camera, x, y) {
        var currentCameraLocation = camera.getLocation();
        var location = currentCameraLocation.add(new Location(
            LengthUnit.Millimeters,
            x - currentCameraLocation.x,
            y - currentCameraLocation.y,
            0,
            0
        ));
        camera.moveTo(location);
    }

    function inspectPlacedWell(scanDir, scanId, target, targetIndex, totalTargets, statusFile, hiResCamera, topCamera, hiResMotionNozzle, well, touchCorrection, focusZ, travelZ) {
        var qaDir = new File(scanDir, 'qa/wells');
        qaDir.mkdirs();
        var cameraX = Number(well.qaCameraX);
        var cameraY = Number(well.qaCameraY);
        var topQaDir = new File(scanDir, 'qa/wells_top');
        topQaDir.mkdirs();
        var topImageName = 'well_' + well.name
            + '_target_' + pad(targetIndex + 1, 3)
            + '_' + timestamp()
            + '_top.png';
        var topImageFile = new File(topQaDir, topImageName);
        var topCameraX = Number(well.topCameraX);
        var topCameraY = Number(well.topCameraY);
        writeStatus(
            statusFile,
            'qa',
            scanId,
            targetIndex + 1,
            totalTargets,
            'Capturing whole-well Lumen image for ' + well.name
        );
        moveNozzleToXyAtZ(
            hiResMotionNozzle,
            hiResMotionNozzle.location.x,
            hiResMotionNozzle.location.y,
            travelZ
        );
        print('Lumen whole-well QA: centering Top camera over well ' + well.name
            + ' using calibrated plate-camera coordinates X=' + topCameraX.toFixed(3)
            + ' Y=' + topCameraY.toFixed(3));
        moveCameraToXy(topCamera, topCameraX, topCameraY);
        Packages.java.lang.Thread.sleep(250);
        var topImage = topCamera.settleAndCapture();
        ImageIO.write(topImage, 'PNG', topImageFile);
        var result = runQaInspection(scanDir, topImageFile, 'well_top', targetIndex);
        result.hires_image = '';
        result.top_image = topImageFile.getAbsolutePath();
        print('Lumen whole-well QA for ' + well.name
            + ': empty=' + result.well_empty
            + ' bug_present=' + result.bug_present
            + ' largest_area=' + Number(result.largest_area_px).toFixed(1)
            + ' dark_fraction=' + Number(result.dark_fraction).toFixed(5));
        writeQaPreview(
            scanDir,
            scanId,
            target,
            targetIndex,
            totalTargets,
            topImageFile,
            'Lumen Well QA ' + well.name + (result.well_empty ? ' | empty' : ' | occupied'),
            topCameraX,
            topCameraY,
            travelZ,
            result
        );
        if (!Boolean(result.well_empty)) {
            var imageName = 'well_' + well.name
                + '_target_' + pad(targetIndex + 1, 3)
                + '_' + timestamp()
                + '_hires.png';
            writeStatus(
                statusFile,
                'qa',
                scanId,
                targetIndex + 1,
                totalTargets,
                'Well ' + well.name + ' is occupied; capturing HiRes taxonomy image'
            );
            print('POST-DROP QA: Lumen detected a specimen; moving HiRes camera to well '
                + well.name + ' at camera X=' + cameraX.toFixed(3)
                + ' Y=' + cameraY.toFixed(3)
                + '; BugPicker XY correction source=' + touchCorrection.source);
            moveNozzleToXyAtZ(hiResMotionNozzle, cameraX, cameraY, travelZ);
            var capturedImageFile = captureBestHiResImage(
                scanDir,
                scanId,
                target,
                targetIndex,
                totalTargets,
                hiResCamera,
                hiResMotionNozzle,
                cameraX,
                cameraY,
                focusZ,
                travelZ,
                statusFile,
                'Well QA ' + well.name,
                qaDir,
                imageName,
                'specimen',
                hiResFocusFastStepMm * 2.0
            );
            result.hires_image = capturedImageFile.getAbsolutePath();
            print('POST-DROP QA: saved HiRes taxonomy image: ' + result.hires_image);
        }
        else {
            print('POST-DROP QA: Lumen found well ' + well.name
                + ' empty; skipping HiRes taxonomy imaging.');
        }
        Packages.java.lang.Thread.sleep(result.well_empty ? 250 : 1500);
        moveNozzleToXyAtZ(hiResMotionNozzle, hiResMotionNozzle.location.x, hiResMotionNozzle.location.y, travelZ);
        return result;
    }

    function inspectNozzleAfterEmptyWell(scanDir, scanId, target, targetIndex, totalTargets, nozzle, travelZ) {
        var inspection = inspectPickedTargetOnBottomCamera(
            scanDir,
            scanId,
            target,
            targetIndex,
            totalTargets,
            nozzle,
            travelZ
        );
        var result = runQaInspection(scanDir, inspection.fullImageFile, 'nozzle', targetIndex);
        print('Nozzle QA after empty well for target ' + (targetIndex + 1)
            + ': bug_present=' + result.bug_present
            + ' largest_area=' + Number(result.largest_area_px).toFixed(1)
            + ' dark_fraction=' + Number(result.dark_fraction).toFixed(5));
        writeQaPreview(
            scanDir,
            scanId,
            target,
            targetIndex,
            totalTargets,
            inspection.cropImageFile,
            'Nozzle QA Target ' + (targetIndex + 1) + (result.bug_present ? ' | stuck bug' : ' | clear'),
            0,
            0,
            -75.0,
            result
        );
        return result;
    }

    function brushCleanNozzle(nozzle, travelZ) {
        var brushAX = 196.0;
        var brushAY = 82.0;
        var brushBX = 209.0;
        var brushBY = 86.0;
        var brushZ = -16.0;

        print('Brush-cleaning N1 between X=' + brushAX.toFixed(3)
            + ' Y=' + brushAY.toFixed(3)
            + ' Z=' + brushZ.toFixed(3)
            + ' and X=' + brushBX.toFixed(3)
            + ' Y=' + brushBY.toFixed(3)
            + ' Z=' + brushZ.toFixed(3));
        moveNozzleToXyAtZ(nozzle, brushAX, brushAY, travelZ);
        warnDualNozzleZClearance(brushZ, 'brush clean');
        moveNozzleToXyAtZ(nozzle, brushAX, brushAY, brushZ);
        for (var pass = 0; pass < 2; pass++) {
            moveNozzleToXyAtZ(nozzle, brushBX, brushBY, brushZ);
            moveNozzleToXyAtZ(nozzle, brushAX, brushAY, brushZ);
        }
        moveNozzleToXyAtZ(nozzle, brushAX, brushAY, travelZ);
    }

    function releasePartIntoWell(vacuumActuator) {
        setVacuum(vacuumActuator, false);
        print('Vacuum off at well; holding 1.5s release dwell. VAC1 is configured as a Boolean actuator, so no reverse command was sent.');
        Packages.java.lang.Thread.sleep(1500);
    }

    function recoveryPlateMoveToWell(nozzle, travelZ, recoveryWell, wipeZ, context) {
        print('Moving N1 to recovery plate well ' + recoveryWell.name
            + ' for ' + context
            + ' at X=' + recoveryWell.x.toFixed(3)
            + ' Y=' + recoveryWell.y.toFixed(3)
            + ' travel Z=' + travelZ.toFixed(3)
            + ' wipe Z=' + wipeZ.toFixed(3));
        moveNozzleToXyAtZ(nozzle, recoveryWell.x, recoveryWell.y, travelZ);
        warnDualNozzleZClearance(wipeZ, 'recovery plate descent');
        moveNozzleToXyAtZ(nozzle, recoveryWell.x, recoveryWell.y, wipeZ);
    }

    function recoveryPlateWipeRotation(nozzle, recoveryWell, wipeZ) {
        var startRotation = nozzle.location.rotation;
        var negativeRotation = startRotation - 90.0;
        var positiveRotation = startRotation + 90.0;
        print('Recovery wipe rotation from R=' + startRotation.toFixed(3)
            + ' to R=' + negativeRotation.toFixed(3)
            + ', then R=' + positiveRotation.toFixed(3)
            + ' (-90/+90 wipe)');
        moveNozzleToXyAtZAndRotation(nozzle, recoveryWell.x, recoveryWell.y, wipeZ, negativeRotation);
        Packages.java.lang.Thread.sleep(250);
        moveNozzleToXyAtZAndRotation(nozzle, recoveryWell.x, recoveryWell.y, wipeZ, positiveRotation);
        Packages.java.lang.Thread.sleep(250);
    }

    function recoveryPlateWipeOnly(nozzle, vacuumActuator, travelZ, recoveryWellIndex, targetIndex, totalTargets, statusFile, scanId, plateContext, wipeZ) {
        var recoveryWell = recoveryWellLocationForIndex(recoveryWellIndex, plateContext);
        var activeWipeZ = wipeZ === undefined || wipeZ === null ? -42.0 : Number(wipeZ);
        writeStatus(
            statusFile,
            'qa',
            scanId,
            targetIndex + 1,
            totalTargets,
            'Wiping nozzle on recovery plate well ' + recoveryWell.name
        );
        print('Moving N1 to recovery plate well ' + recoveryWell.name
            + ' for post-plate cleaning wipe'
            + ' mapped from plate well index ' + recoveryWellIndex
            + ' at X=' + recoveryWell.x.toFixed(3)
            + ' Y=' + recoveryWell.y.toFixed(3)
            + ' travel Z=' + travelZ.toFixed(3)
            + ' wipe Z=' + activeWipeZ.toFixed(3));
        moveNozzleToXyAtZ(nozzle, recoveryWell.x, recoveryWell.y, travelZ);
        print('Turning vacuum off before recovery wipe descent so stuck specimens can fall onto the kim wipe.');
        setVacuum(vacuumActuator, false);
        warnDualNozzleZClearance(activeWipeZ, 'recovery plate descent');
        moveNozzleToXyAtZ(nozzle, recoveryWell.x, recoveryWell.y, activeWipeZ);
        recoveryPlateWipeRotation(nozzle, recoveryWell, activeWipeZ);
        moveNozzleToXyAtZ(nozzle, recoveryWell.x, recoveryWell.y, travelZ);
    }

    function cleanAndVerifyNozzle(scanDir, scanId, target, targetIndex, totalTargets, nozzle, vacuumActuator, travelZ, recoveryWellIndex, statusFile, plateContext) {
        var recoveryWell = recoveryWellLocationForIndex(recoveryWellIndex, plateContext);
        var wipeDepths = [-42.0, -42.5, -43.0];
        var lastQa = null;
        var cleanupLog = new File(scanDir, 'qa/nozzle_cleanup.jsonl');
        for (var attempt = 0; attempt < wipeDepths.length; attempt++) {
            writeStatus(
                statusFile,
                'qa',
                scanId,
                targetIndex + 1,
                totalTargets,
                'Cleaning nozzle attempt ' + (attempt + 1) + ' of ' + wipeDepths.length
                    + ' at recovery well ' + recoveryWell.name
            );
            recoveryPlateWipeOnly(
                nozzle,
                vacuumActuator,
                travelZ,
                recoveryWellIndex,
                targetIndex,
                totalTargets,
                statusFile,
                scanId,
                plateContext,
                wipeDepths[attempt]
            );
            lastQa = inspectNozzleWithConservativeQa(
                scanDir,
                scanId,
                target,
                targetIndex,
                totalTargets,
                nozzle,
                travelZ,
                'post_clean_attempt_' + (attempt + 1)
            );
            print('Post-clean nozzle QA attempt ' + (attempt + 1)
                + ': bug_present=' + lastQa.bug_present
                + ' wipe_z=' + wipeDepths[attempt].toFixed(3));
            if (!lastQa.bug_present) {
                appendText(cleanupLog, JSON.stringify({
                    scan_id: scanId,
                    target_number: targetIndex + 1,
                    recovery_well: recoveryWell.name,
                    automatic_attempts: attempt + 1,
                    final_wipe_z_mm: wipeDepths[attempt],
                    manual_intervention: false,
                    clean_confirmed: true,
                    recorded_at: new Date().toISOString()
                }) + '\n');
                return {
                    clean: true,
                    automatic_attempts: attempt + 1,
                    manual_intervention: false,
                    qa: lastQa
                };
            }
        }

        var manualChecks = 0;
        while (lastQa !== null && lastQa.bug_present) {
            manualChecks++;
            setVacuum(vacuumActuator, false);
            moveNozzleToXyAtZ(nozzle, recoveryWell.x, recoveryWell.y, travelZ);
            writeStatus(
                statusFile,
                'paused',
                scanId,
                targetIndex + 1,
                totalTargets,
                'Manual nozzle cleaning required above recovery well ' + recoveryWell.name
            );
            var choice = JOptionPane.showOptionDialog(
                null,
                'The bottom camera still detects a specimen after three cleaning attempts.'
                    + '\n\nN1 is parked above recovery well ' + recoveryWell.name + '.'
                    + '\nInspect and clean the nozzle manually, then choose Reinspect.'
                    + '\nIf the nozzle is visibly empty, you may confirm the ML result is a false positive.'
                    + '\nDo not continue with a specimen attached to the nozzle.',
                'Manual Nozzle Cleaning Required',
                JOptionPane.DEFAULT_OPTION,
                JOptionPane.WARNING_MESSAGE,
                null,
                Java.to(
                    ['Reinspect after cleaning', 'Confirm nozzle empty and continue', 'Stop run'],
                    'java.lang.Object[]'
                ),
                'Reinspect after cleaning'
            );
            if (choice === 1) {
                var manualLabelFile = new File(
                    new File(new File(scriptsDir, 'Data'), 'qa_feedback'),
                    'nozzle_qa_labels.jsonl'
                );
                var reviewedSamples = lastQa.samples || [];
                for (var reviewedIndex = 0; reviewedIndex < reviewedSamples.length; reviewedIndex++) {
                    var reviewedSample = reviewedSamples[reviewedIndex];
                    appendText(manualLabelFile, JSON.stringify({
                        qa_mode: 'nozzle',
                        image_path: String(reviewedSample.fullImageFile || reviewedSample.image || ''),
                        user_label: 'empty_nozzle',
                        suggested_label: 'specimen_present',
                        model_prediction: 'specimen_present',
                        model_confidence: reviewedSample.model_probabilities
                            ? Number(reviewedSample.model_probabilities.specimen_present || 0)
                            : null,
                        scan_id: scanId,
                        target_number: targetIndex + 1,
                        review_source: 'manual_nozzle_empty_override',
                        reviewed_at: new Date().toISOString()
                    }) + '\n');
                }
                lastQa.bug_present = false;
                print('User visually confirmed the nozzle empty after ML false-positive cleanup checks.');
                break;
            }
            if (choice !== 0) {
                throw new Error('Run stopped because nozzle cleaning could not be confirmed.');
            }
            lastQa = inspectNozzleWithConservativeQa(
                scanDir,
                scanId,
                target,
                targetIndex,
                totalTargets,
                nozzle,
                travelZ,
                'manual_clean_check_' + manualChecks
            );
        }
        appendText(cleanupLog, JSON.stringify({
            scan_id: scanId,
            target_number: targetIndex + 1,
            recovery_well: recoveryWell.name,
            automatic_attempts: wipeDepths.length,
            final_wipe_z_mm: wipeDepths[wipeDepths.length - 1],
            manual_intervention: true,
            manual_checks: manualChecks,
            clean_confirmed: true,
            recorded_at: new Date().toISOString()
        }) + '\n');
        return {
            clean: true,
            automatic_attempts: wipeDepths.length,
            manual_intervention: true,
            manual_checks: manualChecks,
            qa: lastQa
        };
    }

    function n2ZWhenN1Z(n1Z) {
        return 11.2 - n1Z;
    }

    function warnDualNozzleZClearance(n1Z, context) {
        var predictedN2Z = n2ZWhenN1Z(n1Z);
        print('Dual-nozzle Z check before ' + context
            + ': commanded N1 Z=' + n1Z.toFixed(3)
            + ' predicts N2 Z=' + predictedN2Z.toFixed(3));
        if (predictedN2Z < 20.0) {
            print('Warning: predicted N2 Z is near the work surface. '
                + 'Continuing because N1 was manually verified as the intended pick nozzle.');
        }
    }

    function nozzleLocationAt(nozzle, x, y, z) {
        return new Location(
            LengthUnit.Millimeters,
            x,
            y,
            z,
            nozzle.location.rotation
        );
    }

    function nozzleLocationAtRotation(nozzle, x, y, z, rotation) {
        return new Location(
            LengthUnit.Millimeters,
            x,
            y,
            z,
            rotation
        );
    }

    function moveNozzleToXyAtZ(nozzle, x, y, z) {
        nozzle.moveTo(nozzleLocationAt(nozzle, x, y, z));
    }

    function moveNozzleToXyAtZWithSpeed(nozzle, x, y, z, speed) {
        var location = nozzleLocationAt(nozzle, x, y, z);
        try {
            nozzle.moveTo(location, Number(speed));
        }
        catch (speedError) {
            print('Speed-limited nozzle move was not accepted by OpenPnP; using default speed: ' + speedError);
            nozzle.moveTo(location);
        }
    }

    function twoStagePickDescent(nozzle, x, y, startZ, pickZ) {
        var slowFraction = 0.10;
        var slowSpeed = 0.25;
        var zTravel = pickZ - startZ;
        var slowStartZ = startZ + (zTravel * (1.0 - slowFraction));
        print('Two-stage pick descent: fast to Z=' + slowStartZ.toFixed(3)
            + ', then final ' + Math.abs(pickZ - slowStartZ).toFixed(3)
            + 'mm at ' + Math.round(slowSpeed * 100) + '% speed to Z=' + pickZ.toFixed(3));
        moveNozzleToXyAtZ(nozzle, x, y, slowStartZ);
        moveNozzleToXyAtZWithSpeed(nozzle, x, y, pickZ, slowSpeed);
    }

    function moveNozzleToXyAtZAndRotation(nozzle, x, y, z, rotation) {
        nozzle.moveTo(nozzleLocationAtRotation(nozzle, x, y, z, rotation));
    }

    function debugPickTarget(scanDir, target, nozzle, travelZ, dryRun, touchCorrection, moveX, moveY) {
        print('Pick coordinate debug for object ' + target.objectIndex + ':'
            + ' scan=' + scanDir.getName()
            + ' raw pick X=' + target.x.toFixed(3)
            + ' Y=' + target.y.toFixed(3)
            + ' corrected pick X=' + moveX.toFixed(3)
            + ' Y=' + moveY.toFixed(3)
            + ' correction X=' + touchCorrection.x.toFixed(3)
            + ' Y=' + touchCorrection.y.toFixed(3)
            + ' frame X=' + target.frameX.toFixed(3)
            + ' Y=' + target.frameY.toFixed(3)
            + ' requested-frame estimate X=' + target.requestedEstimateX.toFixed(3)
            + ' Y=' + target.requestedEstimateY.toFixed(3)
            + ' current nozzle=' + formatLocation(nozzle.location)
            + ' dry_run=' + dryRun);
        if (dryRun) {
            print('Dry run active: moving above first pick target only. Create/remove control/pick_dry_run.flag to toggle.');
            moveNozzleToXyAtZ(nozzle, moveX, moveY, travelZ);
            print('Dry run finished above target. No Z descent, no vacuum, no drop move.');
        }
    }

    function waitForSegmentation(scanDir, timeoutMs, stopFile, statusFile, scanId, frameIndex, totalFrames, process, controlDir) {
        var completeFile = new File(scanDir, 'segmentation_complete.json');
        var stderrLog = new File(controlDir, 'segmentation.err.log');
        var start = new Date().getTime();
        if (process === null) {
            print('Segmentation process was not started.');
            print('See segmentation error log: ' + stderrLog.getAbsolutePath());
            writeStatus(statusFile, 'failed', scanId, frameIndex, totalFrames, 'Segmentation did not start; see control/segmentation.err.log');
            return false;
        }
        while (!completeFile.exists()) {
            if (haltRequested(stopFile, statusFile, scanId, frameIndex, totalFrames)) {
                try {
                    process.destroy();
                }
                catch (destroyError) {
                    print('Could not stop segmentation process after halt: ' + destroyError);
                }
                return false;
            }
            try {
                if (!process.isAlive()) {
                    print('Segmentation process exited before completion with code ' + process.exitValue() + '.');
                    print('See segmentation error log: ' + stderrLog.getAbsolutePath());
                    writeStatus(statusFile, 'failed', scanId, frameIndex, totalFrames, 'Segmentation exited before completion; see control/segmentation.err.log');
                    return false;
                }
            }
            catch (processError) {
                print('Could not inspect segmentation process state: ' + processError);
            }
            if ((new Date().getTime() - start) > timeoutMs) {
                print('Timed out waiting for segmentation: ' + completeFile.getAbsolutePath());
                print('See segmentation error log: ' + stderrLog.getAbsolutePath());
                writeStatus(statusFile, 'failed', scanId, frameIndex, totalFrames, 'Timed out waiting for target segmentation');
                return false;
            }
            Packages.java.lang.Thread.sleep(500);
        }
        return true;
    }

    function waitForTargetCount(scanDir, minimumTargets, timeoutMs) {
        var start = new Date().getTime();
        while ((new Date().getTime() - start) <= timeoutMs) {
            if (readPickTargets(scanDir, true).length >= minimumTargets) {
                return true;
            }
            Packages.java.lang.Thread.sleep(250);
        }
        return false;
    }

    function pickCoordinatesFromRecord(record, decision) {
        var sortingTrayPickXCorrectionMm = 23.5;
        var sortingTrayPickYCorrectionMm = 0.5;
        function correctedRequestedYToPickY() {
            var correctedRequestedY = Number(decision.corrected_requested_frame_estimated_y_mm);
            if (record.pick_y_mm !== undefined && record.requested_frame_estimated_y_mm !== undefined) {
                return correctedRequestedY
                    + (Number(record.pick_y_mm) - Number(record.requested_frame_estimated_y_mm));
            }
            if (record.estimated_y_mm !== undefined && record.requested_frame_estimated_y_mm !== undefined) {
                return correctedRequestedY
                    + (Number(record.estimated_y_mm) - Number(record.requested_frame_estimated_y_mm));
            }
            return correctedRequestedY;
        }
        var pickXSource = 'estimated_x_mm';
        var pickX = decision && decision.corrected_requested_frame_estimated_x_mm !== undefined
            && decision.corrected_requested_frame_estimated_x_mm !== null
            ? (pickXSource = 'review-corrected requested_frame_estimated_x_mm + sorting tray X correction',
                Number(decision.corrected_requested_frame_estimated_x_mm) + sortingTrayPickXCorrectionMm)
            : record.requested_frame_estimated_x_mm !== undefined
            ? (pickXSource = 'requested_frame_estimated_x_mm + sorting tray X correction',
                Number(record.requested_frame_estimated_x_mm) + sortingTrayPickXCorrectionMm)
            : record.pick_x_mm !== undefined
            ? (pickXSource = 'pick_x_mm + sorting tray X correction',
                Number(record.pick_x_mm) + sortingTrayPickXCorrectionMm)
            : Number(record.estimated_x_mm) + sortingTrayPickXCorrectionMm;
        var pickYSource = 'estimated_y_mm';
        var pickY = decision && decision.corrected_requested_frame_estimated_y_mm !== undefined
            && decision.corrected_requested_frame_estimated_y_mm !== null
            ? (pickYSource = 'review-corrected requested_frame_estimated_y_mm converted to pick_y_mm + sorting tray Y correction',
                correctedRequestedYToPickY() + sortingTrayPickYCorrectionMm)
            : record.pick_y_mm !== undefined
            ? (pickYSource = 'pick_y_mm + sorting tray Y correction',
                Number(record.pick_y_mm) + sortingTrayPickYCorrectionMm)
            : record.requested_frame_estimated_y_mm !== undefined
            ? (pickYSource = 'requested_frame_estimated_y_mm + sorting tray Y correction',
                Number(record.requested_frame_estimated_y_mm) + sortingTrayPickYCorrectionMm)
            : Number(record.estimated_y_mm) + sortingTrayPickYCorrectionMm;
        return {
            x: pickX,
            y: pickY,
            source: pickXSource + ' / ' + pickYSource
        };
    }

    function readPickTargets(scanDir, quiet, includeDebris, includeUnsafe, requireReviewedPicks) {
        var objectsFile = new File(scanDir, 'objects.jsonl');
        var targets = [];
        var decisions = includeDebris ? {} : readPickReviewDecisions(scanDir);
        var requireApprovedDecision = Boolean(requireReviewedPicks);
        if (!objectsFile.exists()) {
            if (!quiet) {
                print('No objects.jsonl found for pick sequence: ' + objectsFile.getAbsolutePath());
            }
            return targets;
        }

        var reader = new BufferedReader(new FileReader(objectsFile));
        try {
            var line = reader.readLine();
            while (line !== null) {
                line = String(line).trim();
                if (line.length > 0) {
                    try {
                        var record = JSON.parse(line);
                        var objectIndex = record.object_index;
                        var decision = decisions[String(objectIndex)];
                        var pickCoordinates = pickCoordinatesFromRecord(record, decision);
                        var pickX = pickCoordinates.x;
                        var pickY = pickCoordinates.y;
                        if (pickX !== undefined && pickY !== undefined) {
                            if (requireApprovedDecision && !(decision && decision.pick === true)) {
                                if (!quiet) {
                                    print('Skipping object ' + objectIndex + ' because it was not explicitly approved during review.');
                                }
                            }
                            else if (!includeDebris && decision && decision.pick === false) {
                                if (!quiet) {
                                    print('Skipping object ' + objectIndex + ' marked as debris during review.');
                                }
                            }
                            else {
                                targets.push(makePickTarget(record, pickX, pickY, decision, false, pickCoordinates.source));
                            }
                        }
                    }
                    catch (parseError) {
                        print('Skipping unreadable object record: ' + parseError);
                    }
                }
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }

        recoverDuplicateCandidates(scanDir, targets, decisions, includeDebris, quiet, requireApprovedDecision);
        targets.sort(function(a, b) {
            return targetQualityScore(b) - targetQualityScore(a);
        });
        markUnsafeCloseTargets(targets, 2.5);
        markUnsafeCloseCandidates(scanDir, targets, 2.5);
        markUnsafePickerXTargets(targets);
        // Large specimens should be reviewed by the operator, not silently excluded
        // from picking. Close-neighbor targets still remain unsafe.
        if (!includeUnsafe) {
            targets = filterUnsafeTargets(targets, quiet);
        }
        targets.sort(function(a, b) {
            if (a.collectionEventSlot !== b.collectionEventSlot) {
                return a.collectionEventSlot - b.collectionEventSlot;
            }
            if (a.sortingTraySlot !== b.sortingTraySlot) {
                return a.sortingTraySlot - b.sortingTraySlot;
            }
            if (a.frameIndex !== b.frameIndex) {
                return a.frameIndex - b.frameIndex;
            }
            if (a.y === b.y) {
                return a.x - b.x;
            }
            return a.y - b.y;
        });
        return targets;
    }

    function makePickTarget(record, pickX, pickY, decision, recoveredDuplicate, coordinateSource) {
        return {
            objectIndex: recoveredDuplicate
                ? Number(record.candidate_index !== undefined ? record.candidate_index : record.object_index) + 1000000
                : record.object_index,
            originalObjectIndex: record.object_index,
            candidateIndex: record.candidate_index,
            duplicateOfObjectIndex: record.duplicate_of_object_index,
            isDuplicate: Boolean(record.is_duplicate),
            recoveredDuplicate: Boolean(recoveredDuplicate),
            coordinateTransformVersion: String(record.coordinate_transform_version || ''),
            coordinateSource: String(coordinateSource || ''),
            frameIndex: Number(record.frame_index || 0),
            sortingTraySlot: Number(record.sorting_tray_slot || 1),
            collectionEventSlot: Number(record.collection_event_slot || 1),
            plateSlot: Number(record.plate_slot || 1),
            recoverySlot: Number(record.recovery_slot || 1),
            trayPickZMm: Number(record.tray_pick_z_mm),
            trayHeightMm: Number(record.tray_height_mm),
            traySizeClass: String(record.tray_size_class || ''),
            x: Number(pickX),
            y: Number(pickY),
            estimatedX: Number(record.estimated_x_mm),
            estimatedY: Number(record.estimated_y_mm),
            frameX: Number(record.frame_x_mm),
            frameY: Number(record.frame_y_mm),
            requestedFrameX: Number(record.frame_requested_x_mm),
            requestedFrameY: Number(record.frame_requested_y_mm),
            requestedEstimateX: Number(record.requested_frame_estimated_x_mm),
            requestedEstimateY: Number(record.requested_frame_estimated_y_mm),
            cropFile: String(record.crop_file || ''),
            contextFile: String(record.context_file || ''),
            overlayFile: String(record.overlay_file || ''),
            sourceFile: String(record.source_file || ''),
            bboxX: Number(record.bbox_x_px || 0),
            bboxY: Number(record.bbox_y_px || 0),
            bboxWidth: Number(record.bbox_width_px || 0),
            bboxHeight: Number(record.bbox_height_px || 0),
            bboxArea: Number(record.bbox_area_px || 0),
            imageWidth: Number(record.image_width_px || 0),
            imageHeight: Number(record.image_height_px || 0),
            unitsPerPixelX: Math.abs(Number(record.units_per_pixel_x_mm || 0)),
            unitsPerPixelY: Math.abs(Number(record.units_per_pixel_y_mm || 0)),
            centroidX: Number(record.centroid_x_px || 0),
            centroidY: Number(record.centroid_y_px || 0),
            score: Number(record.score || 0),
            unsafeForPick: false,
            unsafeReason: '',
            unsafeNeighborObjectIndex: null,
            unsafeNeighborDistanceMm: null,
            reviewDecision: decision ? String(decision.decision || '') : ''
        };
    }

    function recoverDuplicateCandidates(scanDir, targets, decisions, includeDebris, quiet, requireReviewedPicks) {
        var file = new File(scanDir, 'all_candidates.jsonl');
        var recoveryDistanceMm = 3.5;
        var requireApprovedDecision = Boolean(requireReviewedPicks);
        if (!file.exists()) {
            return;
        }

        var recoveredCount = 0;
        var reader = new BufferedReader(new FileReader(file));
        try {
            var line = reader.readLine();
            while (line !== null) {
                line = String(line).trim();
                if (line.length > 0) {
                    try {
                        var record = JSON.parse(line);
                        if (Boolean(record.is_duplicate)) {
                            var recoveredObjectIndex = Number(
                                record.candidate_index !== undefined ? record.candidate_index : record.object_index
                            ) + 1000000;
                            var recoveredDecision = decisions[String(recoveredObjectIndex)];
                            var originalDecision = decisions[String(record.object_index)];
                            var duplicateOfDecision = decisions[String(record.duplicate_of_object_index)];
                            var decision = recoveredDecision || originalDecision || duplicateOfDecision;
                            var pickCoordinates = pickCoordinatesFromRecord(record);
                            var pickX = pickCoordinates.x;
                            var pickY = pickCoordinates.y;
                            var explicitlyApproved = recoveredDecision && recoveredDecision.pick === true;
                            var relatedDebris = (originalDecision && originalDecision.pick === false)
                                || (duplicateOfDecision && duplicateOfDecision.pick === false);
                            if (pickX !== undefined && pickY !== undefined) {
                                if (requireApprovedDecision && !explicitlyApproved) {
                                    if (!quiet) {
                                        print('Skipping recovered duplicate object ' + recoveredObjectIndex
                                            + ' because it was not explicitly approved during review.');
                                    }
                                }
                                else if (!includeDebris && relatedDebris && !explicitlyApproved) {
                                    if (!quiet) {
                                        print('Skipping recovered duplicate object ' + recoveredObjectIndex
                                            + ' because a related object was marked as debris during review.');
                                    }
                                }
                                else if (!includeDebris && decision && decision.pick === false) {
                                    if (!quiet) {
                                        print('Skipping recovered duplicate object ' + recoveredObjectIndex
                                            + ' marked as debris during review.');
                                    }
                                }
                                else if (distanceToNearestTarget(Number(pickX), Number(pickY), targets) >= recoveryDistanceMm) {
                                    targets.push(makePickTarget(record, pickX, pickY, decision, true, pickCoordinates.source));
                                    recoveredCount++;
                                }
                            }
                        }
                    }
                    catch (parseError) {
                        print('Skipping unreadable duplicate candidate record: ' + parseError);
                    }
                }
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }

        if (recoveredCount > 0 && !quiet) {
            print('Recovered ' + recoveredCount
                + ' duplicate-labeled candidate(s) at least '
                + recoveryDistanceMm.toFixed(1)
                + 'mm from existing targets.');
        }
    }

    function distanceToNearestTarget(x, y, targets) {
        var nearest = Number.POSITIVE_INFINITY;
        for (var i = 0; i < targets.length; i++) {
            var dx = x - targets[i].x;
            var dy = y - targets[i].y;
            var distance = Math.sqrt((dx * dx) + (dy * dy));
            if (distance < nearest) {
                nearest = distance;
            }
        }
        return nearest;
    }

    function markUnsafeCloseTargets(targets, minimumSafeDistanceMm) {
        for (var i = 0; i < targets.length; i++) {
            for (var j = i + 1; j < targets.length; j++) {
                var dx = targets[i].x - targets[j].x;
                var dy = targets[i].y - targets[j].y;
                var distance = Math.sqrt((dx * dx) + (dy * dy));
                if (distance < minimumSafeDistanceMm) {
                    markUnsafeCloseTarget(targets[i], targets[j], distance);
                    markUnsafeCloseTarget(targets[j], targets[i], distance);
                }
            }
        }
    }

    function markUnsafePickerXTargets(targets) {
        var minimumAxisX = pickerMinimumXmm + pickerXLimitMarginMm;
        var maximumAxisX = pickerMaximumXmm - pickerXLimitMarginMm;
        for (var i = 0; i < targets.length; i++) {
            var nozzleX = Number(targets[i].x);
            var axisX = nozzleX + pickerN1HeadOffsetXmm;
            if (axisX < minimumAxisX || axisX > maximumAxisX) {
                targets[i].unsafeForPick = true;
                targets[i].unsafeReason = 'N1 destination X=' + nozzleX.toFixed(3)
                    + 'mm transforms to axis X=' + axisX.toFixed(3)
                    + 'mm, outside safe axis range '
                    + minimumAxisX.toFixed(3) + '..' + maximumAxisX.toFixed(3) + 'mm';
            }
        }
    }

    function markUnsafeCloseTarget(target, neighbor, distance) {
        if (target.unsafeNeighborDistanceMm === null || distance < target.unsafeNeighborDistanceMm) {
            target.unsafeForPick = true;
            target.unsafeReason = 'pick target within 2.5mm nozzle safety distance';
            target.unsafeNeighborObjectIndex = neighbor.objectIndex;
            target.unsafeNeighborDistanceMm = distance;
        }
    }

    function markUnsafeCloseCandidates(scanDir, targets, minimumSafeDistanceMm) {
        var candidates = readCandidateTargets(scanDir);
        if (candidates.length === 0) {
            return;
        }
        for (var i = 0; i < targets.length; i++) {
            var targetGroup = targetIdentityGroup(targets[i]);
            for (var j = 0; j < candidates.length; j++) {
                if (sameTargetIdentity(targetGroup, candidates[j])) {
                    continue;
                }
                var dx = targets[i].x - candidates[j].x;
                var dy = targets[i].y - candidates[j].y;
                var distance = Math.sqrt((dx * dx) + (dy * dy));
                if (distance >= 0.8 && distance < minimumSafeDistanceMm) {
                    markUnsafeCloseTarget(targets[i], candidates[j], distance);
                }
            }
        }
    }

    function targetIdentityGroup(target) {
        var group = {};
        if (target.objectIndex !== null && target.objectIndex !== undefined && Number(target.objectIndex) < 1000000) {
            group[String(target.objectIndex)] = true;
        }
        if (target.originalObjectIndex !== null && target.originalObjectIndex !== undefined) {
            group[String(target.originalObjectIndex)] = true;
        }
        if (target.duplicateOfObjectIndex !== null && target.duplicateOfObjectIndex !== undefined) {
            group[String(target.duplicateOfObjectIndex)] = true;
        }
        return group;
    }

    function sameTargetIdentity(targetGroup, candidate) {
        if (candidate.objectIndex !== null
                && candidate.objectIndex !== undefined
                && targetGroup[String(candidate.objectIndex)]) {
            return true;
        }
        if (candidate.duplicateOfObjectIndex !== null
                && candidate.duplicateOfObjectIndex !== undefined
                && targetGroup[String(candidate.duplicateOfObjectIndex)]) {
            return true;
        }
        return false;
    }

    function readCandidateTargets(scanDir) {
        var file = new File(scanDir, 'all_candidates.jsonl');
        var candidates = [];
        if (!file.exists()) {
            return candidates;
        }
        var reader = new BufferedReader(new FileReader(file));
        try {
            var line = reader.readLine();
            while (line !== null) {
                line = String(line).trim();
                if (line.length > 0) {
                    try {
                        var record = JSON.parse(line);
                        var pickCoordinates = pickCoordinatesFromRecord(record);
                        var pickX = pickCoordinates.x;
                        var pickY = pickCoordinates.y;
                        if (pickX !== undefined && pickY !== undefined) {
                            candidates.push({
                                objectIndex: record.object_index,
                                duplicateOfObjectIndex: record.duplicate_of_object_index,
                                candidateIndex: record.candidate_index,
                                x: Number(pickX),
                                y: Number(pickY),
                                sourceFile: String(record.source_file || ''),
                                centroidX: Number(record.centroid_x_px || 0),
                                centroidY: Number(record.centroid_y_px || 0)
                            });
                        }
                    }
                    catch (parseError) {
                        print('Skipping unreadable candidate record: ' + parseError);
                    }
                }
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }
        return candidates;
    }

    function markUnsafeMergedFootprints(targets) {
        var areas = [];
        for (var i = 0; i < targets.length; i++) {
            var widthMm = targets[i].bboxWidth * targets[i].unitsPerPixelX;
            var heightMm = targets[i].bboxHeight * targets[i].unitsPerPixelY;
            var areaMm = widthMm * heightMm;
            if (areaMm > 0) {
                areas.push(areaMm);
                targets[i].bboxAreaMm = areaMm;
            }
        }
        if (areas.length < 3) {
            return;
        }
        var medianArea = medianNumber(areas);
        var absoluteUnsafeAreaMm = 18.0;
        for (var j = 0; j < targets.length; j++) {
            if (targets[j].bboxAreaMm !== undefined
                    && targets[j].bboxAreaMm > absoluteUnsafeAreaMm
                    && targets[j].bboxAreaMm > (medianArea * 2.2)) {
                targets[j].unsafeForPick = true;
                targets[j].unsafeReason = 'large merged-looking footprint; possible multiple specimens/debris';
            }
        }
    }

    function filterUnsafeTargets(targets, quiet) {
        var safeTargets = [];
        for (var i = 0; i < targets.length; i++) {
            if (targets[i].unsafeForPick) {
                if (!quiet) {
                    print('Skipping object ' + targets[i].objectIndex + ': ' + targets[i].unsafeReason
                        + (targets[i].unsafeNeighborDistanceMm === null
                            ? ''
                            : '; neighbor object ' + targets[i].unsafeNeighborObjectIndex
                                + ' is only ' + Number(targets[i].unsafeNeighborDistanceMm).toFixed(3)
                                + 'mm away.'));
                }
            }
            else {
                safeTargets.push(targets[i]);
            }
        }
        return safeTargets;
    }

    function targetQualityScore(target) {
        var edgePenalty = 0.0;
        if (target.imageWidth > 0 && target.imageHeight > 0
                && target.bboxWidth > 0 && target.bboxHeight > 0) {
            var left = target.bboxX;
            var top = target.bboxY;
            var right = target.imageWidth - (target.bboxX + target.bboxWidth);
            var bottom = target.imageHeight - (target.bboxY + target.bboxHeight);
            var edgeClearance = Math.min(Math.min(left, right), Math.min(top, bottom));
            edgePenalty = Math.max(0.0, 120.0 - edgeClearance) * 20000.0;
        }
        return target.score + (target.bboxArea * 80.0) - edgePenalty;
    }

    function deduplicateTargets(targets, minimumDistanceMm) {
        var unique = [];
        for (var i = 0; i < targets.length; i++) {
            var target = targets[i];
            var duplicate = false;
            for (var j = 0; j < unique.length; j++) {
                var dx = target.x - unique[j].x;
                var dy = target.y - unique[j].y;
                if (Math.sqrt((dx * dx) + (dy * dy)) < minimumDistanceMm) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) {
                unique.push(target);
            }
        }
        unique.sort(function(a, b) {
            if (a.y === b.y) {
                return a.x - b.x;
            }
            return a.y - b.y;
        });
        return unique;
    }

    function wellNameForIndex(index) {
        var rowIndex = Math.floor(index / 12);
        var columnIndex = index % 12;
        return String.fromCharCode('A'.charCodeAt(0) + rowIndex) + String(columnIndex + 1);
    }

    function wellLocationForIndex(index, plateContext) {
        if (index < 0 || index >= 96) {
            throw new Error('96-well plate only has room for 96 targets; requested well index ' + index);
        }

        var calibration = plateContext ? null : loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        var a1X = plateContext ? Number(plateContext.plateA1X) : Number(calibration.plateA1X);
        var a1Y = plateContext ? Number(plateContext.plateA1Y) : Number(calibration.plateA1Y);
        var wellPitch = plateContext ? Number(plateContext.plateWellPitchMm) : Number(calibration.plateWellPitchMm);
        var rowIndex = Math.floor(index / 12);
        var columnIndex = index % 12;
        var qaCamera = wellQaCameraLocationForIndex(index, plateContext);
        var topCamera = topCameraWellLocationForIndex(index, plateContext);

        return {
            name: wellNameForIndex(index),
            x: a1X + (wellPitch * rowIndex),
            y: a1Y + (wellPitch * columnIndex),
            qaCameraX: qaCamera.x,
            qaCameraY: qaCamera.y,
            topCameraX: topCamera.x,
            topCameraY: topCamera.y
        };
    }

    function topCameraWellLocationForIndex(index, plateContext) {
        if (index < 0 || index >= 96) {
            throw new Error('96-well plate only has room for 96 targets; requested well index ' + index);
        }
        var calibration = plateContext ? null : loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        var a1X = plateContext
            ? Number(plateContext.topCameraA1X)
            : Number(calibration.plateA1X) + Number(calibration.cameraXOffsetMm);
        var a1Y = plateContext
            ? Number(plateContext.topCameraA1Y)
            : Number(calibration.plateA1Y) + Number(calibration.cameraYOffsetMm);
        var wellPitch = plateContext ? Number(plateContext.plateWellPitchMm) : Number(calibration.plateWellPitchMm);
        var rowIndex = Math.floor(index / 12);
        var columnIndex = index % 12;
        return {
            name: wellNameForIndex(index),
            x: a1X + (wellPitch * rowIndex),
            y: a1Y + (wellPitch * columnIndex)
        };
    }

    function wellQaCameraLocationForIndex(index, plateContext) {
        if (index < 0 || index >= 96) {
            throw new Error('96-well plate only has room for 96 targets; requested well index ' + index);
        }

        var calibration = plateContext ? null : loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        var a1X = plateContext ? Number(plateContext.plateQaCameraA1X) : Number(calibration.plateQaCameraA1X);
        var a1Y = plateContext ? Number(plateContext.plateQaCameraA1Y) : Number(calibration.plateQaCameraA1Y);
        var wellPitch = plateContext ? Number(plateContext.plateWellPitchMm) : Number(calibration.plateWellPitchMm);
        var rowIndex = Math.floor(index / 12);
        var columnIndex = index % 12;

        return {
            name: wellNameForIndex(index),
            x: a1X + (wellPitch * rowIndex),
            y: a1Y + (wellPitch * columnIndex)
        };
    }

    function recoveryWellLocationForIndex(index, plateContext) {
        if (index < 0 || index >= 96) {
            throw new Error('Recovery plate only has room for 96 targets; requested well index ' + index);
        }

        var calibration = plateContext ? null : loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        var a1X = plateContext ? Number(plateContext.recoveryPlateA1X) : Number(calibration.recoveryPlateA1X);
        var a1Y = plateContext ? Number(plateContext.recoveryPlateA1Y) : Number(calibration.recoveryPlateA1Y);
        var wellPitch = plateContext ? Number(plateContext.plateWellPitchMm) : Number(calibration.plateWellPitchMm);
        var rowIndex = Math.floor(index / 12);
        var columnIndex = index % 12;

        return {
            name: wellNameForIndex(index),
            x: a1X + (wellPitch * rowIndex),
            y: a1Y + (wellPitch * columnIndex)
        };
    }

    function pickAndDropTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames, plateContext, wellQueue, targetStartIndex, plateSlotFilter) {
        var pickHeadName = 'H1';
        var pickNozzleName = 'N1';
        var pickNozzleLabel = 'left nozzle N1';
        var dryRunFile = new File(projectDir, 'control/pick_dry_run.flag');
        var dryRun = dryRunFile.exists();
        var pickTool = findPickTool(pickHeadName, pickNozzleName);
        var nozzle = pickTool.nozzle;
        var hiResCamera = findHiResCamera();
        var vacuumActuator = findVacuumActuator(pickTool.head, nozzle);
        var topCamera = findCameraByName('Top');
        var travelZ = nozzle.location.z;
        var hiResTravelZ = travelZ;
        var touchCorrection = readTouchCorrection();
        var trayCalibration = loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        var defaultPickZ = Number(trayCalibration.pickZMm);
        var hiResFocusZ = isNaN(Number(trayCalibration.hiResFocusZMm)) ? hiResFocusCenterZ : Number(trayCalibration.hiResFocusZMm);
        var hiResOffsetX = Number(plateContext.plateQaCameraA1X) - Number(plateContext.plateA1X);
        var hiResOffsetY = Number(plateContext.plateQaCameraA1Y) - Number(plateContext.plateA1Y);
        var dropZ = -33.5;
        var targets = readPickTargets(scanDir, false, false, false, reviewDecisionFile(scanDir).exists());
        if (plateSlotFilter !== undefined && plateSlotFilter !== null) {
            var filteredTargets = [];
            for (var filterIndex = 0; filterIndex < targets.length; filterIndex++) {
                if (Number(targets[filterIndex].plateSlot || 1) === Number(plateSlotFilter)) {
                    filteredTargets.push(targets[filterIndex]);
                }
            }
            targets = filteredTargets;
        }
        var startTargetIndex = Math.max(0, Number(targetStartIndex || 0));
        if (startTargetIndex > targets.length) {
            startTargetIndex = targets.length;
        }
        var availableWells = wellQueue || wellQueueFromStart(plateContext);
        var remainingTargetCount = Math.max(0, targets.length - startTargetIndex);
        var targetLimit = Math.min(remainingTargetCount, availableWells.length);
        var emptyWells = [];
        var result = {
            emptyWells: emptyWells,
            attemptedWells: 0,
            targetsFound: targets.length,
            availableWells: availableWells.length,
            targetStartIndex: startTargetIndex,
            nextTargetIndex: startTargetIndex,
            remainingTargets: remainingTargetCount
        };

        print('Pick sequence has ' + targets.length + ' unique target(s); starting at target '
            + (startTargetIndex + 1) + '.');
        print('Plate context: plate=' + plateContext.plateNumber
            + ' plate_id=' + plateContext.plateId
            + ' collection=' + plateContext.collectionCode
            + ' plate_slot=' + plateContext.plateSlot
            + ' recovery_slot=' + plateContext.recoverySlot
            + ' available wells=' + availableWells.length
            + ' target limit=' + targetLimit);
        print('Pick tool is ' + pickNozzleLabel + ' on head ' + pickHeadName
            + '; travel Z for XY moves: ' + travelZ.toFixed(3));
        print('BugPicker XY correction disabled: dX=' + touchCorrection.x.toFixed(3)
            + ' dY=' + touchCorrection.y.toFixed(3)
            + ' source=' + touchCorrection.source);
        print('Tray height preset: ' + Number(trayCalibration.trayHeightMm).toFixed(3)
            + ' mm; size class=' + trayCalibration.sizeClass
            + '; default N1 pick Z=' + defaultPickZ.toFixed(3)
            + '; source=' + trayCalibration.source);
        print('Dual-nozzle Z prediction: default N1 pick Z=' + defaultPickZ.toFixed(3)
            + ' would put N2 at Z=' + n2ZWhenN1Z(defaultPickZ).toFixed(3));
        print('N1 drop Z=' + dropZ.toFixed(3));
        print('HiRes camera selected: ' + hiResCamera.getName()
            + '; N1-frame travel Z=' + Number(hiResTravelZ).toFixed(3)
            + '; focus center Z=' + hiResFocusZ.toFixed(3)
            + '; A1-derived HiRes offset from picker dX=' + hiResOffsetX.toFixed(3)
            + ' dY=' + hiResOffsetY.toFixed(3));
        if (dryRun) {
            print('Pick dry run flag is present: ' + dryRunFile.getAbsolutePath());
        }
        if (targets.length === 0 || remainingTargetCount === 0) {
            parkPickerAtBottomInspectionHome(nozzle, travelZ);
            writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan completed; no remaining pick targets found');
            return result;
        }
        if (targetLimit === 0) {
            parkPickerAtBottomInspectionHome(nozzle, travelZ);
            writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan completed; no wells available to fill');
            return result;
        }
        if (targets.length > availableWells.length) {
            print('Found ' + targets.length + ' pick targets but only ' + availableWells.length
                + ' wells are available; only the first ' + targetLimit + ' target(s) will be plated.');
        }

        setVacuum(vacuumActuator, false);
        var preflightTarget = targets[startTargetIndex];
        var preflightQa = inspectNozzleWithConservativeQa(
            scanDir,
            scanId,
            preflightTarget,
            startTargetIndex,
            targets.length,
            nozzle,
            travelZ,
            'preflight_before_first_pick'
        );
        if (preflightQa.bug_present) {
            print('Preflight bottom-camera QA found material on N1; cleaning before the first pick.');
            cleanAndVerifyNozzle(
                scanDir,
                scanId,
                preflightTarget,
                startTargetIndex,
                targets.length,
                nozzle,
                vacuumActuator,
                travelZ,
                Number(availableWells[0]),
                statusFile,
                plateContext
            );
        }
        else {
            print('Preflight bottom-camera QA confirmed N1 clear before the first pick.');
        }

        var wellCursor = 0;
        for (var i = 0; i < remainingTargetCount && wellCursor < availableWells.length; i++) {
            if (!waitWhilePaused(pauseFile, stopFile, statusFile, scanId, i, targets.length)
                    || haltRequested(stopFile, statusFile, scanId, i, targets.length)) {
                print('Halt requested during pick sequence. Stopping before target ' + (i + 1) + '.');
                return result;
            }

            var targetIndex = startTargetIndex + i;
            result.nextTargetIndex = targetIndex + 1;
            result.remainingTargets = Math.max(0, targets.length - result.nextTargetIndex);
            var target = targets[targetIndex];
            var pickZ = isNaN(Number(target.trayPickZMm)) ? defaultPickZ : Number(target.trayPickZMm);
            var moveX = target.x + touchCorrection.x;
            var moveY = target.y + touchCorrection.y;
            var hiResTargetX = moveX + hiResOffsetX;
            var hiResTargetY = moveY + hiResOffsetY;
            var wellIndex = Number(availableWells[wellCursor]);
            if (isReservedPlateWellIndex(wellIndex)) {
                throw new Error('Refusing to move toward reserved negative control well '
                    + RESERVED_NEGATIVE_CONTROL_WELL + '.');
            }
            var well = wellLocationForIndex(wellIndex, plateContext);
            writePickingPreview(scanDir, scanId, target, targetIndex, targets.length, moveX, moveY);
            writeStatus(
                statusFile,
                'picking',
                scanId,
                targetIndex + 1,
                targets.length,
                'Picking target ' + (targetIndex + 1) + ' for well ' + well.name
                    + ' at X ' + moveX.toFixed(3) + ', Y ' + moveY.toFixed(3)
            );

            debugPickTarget(scanDir, target, nozzle, travelZ, dryRun, touchCorrection, moveX, moveY);
            if (dryRun) {
                writeStatus(statusFile, 'paused', scanId, targetIndex + 1, targets.length, 'Dry run stopped above first pick target');
                return result;
            }

            var hiResImageFile = captureBestHiResImage(
                scanDir,
                scanId,
                target,
                targetIndex,
                targets.length,
                hiResCamera,
                nozzle,
                hiResTargetX,
                hiResTargetY,
                hiResFocusZ,
                hiResTravelZ,
                statusFile,
                'Target ' + (targetIndex + 1)
            );

            print('Moving ' + pickNozzleLabel + ' above object ' + target.objectIndex
                + ' using corrected scan coordinates X=' + moveX.toFixed(3)
                + ' Y=' + moveY.toFixed(3)
                + ' source=' + target.coordinateSource
                + ' at travel Z=' + travelZ.toFixed(3));
            moveNozzleToXyAtZ(nozzle, moveX, moveY, travelZ);

            print('Starting assumed-success net-tray pick for object ' + target.objectIndex
                + ' at X=' + moveX.toFixed(3)
                + ' Y=' + moveY.toFixed(3)
                + ' tray=' + target.sortingTraySlot
                + ' Z=' + pickZ.toFixed(3));
            pickAssumingSuccess(
                scanDir,
                target,
                nozzle,
                vacuumActuator,
                moveX,
                moveY,
                pickZ,
                targetIndex,
                scanId,
                targets.length
            );
            moveNozzleToXyAtZ(nozzle, moveX, moveY, travelZ);

            var nozzleQa = inspectNozzleWithConservativeQa(
                scanDir,
                scanId,
                target,
                targetIndex,
                targets.length,
                nozzle,
                travelZ,
                'post_pick'
            );
            var bottomInspectionImage = nozzleQa.cropImageFile;
            print('Bottom-camera nozzle QA for target ' + (targetIndex + 1)
                + ': bug_present=' + nozzleQa.bug_present
                + ' possible_multiple=' + nozzleQa.possible_multiple
                + ' component_count=' + nozzleQa.component_count
                + ' largest_area_px=' + Number(nozzleQa.largest_area_px || 0).toFixed(1)
                + ' dark_fraction=' + Number(nozzleQa.dark_fraction || 0).toFixed(5));
            if (!nozzleQa.bug_present || nozzleQa.possible_multiple) {
                var rejectedPickReason = !nozzleQa.bug_present
                    ? 'Bottom camera did not confirm a specimen on the nozzle'
                    : 'Bottom camera detected a possible multiple pickup';
                writeStatus(
                    statusFile,
                    'qa',
                    scanId,
                    targetIndex + 1,
                    targets.length,
                    'Bottom camera flagged target ' + (targetIndex + 1)
                        + ': bottom camera '
                        + (!nozzleQa.bug_present ? 'did not confirm a specimen' : 'saw possible multiple specimens')
                        + '; rejecting pickup before the well'
                );
                print('Rejecting target ' + (targetIndex + 1) + ' before plating: ' + rejectedPickReason + '.');
                appendPlateAttemptLog(
                    scanDir,
                    plateContext,
                    well,
                    target,
                    targetIndex,
                    hiResImageFile,
                    bottomInspectionImage,
                    null,
                    nozzleQa.possible_multiple ? 'bottom QA possible multiple' : 'bottom QA empty',
                    rejectedPickReason,
                    scanId,
                    {
                        bottom_bug_present: Boolean(nozzleQa.bug_present),
                        bottom_possible_multiple: Boolean(nozzleQa.possible_multiple),
                        bottom_component_count: Number(nozzleQa.component_count || 0),
                        bottom_largest_area_px: Number(nozzleQa.largest_area_px || 0),
                        bottom_dark_fraction: Number(nozzleQa.dark_fraction || 0),
                        bottom_sample_count: Number(nozzleQa.sample_count || 0)
                    }
                );
                if (nozzleQa.possible_multiple) {
                    cleanAndVerifyNozzle(
                        scanDir,
                        scanId,
                        target,
                        targetIndex,
                        targets.length,
                        nozzle,
                        vacuumActuator,
                        travelZ,
                        wellIndex,
                        statusFile,
                        plateContext
                    );
                }
                else {
                    setVacuum(vacuumActuator, false);
                    print('No specimen was detected after pickup; skipping recovery cleaning and reusing well '
                        + well.name + ' for the next target.');
                }
                continue;
            }

            wellCursor++;
            result.attemptedWells++;

            print('Moving ' + pickNozzleLabel + ' above well ' + well.name
                + ' for object ' + target.objectIndex
                + ' at X=' + well.x.toFixed(3)
                + ' Y=' + well.y.toFixed(3)
                + ' travel Z=' + travelZ.toFixed(3));
            moveNozzleToXyAtZ(nozzle, well.x, well.y, travelZ);

            print('Descending to place object ' + target.objectIndex
                + ' into well ' + well.name
                + ' at X=' + well.x.toFixed(3)
                + ' Y=' + well.y.toFixed(3)
                + ' Z=' + dropZ.toFixed(3));
            warnDualNozzleZClearance(dropZ, 'drop descent');
            moveNozzleToXyAtZ(nozzle, well.x, well.y, dropZ);
            releasePartIntoWell(vacuumActuator);
            moveNozzleToXyAtZ(nozzle, well.x, well.y, travelZ);
            print('Turning vacuum back on after lifting from the plate to hold any stuck specimen during QA imaging.');
            setVacuum(vacuumActuator, true);

            writeStatus(
                statusFile,
                'qa',
                scanId,
                targetIndex + 1,
                targets.length,
                'Checking well ' + well.name + ' after placing target ' + (targetIndex + 1)
            );
            var wellQa = inspectPlacedWell(
                scanDir,
                scanId,
                target,
                targetIndex,
                targets.length,
                statusFile,
                hiResCamera,
                topCamera,
                nozzle,
                well,
                touchCorrection,
                hiResFocusZ,
                hiResTravelZ
            );
            var wellImageFile = String(wellQa.hires_image || '').length > 0
                ? new File(String(wellQa.hires_image))
                : null;
            var topWellImageFile = new File(String(wellQa.top_image || wellQa.image || ''));
            var relativeOnlyWellOccupancy = Boolean(wellQa.relative_only_well_occupancy);
            var placementAttemptCount = 1;
            var retryNozzleQa = null;
            if (Boolean(wellQa.well_empty) && !relativeOnlyWellOccupancy) {
                writeStatus(
                    statusFile,
                    'qa',
                    scanId,
                    targetIndex + 1,
                    targets.length,
                    'Well ' + well.name + ' appears empty; checking nozzle before a second placement attempt'
                );
                retryNozzleQa = inspectNozzleWithConservativeQa(
                    scanDir,
                    scanId,
                    target,
                    targetIndex,
                    targets.length,
                    nozzle,
                    travelZ,
                    'after_empty_well_attempt_1'
                );
                print('Post-place nozzle QA before retry for well ' + well.name
                    + ': bug_present=' + retryNozzleQa.bug_present
                    + ' possible_multiple=' + retryNozzleQa.possible_multiple);
                if (retryNozzleQa.bug_present && !retryNozzleQa.possible_multiple) {
                    appendPlateAttemptLog(
                        scanDir,
                        plateContext,
                        well,
                        target,
                        targetIndex,
                        hiResImageFile,
                        bottomInspectionImage,
                        wellImageFile,
                        'well QA empty',
                        'First placement attempt empty; specimen remained on nozzle, retrying same well',
                        scanId,
                        {
                            bottom_bug_present: true,
                            placement_attempt_count: 1,
                            placement_retry_started: true,
                            post_drop_nozzle_bug_present: true,
                            topWellImage: topWellImageFile.getName()
                        }
                    );
                    placementAttemptCount = 2;
                    writeStatus(
                        statusFile,
                        'qa',
                        scanId,
                        targetIndex + 1,
                        targets.length,
                        'Retrying placement into well ' + well.name
                    );
                    moveNozzleToXyAtZ(nozzle, well.x, well.y, travelZ);
                    warnDualNozzleZClearance(dropZ, 'second drop descent');
                    moveNozzleToXyAtZ(nozzle, well.x, well.y, dropZ);
                    releasePartIntoWell(vacuumActuator);
                    moveNozzleToXyAtZ(nozzle, well.x, well.y, travelZ);
                    setVacuum(vacuumActuator, true);
                    wellQa = inspectPlacedWell(
                        scanDir,
                        scanId,
                        target,
                        targetIndex,
                        targets.length,
                        statusFile,
                        hiResCamera,
                        topCamera,
                        nozzle,
                        well,
                        touchCorrection,
                        hiResFocusZ,
                        hiResTravelZ
                    );
                    wellImageFile = String(wellQa.hires_image || '').length > 0
                        ? new File(String(wellQa.hires_image))
                        : null;
                    topWellImageFile = new File(String(wellQa.top_image || wellQa.image || ''));
                    relativeOnlyWellOccupancy = Boolean(wellQa.relative_only_well_occupancy);
                }
            }
            var wellQaNeedsReview = Boolean(wellQa.well_empty) || relativeOnlyWellOccupancy;
            if (wellQaNeedsReview) {
                var wellQaReviewReason = relativeOnlyWellOccupancy
                    ? 'QA well uncertain - relative-only well texture'
                    : 'QA well empty';
                emptyWells.push({
                    index: wellIndex,
                    name: well.name,
                    reviewKind: 'well_occupancy',
                    imageFile: topWellImageFile,
                    wellImageFile: wellImageFile,
                    hiResImageFile: hiResImageFile,
                    bottomImageFile: bottomInspectionImage,
                    topWellImageFile: topWellImageFile,
                    target: target,
                    targetIndex: targetIndex,
                    reason: wellQaReviewReason
                });
                appendPlateAttemptLog(
                    scanDir,
                    plateContext,
                    well,
                    target,
                    targetIndex,
                    hiResImageFile,
                    bottomInspectionImage,
                    wellImageFile,
                    'well QA empty',
                    wellQaReviewReason,
                    scanId,
                    {
                        bottom_bug_present: Boolean(nozzleQa.bug_present),
                        bottom_possible_multiple: Boolean(nozzleQa.possible_multiple),
                        bottom_component_count: Number(nozzleQa.component_count || 0),
                        bottom_largest_area_px: Number(nozzleQa.largest_area_px || 0),
                        bottom_dark_fraction: Number(nozzleQa.dark_fraction || 0),
                        well_relative_only_occupancy: relativeOnlyWellOccupancy,
                        placement_attempt_count: placementAttemptCount,
                        second_placement_successful: false,
                        post_drop_nozzle_bug_present: retryNozzleQa === null
                            ? null
                            : Boolean(retryNozzleQa.bug_present),
                        topWellImage: topWellImageFile.getName()
                    }
                );
                writeStatus(
                    statusFile,
                    'qa',
                    scanId,
                    targetIndex + 1,
                    targets.length,
                    'Well ' + well.name + ' needs review; moving to recovery plate'
                );
            }
            else {
                var traceMetadata = plateTraceMetadata(
                    scanDir,
                    scanId,
                    target,
                    targetIndex,
                    hiResImageFile,
                    bottomInspectionImage,
                    wellImageFile,
                    'well QA occupied',
                    topWellImageFile
                );
                copyPlateSpecimenImages(scanDir, plateContext, well, target, hiResImageFile, bottomInspectionImage, wellImageFile, topWellImageFile);
                appendPlateSpreadsheetRow(plateContext, well, traceMetadata);
                appendPlateAttemptLog(
                    scanDir,
                    plateContext,
                    well,
                    target,
                    targetIndex,
                    hiResImageFile,
                    bottomInspectionImage,
                    wellImageFile,
                    'well QA occupied',
                    '',
                    scanId,
                    {
                        bottom_bug_present: Boolean(nozzleQa.bug_present),
                        bottom_possible_multiple: Boolean(nozzleQa.possible_multiple),
                        bottom_component_count: Number(nozzleQa.component_count || 0),
                        bottom_largest_area_px: Number(nozzleQa.largest_area_px || 0),
                        bottom_dark_fraction: Number(nozzleQa.dark_fraction || 0),
                        placement_attempt_count: placementAttemptCount,
                        second_placement_successful: placementAttemptCount === 2,
                        topWellImage: topWellImageFile.getName()
                    }
                );
            }
            if (!wellQaNeedsReview) {
                writeStatus(
                    statusFile,
                    'qa',
                    scanId,
                    targetIndex + 1,
                    targets.length,
                    'Well ' + well.name + ' is occupied; verifying that the nozzle is clear'
                );
                var postSuccessNozzleQa = inspectNozzleWithConservativeQa(
                    scanDir,
                    scanId,
                    target,
                    targetIndex,
                    targets.length,
                    nozzle,
                    travelZ,
                    'post_successful_place'
                );
                print('Post-success nozzle QA for well ' + well.name
                    + ': bug_present=' + postSuccessNozzleQa.bug_present
                    + ' possible_multiple=' + postSuccessNozzleQa.possible_multiple);
                if (postSuccessNozzleQa.bug_present) {
                    cleanAndVerifyNozzle(
                        scanDir,
                        scanId,
                        target,
                        targetIndex,
                        targets.length,
                        nozzle,
                        vacuumActuator,
                        travelZ,
                        wellIndex,
                        statusFile,
                        plateContext
                    );
                }
                else {
                    setVacuum(vacuumActuator, false);
                    print('Bottom-camera QA confirmed the nozzle clear; skipping recovery wipe.');
                }
            }
            else {
                cleanAndVerifyNozzle(
                    scanDir,
                    scanId,
                    target,
                    targetIndex,
                    targets.length,
                    nozzle,
                    vacuumActuator,
                    travelZ,
                    wellIndex,
                    statusFile,
                    plateContext
                );
            }
        }

        parkHeadAtMaxXy(topCamera, pickTool.head);
        writeStatus(statusFile, 'running', scanId, totalFrames, totalFrames, 'Pick/drop pass completed; waiting for refill decisions');
        return result;
    }

    function pickAndDropPlateContexts(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames, plateContexts) {
        var aggregate = {
            emptyWells: [],
            attemptedWells: 0,
            targetsFound: 0,
            availableWells: 0,
            targetStartIndex: 0,
            nextTargetIndex: 0,
            remainingTargets: 0
        };
        for (var contextIndex = 0; contextIndex < plateContexts.length; contextIndex++) {
            var context = plateContexts[contextIndex];
            var queue = wellQueueFromStart(context);
            if (queue.length === 0) {
                print('Skipping plate ' + context.plateNumber
                    + ' slot ' + context.plateSlot
                    + ': no available wells at or after ' + context.startWell + '.');
                continue;
            }
            print('Starting plate slot ' + context.plateSlot
                + ' using collection ' + context.collectionCode
                + ' into plate ' + context.plateNumber
                + ' with recovery slot ' + context.recoverySlot + '.');
            var result = pickAndDropTargets(
                scanDir,
                pauseFile,
                stopFile,
                statusFile,
                scanId,
                totalFrames,
                context,
                queue,
                0,
                context.plateSlot
            );
            aggregate.emptyWells = aggregate.emptyWells.concat(result.emptyWells);
            aggregate.attemptedWells += result.attemptedWells;
            aggregate.targetsFound += result.targetsFound;
            aggregate.availableWells += result.availableWells;
            aggregate.remainingTargets += result.remainingTargets;
            aggregate.nextTargetIndex = result.nextTargetIndex;
        }
        return aggregate;
    }

    task(function() {
        var camera = machine.defaultHead.defaultCamera;
        if (camera.getName() !== 'Top') {
            camera = findCameraByName('Top');
        }
        parkNozzlesForScan(machine.defaultHead);
        var calibrationPickTool = findPickTool('H1', 'N1');

        var calibration = loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        calibration = promptForMultiRunSetup(calibration);
        calibration = promptForTrainingTrayBounds(calibration, camera, calibrationPickTool.nozzle);
        print('Calibration dialog accepted; raising nozzles back to safe travel height before scan.');
        parkNozzlesForScan(machine.defaultHead);
        var cameraXOffsetMm = calibration.cameraXOffsetMm;
        var cameraYOffsetMm = calibration.cameraYOffsetMm;
        var xStepMm = calibration.xStepMm;
        var yStepMm = calibration.yStepMm;
        var plateContexts = activePlateContexts(calibration.multiConfig);
        var plateContext = plateContexts[0];
        var activeScanTrays = activeSortingTrayConfigs(calibration.multiConfig);
        if (activeScanTrays.length === 0) {
            JOptionPane.showMessageDialog(
                null,
                'No sorting trays are enabled for this run.',
                'No sorting trays',
                JOptionPane.ERROR_MESSAGE
            );
            return;
        }
        for (var existingPlateIndex = 1; existingPlateIndex < plateContexts.length; existingPlateIndex++) {
            var existingContext = plateContexts[existingPlateIndex];
            if (plateCsvFile(existingContext.plateNumber).exists()) {
                var existingRecordedWells = occupiedWellCount(existingContext.plateNumber);
                var existingChoice = JOptionPane.showOptionDialog(
                    null,
                    'A spreadsheet already exists for plate ' + existingContext.plateNumber
                        + ' with ' + existingRecordedWells + ' recorded well(s).'
                        + '\n\nContinue from the next unrecorded well, or archive the old CSV and treat this as a fresh plate?',
                    'Existing plate warning',
                    JOptionPane.YES_NO_CANCEL_OPTION,
                    JOptionPane.WARNING_MESSAGE,
                    null,
                    Java.to(['Continue existing plate', 'Archive and restart plate', 'Cancel'], 'java.lang.Object[]'),
                    'Continue existing plate'
                );
                if (existingChoice === 1) {
                    archivePlateSpreadsheet(existingContext.plateNumber);
                }
                else if (existingChoice === 0) {
                    reviewExistingPlateWells(existingContext);
                }
                else {
                    return;
                }
            }
        }
        for (var plateHeaderIndex = 0; plateHeaderIndex < plateContexts.length; plateHeaderIndex++) {
            ensurePlateSpreadsheetHeader(plateContexts[plateHeaderIndex]);
        }

        var controlDir = new File(projectDir, 'control');
        var pauseFile = new File(controlDir, 'pause.flag');
        var stopFile = new File(controlDir, 'stop.flag');
        var pickDryRunFile = new File(controlDir, 'pick_dry_run.flag');
        var touchDryRunFile = new File(controlDir, 'touch_dry_run.flag');
        var interactivePickFile = new File(controlDir, 'interactive_pick.flag');
        var statusFile = new File(controlDir, 'scan_status.json');
        var detectionStatusFile = new File(controlDir, 'detection_status.json');
        var outputRoot = new File(projectDir, 'scans');
        controlDir.mkdirs();
        if (stopFile.exists()) {
            stopFile.delete();
        }

        var pendingWellQueue = wellQueueFromStart(plateContext);
        var refillAttempt = 0;
        if (plateContexts.length > 1) {
            var anyPlateHasWells = false;
            for (var pendingContextIndex = 0; pendingContextIndex < plateContexts.length; pendingContextIndex++) {
                if (wellQueueFromStart(plateContexts[pendingContextIndex]).length > 0) {
                    anyPlateHasWells = true;
                }
            }
            if (!anyPlateHasWells) {
                JOptionPane.showMessageDialog(
                    null,
                    'No wells are available on any active plate.',
                    'No wells available',
                    JOptionPane.ERROR_MESSAGE
                );
                return;
            }
            pendingWellQueue = [0];
        }
        if (plateContexts.length === 1 && pendingWellQueue.length === 0) {
            var resetChoice = JOptionPane.showOptionDialog(
                null,
                'No wells are available at or after ' + plateContext.startWell
                    + ' for plate ' + plateContext.plateNumber + '.\n\n'
                    + 'This usually means the plate CSV already records those wells as filled. '
                    + RESERVED_NEGATIVE_CONTROL_WELL + ' is reserved as the negative control and is never filled.\n'
                    + 'Archive the old CSV and restart this plate from ' + plateContext.startWell + '?',
                'No wells available',
                JOptionPane.YES_NO_OPTION,
                JOptionPane.WARNING_MESSAGE,
                null,
                Java.to(['Archive old CSV and restart', 'Cancel run'], 'java.lang.Object[]'),
                'Archive old CSV and restart'
            );
            if (resetChoice !== 0) {
                return;
            }
            archivePlateSpreadsheet(plateContext.plateNumber);
            ensurePlateSpreadsheetHeader(plateContext);
            pendingWellQueue = wellQueueFromStart(plateContext);
            if (pendingWellQueue.length === 0) {
                JOptionPane.showMessageDialog(
                    null,
                    'No wells are available after resetting plate ' + plateContext.plateNumber + '.',
                    'No wells available',
                    JOptionPane.ERROR_MESSAGE
                );
                return;
            }
        }

        while (pendingWellQueue.length > 0) {
            launchHaltGui(controlDir);
            print('Preparing for scan/refill attempt; raising nozzles to safe travel height before XY motion.');
            parkNozzlesForScan(machine.defaultHead);
            var scanId = 'scan_' + timestamp();
            if (refillAttempt > 0) {
                scanId = scanId + '_refill_' + refillAttempt;
            }
            var scanDir = new File(outputRoot, scanId);
            var framesDir = new File(scanDir, 'frames');
            framesDir.mkdirs();

            var manifestFile = new File(scanDir, 'manifest.jsonl');
            var manifest = new FileWriter(manifestFile);
            var frameIndex = 0;
            var totalFrames = 0;
            for (var trayCountIndex = 0; trayCountIndex < activeScanTrays.length; trayCountIndex++) {
                totalFrames += scanFrameCountForTray(activeScanTrays[trayCountIndex], xStepMm, yStepMm);
            }
            var reviewTargetsBeforePick = true;
            var stopAtFirstTarget = touchDryRunFile.exists() && !reviewTargetsBeforePick;
            var stopAfterFirstTarget = false;
            var interactiveState = null;

        print('Starting Top camera scan: ' + scanId);
        if (plateContexts.length > 1) {
            for (var scanPlateContextIndex = 0; scanPlateContextIndex < plateContexts.length; scanPlateContextIndex++) {
                var scanPlateContext = plateContexts[scanPlateContextIndex];
                print('Plate slot ' + scanPlateContext.plateSlot
                    + ' will fill open wells starting at ' + scanPlateContext.startWell
                    + ' for plate ' + scanPlateContext.plateNumber
                    + ' collection ' + scanPlateContext.collectionCode + '.');
            }
        }
        else {
            print('This scan will fill wells: ' + pendingWellQueue.map(function(wellIndex) {
                return wellNameForIndex(Number(wellIndex));
            }).join(', '));
        }
        print('Frames directory: ' + framesDir.getAbsolutePath());
        print('Scanning ' + activeScanTrays.length + ' sorting tray(s).');
        print('Scan overlap step: X step=' + xStepMm.toFixed(3)
            + ' Y step=' + yStepMm.toFixed(3));
        print('Grid total: ' + totalFrames + ' frame(s) across enabled tray(s).');
        print('Training tray calibration source: ' + calibration.source);
        print('Scan bounds are camera coordinates: ' + calibration.scanBoundsAreCameraCoordinates);
        print('Python for BugPicker helpers: ' + python);
        print('Stop at first detected target: ' + stopAtFirstTarget);
        print('Camera X compensation: ' + cameraXOffsetMm.toFixed(3) + ' mm');
        print('Camera Y compensation: +' + cameraYOffsetMm.toFixed(3) + ' mm');
        print('Cooperative pause flag: ' + pauseFile.getAbsolutePath());
        print('Cooperative halt flag: ' + stopFile.getAbsolutePath());
        print('Pick dry run flag: ' + pickDryRunFile.getAbsolutePath()
            + ' exists=' + pickDryRunFile.exists());
        print('Touch dry run flag: ' + touchDryRunFile.getAbsolutePath()
            + ' exists=' + touchDryRunFile.exists());
        print('Interactive pick flag: ' + interactivePickFile.getAbsolutePath()
            + ' exists=' + interactivePickFile.exists());
        writeStatus(
            statusFile,
            'running',
            scanId,
            frameIndex,
            totalFrames,
            reviewTargetsBeforePick
                ? 'Scan started with interactive pick review enabled'
                : touchDryRunFile.exists()
                ? 'Scan started with touch dry run enabled'
                : 'Scan started'
        );
        writeText(detectionStatusFile, JSON.stringify({
            status: 'scan_running',
            scan_dir: scanDir.getPath(),
            scan_id: scanId,
            preview_file: null,
            message: 'New scan is running; no current detection preview yet',
            updated_at: new Date().toISOString()
        }, null, 2) + '\n');
        var segmentationProcess = launchSegmentation(scanDir, controlDir);

        var cameraLocation = camera.getLocation();
        var unitsPerPixel = getUnitsPerPixelForCurrentZ(camera);
        var firstTray = activeScanTrays[0];
        var firstXs = positions(
            Math.min(firstTray.xLeft, firstTray.xRight),
            Math.max(firstTray.xLeft, firstTray.xRight),
            xStepMm,
            false
        );
        var firstYs = positions(
            Math.min(firstTray.yTop, firstTray.yBottom),
            Math.max(firstTray.yTop, firstTray.yBottom),
            yStepMm,
            false
        );
        var firstCommandedX = calibration.scanBoundsAreCameraCoordinates ? firstXs[0] : firstXs[0] + cameraXOffsetMm;
        var firstCommandedY = calibration.scanBoundsAreCameraCoordinates ? firstYs[0] : firstYs[0] + cameraYOffsetMm;
        print('Top camera location at scan start: ' + formatLocation(cameraLocation));
        print('First requested scan coordinate is tray ' + firstTray.traySlot
            + ' X=' + firstXs[0].toFixed(3) + ' Y=' + firstYs[0].toFixed(3));
        print('First commanded camera target will be X=' + firstCommandedX.toFixed(3)
            + ' Y=' + firstCommandedY.toFixed(3));

        var halted = false;
        try {
            for (var trayScanIndex = 0; trayScanIndex < activeScanTrays.length; trayScanIndex++) {
                var scanTray = activeScanTrays[trayScanIndex];
                var trayXStart = Math.min(scanTray.xLeft, scanTray.xRight);
                var trayXEnd = Math.max(scanTray.xLeft, scanTray.xRight);
                var trayYStart = Math.min(scanTray.yTop, scanTray.yBottom);
                var trayYEnd = Math.max(scanTray.yTop, scanTray.yBottom);
                var xs = positions(trayXStart, trayXEnd, xStepMm, false);
                var ys = positions(trayYStart, trayYEnd, yStepMm, false);
                var currentScanContext = {
                    sorting_tray_slot: scanTray.traySlot,
                    collection_event_slot: scanTray.collectionEventSlot,
                    plate_slot: scanTray.plateSlot,
                    recovery_slot: scanTray.recoverySlot,
                    tray_height_mm: scanTray.trayHeightMm,
                    tray_pick_z_mm: scanTray.pickZMm,
                    tray_size_class: scanTray.sizeClass
                };
                print('Scanning sorting tray ' + scanTray.traySlot
                    + ' for event ' + scanTray.collectionEventSlot
                    + ': X=' + trayXStart.toFixed(3) + '..' + trayXEnd.toFixed(3)
                    + ' Y=' + trayYStart.toFixed(3) + '..' + trayYEnd.toFixed(3)
                    + ' grid=' + xs.length + 'x' + ys.length
                    + ' pickZ=' + scanTray.pickZMm.toFixed(3));
                for (var row = 0; row < ys.length; row++) {
                    var leftToRight = (row % 2) === 0;

                    for (var col = 0; col < xs.length; col++) {
                        if (!waitWhilePaused(pauseFile, stopFile, statusFile, scanId, frameIndex, totalFrames)
                                || haltRequested(stopFile, statusFile, scanId, frameIndex, totalFrames)) {
                            halted = true;
                            return;
                        }

                        var scanX = leftToRight ? xs[col] : xs[xs.length - 1 - col];
                        var scanY = ys[row];
                        var x = calibration.scanBoundsAreCameraCoordinates ? scanX : scanX + cameraXOffsetMm;
                        var y = calibration.scanBoundsAreCameraCoordinates ? scanY : scanY + cameraYOffsetMm;
                        var requestedX = calibration.scanBoundsAreCameraCoordinates ? scanX - cameraXOffsetMm : scanX;
                        var requestedY = calibration.scanBoundsAreCameraCoordinates ? scanY - cameraYOffsetMm : scanY;
                        var currentCameraLocation = camera.getLocation();
                        var location = currentCameraLocation.add(new Location(
                            LengthUnit.Millimeters,
                            x - currentCameraLocation.x,
                            y - currentCameraLocation.y,
                            0,
                            0
                        ));

                        print('Moving Top camera to frame ' + frameIndex
                            + ' tray ' + scanTray.traySlot
                            + ' target X=' + x.toFixed(3)
                            + ' Y=' + y.toFixed(3)
                            + ' requested X=' + requestedX.toFixed(3)
                            + ' Y=' + requestedY.toFixed(3));
                        camera.moveTo(location);
                        print('Top camera after move: ' + formatLocation(camera.getLocation()));
                        var image = camera.settleAndCapture();
                        var fileName = 'frame_' + pad(frameIndex, 5)
                            + '_' + timestamp()
                            + '_x' + x.toFixed(2)
                            + '_y' + y.toFixed(2)
                            + '.png';
                        var imageFile = new File(framesDir, fileName);

                        ImageIO.write(image, 'PNG', imageFile);
                        manifest.write(jsonLine(
                            frameIndex,
                            'frames/' + fileName,
                            x,
                            y,
                            requestedX,
                            requestedY,
                            image.getWidth(),
                            image.getHeight(),
                            unitsPerPixel,
                            currentScanContext
                        ));
                        manifest.flush();

                        print('Captured ' + fileName);
                        frameIndex++;
                        writeStatus(statusFile, 'running', scanId, frameIndex, totalFrames, 'Captured ' + fileName);

                        if (stopAtFirstTarget && waitForTargetCount(scanDir, 1, 2500)) {
                            stopAfterFirstTarget = true;
                            print('First target detected after frame ' + (frameIndex - 1)
                                + '. Stopping scan early for touch dry-run diagnosis.');
                            writeStatus(
                                statusFile,
                                'scan_complete',
                                scanId,
                                frameIndex,
                                frameIndex,
                                'First target detected; stopping scan early for touch dry run'
                            );
                            break;
                        }

                    }

                    if (stopAfterFirstTarget) {
                        break;
                    }
                }
                if (stopAfterFirstTarget) {
                    break;
                }
            }
        }
        finally {
            manifest.close();
        }

        if (!halted) {
            if (!stopAfterFirstTarget) {
                writeStatus(statusFile, 'scan_complete', scanId, frameIndex, totalFrames, 'Scan completed; waiting for target segmentation');
                print('Completed Top camera scan: ' + scanDir.getAbsolutePath());
            }
            if (waitForSegmentation(
                    scanDir,
                    120000,
                    stopFile,
                    statusFile,
                    scanId,
                    frameIndex,
                    totalFrames,
                    segmentationProcess,
                    controlDir
            )) {
                var emptyWells = [];
                var pickResult = null;
                var pickSequenceRan = false;
                var runSummaryShown = false;
                if (reviewTargetsBeforePick) {
                    print('Segmentation complete. Showing numbered detection summary.');
                    if (showDetectionSummaryAndConfirm(scanDir, statusFile, scanId, totalFrames)) {
                        print('Starting left nozzle N1 pick/drop sequence after summary confirmation.');
                        pickSequenceRan = true;
                        if (plateContexts.length > 1) {
                            pickResult = pickAndDropPlateContexts(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames, plateContexts);
                            emptyWells = [];
                        }
                        else {
                            pickResult = pickAndDropTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames, plateContext, pendingWellQueue);
                            emptyWells = pickResult.emptyWells;
                        }
                    }
                }
                else if (touchDryRunFile.exists()) {
                    print('Segmentation complete. Starting left nozzle N1 touch calibration sequence.');
                    touchTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames);
                }
                else {
                    print('Segmentation complete. Starting left nozzle N1 pick/drop sequence.');
                    pickSequenceRan = true;
                    if (plateContexts.length > 1) {
                        pickResult = pickAndDropPlateContexts(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames, plateContexts);
                        emptyWells = [];
                    }
                    else {
                        pickResult = pickAndDropTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames, plateContext, pendingWellQueue);
                        emptyWells = pickResult.emptyWells;
                    }
                }

	                if (plateContexts.length === 1
	                        && pickSequenceRan
	                        && !touchDryRunFile.exists()
	                        && !isPlateCompletelyFilled(plateContext.plateNumber)) {
                        var autoReplateEnabled = Boolean(
                            calibration.multiConfig
                                && calibration.multiConfig.shared
                                && calibration.multiConfig.shared.auto_replate
                        );
                        var canAutoReplate = autoReplateEnabled
                            && emptyWells.length > 0
                            && pickResult !== null
                            && pickResult.remainingTargets > 0;
                        var refillChoice;
                        if (canAutoReplate) {
                            refillChoice = {
                                wells: emptyWells.slice(0),
                                occupiedWells: [],
                                mode: 'continue_previous_scan'
                            };
                            print('Auto re-plate enabled: continuing the same scan with '
                                + pickResult.remainingTargets + ' unattempted target(s) for '
                                + emptyWells.length + ' empty well(s).');
                        }
                        else if (autoReplateEnabled) {
                            refillChoice = {
                                wells: [],
                                occupiedWells: [],
                                mode: 'cancel'
                            };
                            print('Auto re-plate finished: '
                                + (isPlateCompletelyFilled(plateContext.plateNumber)
                                    ? 'the plate is full.'
                                    : 'all detected targets from this scan have been attempted.'));
                        }
                        else {
	                        showPlatingRunSummary(
	                            scanDir,
	                            scanId,
	                            plateContexts,
	                            'Plating Run Summary',
	                            'Initial plating attempts completed. Review this summary before choosing whether to continue or rescan.'
	                        );
	                        runSummaryShown = true;
	                        var completionPlateStates = reviewExistingPlateWells(
	                            plateContext,
	                            'Review completed plating run',
	                            'Review plate ' + plateContext.plateNumber
	                                + ' after this run. Use the physical plate to verify the overall fill pattern.'
	                        );
	                        emptyWells = reconcileEmptyWellsFromPlateMap(
	                            plateContext,
	                            completionPlateStates,
	                            emptyWells
	                        );
	                        if (emptyWells.length === 0) {
	                            print('Plate map review confirmed all reviewed wells occupied; no refill review remains.');
	                        }
	                        else {
	                            print('Plate map review left ' + emptyWells.length + ' well(s) for detailed refill review: '
	                                + emptyWells.map(function(reviewWell) {
	                                    return reviewWell.name;
	                                }).join(', '));
	                        }
	                        refillChoice = promptRetryEmptyWells(
	                            emptyWells,
	                            pickResult === null ? 0 : pickResult.remainingTargets
                            );
                        }
                    recordManuallyConfirmedOccupiedWells(scanDir, plateContext, refillChoice.occupiedWells);
                    var refillWells = refillChoice.wells;
                    if (refillChoice.mode === 'manual_occupied_only') {
                        emptyWells = [];
                    }
                    if (refillWells.length > 0 && refillChoice.mode === 'continue_previous_scan') {
                        var sameScanTargetIndex = pickResult.nextTargetIndex;
                        pendingWellQueue = refillThenRemainingWellQueue(plateContext, refillWells, emptyWells);
                        print((autoReplateEnabled ? 'Auto re-plate' : 'User-requested same-scan refill')
                            + '; using remaining targets starting at target '
                            + (sameScanTargetIndex + 1) + ' for wells: '
                            + pendingWellQueue.map(function(wellIndex) {
                            return wellNameForIndex(Number(wellIndex));
                        }).join(', '));
                        var rescanRequestedAfterSameScan = false;
                        while (pendingWellQueue.length > 0 && sameScanTargetIndex < pickResult.targetsFound) {
                            var sameScanPickResult = pickAndDropTargets(
                                scanDir,
                                pauseFile,
                                stopFile,
                                statusFile,
                                scanId,
                                totalFrames,
                                plateContext,
                                pendingWellQueue,
                                sameScanTargetIndex
                            );
                            sameScanTargetIndex = sameScanPickResult.nextTargetIndex;
                            emptyWells = sameScanPickResult.emptyWells;
                            pickResult = sameScanPickResult;
                            if (emptyWells.length === 0) {
                                break;
                            }
                            if (autoReplateEnabled && pickResult.remainingTargets > 0) {
                                refillChoice = {
                                    wells: emptyWells.slice(0),
                                    occupiedWells: [],
                                    mode: 'continue_previous_scan'
                                };
                                print('Auto re-plate continuing with ' + pickResult.remainingTargets
                                    + ' unattempted target(s) for ' + emptyWells.length + ' empty well(s).');
                            }
                            else if (autoReplateEnabled) {
                                refillChoice = {
                                    wells: [],
                                    occupiedWells: [],
                                    mode: 'cancel'
                                };
                                print('Auto re-plate finished: all detected targets from this scan have been attempted.');
                            }
                            else {
                                refillChoice = promptRetryEmptyWells(emptyWells, pickResult.remainingTargets);
                            }
                            recordManuallyConfirmedOccupiedWells(scanDir, plateContext, refillChoice.occupiedWells);
                            refillWells = refillChoice.wells;
                            if (refillChoice.mode === 'manual_occupied_only') {
                                emptyWells = [];
                                break;
                            }
                            if (refillWells.length === 0) {
                                break;
                            }
	                            if (refillChoice.mode === 'rescan') {
	                                pendingWellQueue = refillThenRemainingWellQueue(plateContext, refillWells, emptyWells);
	                                refillAttempt++;
	                                print('User switched from same-scan refill to rescan; next queue is: '
	                                    + pendingWellQueue.map(function(wellIndex) {
	                                    return wellNameForIndex(Number(wellIndex));
	                                }).join(', '));
	                                rescanRequestedAfterSameScan = true;
	                                break;
	                            }
                            pendingWellQueue = refillThenRemainingWellQueue(plateContext, refillWells, emptyWells);
                            print('Continuing same-scan refill from target ' + (sameScanTargetIndex + 1)
                                + ' for wells: ' + pendingWellQueue.map(function(wellIndex) {
                                return wellNameForIndex(Number(wellIndex));
                            }).join(', '));
                        }
                        if (pendingWellQueue.length > 0
                                && rescanRequestedAfterSameScan) {
                            continue;
                        }
                    }
	                    else if (refillWells.length > 0 && refillChoice.mode === 'rescan') {
	                        pendingWellQueue = refillThenRemainingWellQueue(plateContext, refillWells, emptyWells);
	                        refillAttempt++;
	                        print('User requested refill attempt; next queue is missed wells first, then remaining open wells: '
	                            + pendingWellQueue.map(function(wellIndex) {
	                            return wellNameForIndex(Number(wellIndex));
	                        }).join(', '));
	                        continue;
	                    }
	                }
	                if (!pickSequenceRan && !touchDryRunFile.exists()) {
	                    var scanOnlySummary = scanTargetSummary(scanDir, scanId);
	                    writeText(new File(scanDir, 'run_success_summary.json'), JSON.stringify({
	                        scan_id: scanId || '',
	                        written_at: new Date().toISOString(),
	                        mode: 'scan_only_no_pick_attempts',
	                        detected_targets_before_review: scanOnlySummary.targetsFound,
	                        scan_size_bins: scanOnlySummary.sizeBins,
	                        plates: []
	                    }, null, 2) + '\n');
	                    JOptionPane.showMessageDialog(
	                        null,
	                        formatScanTargetSummary(scanOnlySummary),
	                        'Scan Summary',
	                        JOptionPane.INFORMATION_MESSAGE
	                    );
	                    runSummaryShown = true;
	                }
	                pendingWellQueue = [];
	                if (pickSequenceRan
                        && pickResult !== null
                        && pickResult.attemptedWells === 0
                        && pickResult.targetsFound === 0
                        && !touchDryRunFile.exists()) {
                    JOptionPane.showMessageDialog(
                        null,
                        'No pick targets were found after segmentation, so no wells were attempted for plate '
                            + plateContext.plateNumber + '.',
                        'No pick targets',
                        JOptionPane.INFORMATION_MESSAGE
                    );
                }
                if (emptyWells.length === 0
                        && pickSequenceRan
                        && pickResult !== null
                        && pickResult.attemptedWells > 0
                        && !touchDryRunFile.exists()) {
                    var completedAuditMessages = [];
                    var runSummaries = [];
                    var runSummaryMessages = [];
                    for (var auditIndex = 0; auditIndex < plateContexts.length; auditIndex++) {
                        var auditContext = plateContexts[auditIndex];
                        var runSummary = currentPlateRunSummary(auditContext, scanId);
                        runSummaries.push(runSummary);
                        runSummaryMessages.push(formatPlateRunSummary(runSummary));
                        if (isPlateCompletelyFilled(auditContext.plateNumber)) {
                            var auditReport = runCompletedPlateAudit(auditContext, scanId);
                            var taxonomyLaunched = false;
                            if (auditReport.passed) {
                                taxonomyLaunched = launchPlateTaxonomyClassifier(auditContext, scanId);
                            }
                            showCompletedPlateAuditDialog(auditReport, taxonomyLaunched);
                            var suspectCount = auditReport.suspect_occupied_wells === undefined
                                || auditReport.suspect_occupied_wells === null
                                ? 0
                                : auditReport.suspect_occupied_wells.length;
                            completedAuditMessages.push(
                                auditContext.plateNumber + ': '
                                    + (auditReport.passed ? 'audit passed' : 'audit needs review')
                                    + (auditReport.passed
                                        ? (taxonomyLaunched ? ', taxonomy launched' : ', taxonomy launch failed')
                                            + (suspectCount > 0
                                                ? ' (' + suspectCount + ' bottom-QA warning(s))'
                                                : '')
                                        : suspectCount > 0
                                        ? ' (' + suspectCount + ' bottom-QA warning(s); taxonomy not launched)'
                                        : ' (taxonomy not launched)')
                            );
                        }
                    }
                    writeRunSuccessSummary(scanDir, scanId, runSummaries);
                    runSummaryShown = true;
                    if (plateContexts.length > 1) {
                        JOptionPane.showMessageDialog(
                            null,
                            'Multi-plate run complete. Refill prompting is still single-plate only, so review both CSV files and wells before the next test.'
                                + (runSummaryMessages.length > 0
                                    ? '\n\nRun summary:\n' + runSummaryMessages.join('\n\n')
                                    : '')
                                + (completedAuditMessages.length > 0
                                    ? '\n\nCompleted plate audit: ' + completedAuditMessages.join('; ')
                                    : ''),
                            'Multi-plate run complete',
                            JOptionPane.INFORMATION_MESSAGE
                        );
                    }
                    else {
                        JOptionPane.showMessageDialog(
                            null,
                            'All attempted wells were confirmed occupied for plate ' + plateContext.plateNumber + '.'
                                + (runSummaryMessages.length > 0
                                    ? '\n\nRun summary:\n' + runSummaryMessages.join('\n\n')
                                    : '')
                                + (completedAuditMessages.length > 0
                                    ? '\n\nCompleted plate audit: ' + completedAuditMessages.join('; ')
                                    : ''),
                            'Plate run complete',
                            JOptionPane.INFORMATION_MESSAGE
                        );
                    }
                }
                if (!runSummaryShown
                        && pickSequenceRan
                        && pickResult !== null
                        && pickResult.attemptedWells > 0
                        && !touchDryRunFile.exists()) {
                    var finalRunSummaries = [];
                    var finalRunSummaryMessages = [];
                    for (var summaryIndex = 0; summaryIndex < plateContexts.length; summaryIndex++) {
                        var summaryContext = plateContexts[summaryIndex];
                        var finalRunSummary = currentPlateRunSummary(summaryContext, scanId);
                        finalRunSummaries.push(finalRunSummary);
                        finalRunSummaryMessages.push(formatPlateRunSummary(finalRunSummary));
                    }
                    writeRunSuccessSummary(scanDir, scanId, finalRunSummaries);
                    JOptionPane.showMessageDialog(
                        null,
                        'Plating run ended with wells still needing review or refill.'
                            + '\n\nRun summary:\n' + finalRunSummaryMessages.join('\n\n'),
                        'Plating Run Summary',
                        JOptionPane.INFORMATION_MESSAGE
                    );
                }
                if (pickSequenceRan && pickResult !== null && !touchDryRunFile.exists()) {
                    writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan and pick/drop sequence completed');
                }
            }
        }
        break;
        }
    });
}
