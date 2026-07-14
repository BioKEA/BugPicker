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
    var localPython = new File(projectDir, '.venv/bin/python');
    var previousPython = new File('/home/sean/Documents/OpenInvert-PnP/.venv/bin/python');
    var python = localPython.exists()
        ? localPython.getAbsolutePath()
        : previousPython.exists()
        ? previousPython.getAbsolutePath()
        : 'python3';
    var currentCoordinateTransformVersion = 'image_y_inverted_v2';

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

    function jsonLine(frameIndex, fileName, x, y, requestedX, requestedY, width, height, unitsPerPixel) {
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
            plateWellPitchMm: 9.0
        };
    }

    function loadTrainingTrayCalibration(defaults) {
        var localCalibrationFile = new File(scriptsDir, 'training_tray_calibration.json');
        var controlCalibrationFile = new File(projectDir, 'control/training_tray_calibration.json');
        var calibrationFile = localCalibrationFile.exists() ? localCalibrationFile : controlCalibrationFile;
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
        calibration.plateWellPitchMm = readNumber(record, 'plate_well_pitch_mm', calibration.plateWellPitchMm);
        calibration.source = calibrationFile.getAbsolutePath();
        return calibration;
    }

    function trainingTrayCalibrationFile() {
        return new File(scriptsDir, 'training_tray_calibration.json');
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
            plate_well_pitch_mm: calibration.plateWellPitchMm
        };
        var file = trainingTrayCalibrationFile();
        writeText(file, JSON.stringify(record, null, 2) + '\n');
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

    function commandPickerToPlateA1(nozzle, xField, yField, calibrationTravelZ) {
        if (nozzle === null) {
            throw new Error('Picker nozzle is not available.');
        }
        var x = numberFieldValue(xField, 'plate_a1_x_mm');
        var y = numberFieldValue(yField, 'plate_a1_y_mm');
        var travelZ = Number(calibrationTravelZ);
        var dropZ = -33.5;
        print('Moving picker to plate A1 candidate X=' + x.toFixed(3)
            + ' Y=' + y.toFixed(3)
            + ' at current travel Z=' + travelZ.toFixed(3)
            + ', then drop Z=' + dropZ.toFixed(3));
        raisePickerToCalibrationTravelZ(nozzle, travelZ, 'plate A1 calibration move');
        moveNozzleToXyAtZ(nozzle, x, y, travelZ);
        warnDualNozzleZClearance(dropZ, 'plate A1 calibration descent');
        moveNozzleToXyAtZ(nozzle, x, y, dropZ);
        print('Picker after plate A1 move: ' + formatLocation(nozzle.location));
    }

    function promptForTrainingTrayBounds(calibration, camera, nozzle) {
        var calibrationTravelZ = nozzle === null ? null : Number(nozzle.location.z);
        while (true) {
            var ActionListener = Packages.java.awt.event.ActionListener;
            var JComboBox = Packages.javax.swing.JComboBox;
            var DefaultComboBoxModel = Packages.javax.swing.DefaultComboBoxModel;
            var panel = new JPanel(new GridLayout(3, 2, 12, 6));
            var startPanel = new JPanel(new GridLayout(0, 2, 8, 6));
            var endPanel = new JPanel(new GridLayout(0, 2, 8, 6));
            var heightPanel = new JPanel(new GridLayout(0, 2, 8, 6));
            var platePanel = new JPanel(new GridLayout(0, 2, 8, 6));
            var runPanel = new JPanel(new GridLayout(0, 2, 8, 6));
            var xLeftField = new JTextField(calibration.xLeft.toFixed(3), 10);
            var xRightField = new JTextField(calibration.xRight.toFixed(3), 10);
            var yTopField = new JTextField(calibration.yTop.toFixed(3), 10);
            var yBottomField = new JTextField(calibration.yBottom.toFixed(3), 10);
            var plateA1XField = new JTextField(Number(calibration.plateA1X).toFixed(3), 10);
            var plateA1YField = new JTextField(Number(calibration.plateA1Y).toFixed(3), 10);
            var platePitchField = new JTextField(Number(calibration.plateWellPitchMm).toFixed(3), 10);
            var startWellField = new JTextField('A1', 10);
            var plateNumberField = new JTextField('AA0001', 10);
            var collectionCodeField = new JTextField('', 10);
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

            startPanel.setBorder(BorderFactory.createTitledBorder('Starting position'));
            startPanel.add(new JLabel('X (x_left_mm)'));
            startPanel.add(xLeftField);
            startPanel.add(new JLabel('Y (y_top_mm)'));
            startPanel.add(yTopField);
            startPanel.add(new JLabel(''));
            startPanel.add(startMoveButton);

            endPanel.setBorder(BorderFactory.createTitledBorder('Ending position'));
            endPanel.add(new JLabel('X (x_right_mm)'));
            endPanel.add(xRightField);
            endPanel.add(new JLabel('Y (y_bottom_mm)'));
            endPanel.add(yBottomField);
            endPanel.add(new JLabel(''));
            endPanel.add(endMoveButton);

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
            platePanel.add(new JLabel('A1 X mm'));
            platePanel.add(plateA1XField);
            platePanel.add(new JLabel('A1 Y mm'));
            platePanel.add(plateA1YField);
            platePanel.add(new JLabel('Well pitch mm'));
            platePanel.add(platePitchField);
            platePanel.add(new JLabel(''));
            platePanel.add(plateA1MoveButton);

            runPanel.setBorder(BorderFactory.createTitledBorder('Plating run'));
            runPanel.add(new JLabel('Begin plating in well'));
            runPanel.add(startWellField);
            runPanel.add(new JLabel('Plate number'));
            runPanel.add(plateNumberField);
            runPanel.add(new JLabel('Collection code'));
            runPanel.add(collectionCodeField);

            plateNumberField.addActionListener(new ActionListener({
                actionPerformed: function(event) {
                    try {
                        var normalized = normalizePlateNumber(plateNumberField.getText());
                        plateNumberField.setText(normalized);
                    }
                    catch (error) {
                        JOptionPane.showMessageDialog(
                            null,
                            String(error.message || error),
                            'Invalid plate number',
                            JOptionPane.ERROR_MESSAGE
                        );
                    }
                }
            }));

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

            panel.add(startPanel);
            panel.add(endPanel);
            panel.add(heightPanel);
            panel.add(platePanel);
            panel.add(runPanel);

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
                var updated = {
                    xLeft: numberFieldValue(xLeftField, 'x_left_mm'),
                    xRight: numberFieldValue(xRightField, 'x_right_mm'),
                    yTop: numberFieldValue(yTopField, 'y_top_mm'),
                    yBottom: numberFieldValue(yBottomField, 'y_bottom_mm'),
                    cameraXOffsetMm: calibration.cameraXOffsetMm,
                    cameraYOffsetMm: calibration.cameraYOffsetMm,
                    scanBoundsAreCameraCoordinates: calibration.scanBoundsAreCameraCoordinates,
                    xStepMm: calibration.xStepMm,
                    yStepMm: calibration.yStepMm,
                    trayHeightMm: numberFieldValue(trayHeightField, 'tray_height_mm'),
                    sizeClass: String(sizeClassField.getText()).trim(),
                    pickZMm: numberFieldValue(pickZField, 'pick_z_mm'),
                    plateA1X: numberFieldValue(plateA1XField, 'plate_a1_x_mm'),
                    plateA1Y: numberFieldValue(plateA1YField, 'plate_a1_y_mm'),
                    plateWellPitchMm: numberFieldValue(platePitchField, 'plate_well_pitch_mm'),
                    source: calibration.source
                };
                var plateNumber = normalizePlateNumber(plateNumberField.getText());
                var startWell = normalizeWellName(startWellField.getText());
                var plateId = 'P-' + plateNumber;
                var collectionCode = String(collectionCodeField.getText()).trim();

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

                if (plateCsvFile(plateNumber).exists()) {
                    var continueResult = JOptionPane.showConfirmDialog(
                        null,
                        'A spreadsheet already exists for plate ' + plateNumber
                            + '. Continue plating onto this existing plate and editing its CSV?',
                        'Existing plate warning',
                        JOptionPane.YES_NO_OPTION,
                        JOptionPane.WARNING_MESSAGE
                    );
                    if (continueResult !== JOptionPane.YES_OPTION) {
                        throw new Error('Choose a new plate number or confirm that this is an existing plate.');
                    }
                }
                writeTrainingTrayCalibration(updated);
                updated.plateContext = {
                    plateNumber: plateNumber,
                    plateId: plateId,
                    collectionCode: collectionCode,
                    startWell: startWell
                };
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

    function plateCsvFile(plateNumber) {
        return new File(plateSpreadsheetRoot(), normalizePlateNumber(plateNumber) + '.csv');
    }

    function plateCsvHeaders() {
        return [
            'no.',
            'Plate number',
            'Plate ID',
            'Well Number',
            'Extract ID',
            'Collection Code',
            'Image Code',
            'Order',
            'Current Status',
            'DNA concentration (ng/\u00b5l)',
            'Extract volume (\u00b5l)',
            'quantified volume',
            'Vol remaining',
            'Gel Results',
            'COI, ONT Sequencing Results',
            'Link to ELN PCR page'
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

    function readPlateRows(plateNumber) {
        var file = plateCsvFile(plateNumber);
        var rows = [];
        if (!file.exists()) {
            return rows;
        }

        var reader = new BufferedReader(new FileReader(file));
        try {
            var line = reader.readLine();
            var first = true;
            while (line !== null) {
                if (first) {
                    first = false;
                }
                else if (String(line).trim().length > 0) {
                    rows.push(splitCsvLine(String(line)));
                }
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }
        return rows;
    }

    function occupiedWellSet(plateNumber) {
        var rows = readPlateRows(plateNumber);
        var occupied = {};
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].length >= 4 && rows[i][3]) {
                occupied[normalizeWellName(rows[i][3])] = true;
            }
        }
        return occupied;
    }

    function imageCodeForWell(plateNumber, wellName) {
        return 'IMG-DNA-' + normalizePlateNumber(plateNumber) + '-' + normalizeWellName(wellName);
    }

    function copyPlateWellImage(plateContext, well, sourceImageFile) {
        if (sourceImageFile === null || sourceImageFile === undefined || !sourceImageFile.exists()) {
            return null;
        }
        var imageCode = imageCodeForWell(plateContext.plateNumber, well.name);
        var destination = new File(plateImageRoot(), imageCode + '.png');
        Packages.java.nio.file.Files.copy(
            sourceImageFile.toPath(),
            destination.toPath(),
            Packages.java.nio.file.StandardCopyOption.REPLACE_EXISTING
        );
        print('Copied plate well image to ' + destination.getAbsolutePath());
        return destination;
    }

    function ensurePlateSpreadsheetHeader(plateContext) {
        var file = plateCsvFile(plateContext.plateNumber);
        if (!file.exists()) {
            writeText(file, csvLine(plateCsvHeaders()));
            print('Created plate spreadsheet CSV: ' + file.getAbsolutePath());
        }
        return file;
    }

    function appendPlateSpreadsheetRow(plateContext, well) {
        var occupied = occupiedWellSet(plateContext.plateNumber);
        if (occupied[well.name]) {
            print('Plate spreadsheet already has well ' + well.name + '; not adding a duplicate row.');
            return;
        }
        var file = ensurePlateSpreadsheetHeader(plateContext);
        var nextNumber = readPlateRows(plateContext.plateNumber).length + 1;
        var plateNumber = normalizePlateNumber(plateContext.plateNumber);
        var row = [
            nextNumber,
            plateNumber,
            plateContext.plateId,
            well.name,
            'DNA-' + plateNumber + '-' + well.name,
            plateContext.collectionCode,
            imageCodeForWell(plateNumber, well.name),
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            ''
        ];
        appendText(file, csvLine(row));
        print('Recorded plated specimen in ' + file.getAbsolutePath() + ' well ' + well.name);
    }

    function wellQueueFromStart(plateContext) {
        var startIndex = wellIndexForName(plateContext.startWell);
        var occupied = occupiedWellSet(plateContext.plateNumber);
        var wells = [];
        for (var i = startIndex; i < 96; i++) {
            var name = wellNameForIndex(i);
            if (!occupied[name]) {
                wells.push(i);
            }
        }
        return wells;
    }

    function promptRetryEmptyWells(emptyWells) {
        if (!emptyWells || emptyWells.length === 0) {
            return [];
        }

        var panel = new JPanel(new BorderLayout(8, 8));
        var listPanel = new JPanel(new GridLayout(0, 1, 6, 6));
        var checkboxes = [];
        for (var i = 0; i < emptyWells.length; i++) {
            var row = new JPanel(new BorderLayout(6, 6));
            var checkbox = new JCheckBox(
                'Refill ' + emptyWells[i].name + ' - ' + String(emptyWells[i].reason || 'empty'),
                true
            );
            checkboxes.push(checkbox);
            row.add(checkbox, BorderLayout.NORTH);
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
            new JLabel('Review wells not confirmed occupied. Uncheck any well that already contains a specimen.'),
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
            return [];
        }

        var selectedWells = [];
        for (var selectedIndex = 0; selectedIndex < emptyWells.length; selectedIndex++) {
            if (checkboxes[selectedIndex].isSelected()) {
                selectedWells.push(emptyWells[selectedIndex]);
            }
        }
        return selectedWells;
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

        try {
            var builder = new Packages.java.lang.ProcessBuilder(
                python,
                segmentScript,
                scanDir.getAbsolutePath(),
                '--detector',
                detectorMode,
                '--watch'
            );
            builder.directory(projectDir);
            builder.redirectOutput(stdoutLog);
            builder.redirectError(stderrLog);
            builder.start();
            print('Launched ' + detectorMode + ' segmentation for: ' + scanDir.getAbsolutePath());
        }
        catch (error) {
            print('Failed to launch segmentation: ' + error);
            print('See: ' + stderrLog.getAbsolutePath());
        }
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
        var calibrationFile = new File(projectDir, 'control/touch_calibration.jsonl');
        var correction = {
            x: 0.0,
            y: 0.0,
            z: -44.7,
            source: 'none'
        };

        if (!calibrationFile.exists()) {
            return correction;
        }

        var sampleXs = [];
        var sampleYs = [];
        var legacySampleXs = [];
        var lastZ = correction.z;
        var lastRecordedAt = null;
        var fallbackCorrection = null;
        var reader = new BufferedReader(new FileReader(calibrationFile));
        try {
            var line = reader.readLine();
            while (line !== null) {
                line = String(line).trim();
                if (line.length > 0) {
                    try {
                        var record = JSON.parse(line);
                        if (record.raw_commanded_x_mm !== undefined
                                && record.raw_commanded_y_mm !== undefined
                                && record.recorded_x_mm !== undefined
                                && record.recorded_y_mm !== undefined) {
                            var sampleX = Number(record.recorded_x_mm) - Number(record.raw_commanded_x_mm);
                            var sampleY = Number(record.recorded_y_mm) - Number(record.raw_commanded_y_mm);
                            if (String(record.coordinate_transform_version || '') === currentCoordinateTransformVersion) {
                                sampleXs.push(sampleX);
                                sampleYs.push(sampleY);
                            }
                            else {
                                legacySampleXs.push(sampleX);
                            }
                            if (record.recorded_z_mm !== undefined) {
                                lastZ = Number(record.recorded_z_mm);
                            }
                            lastRecordedAt = record.recorded_at;
                        }
                        else if (record.total_correction_x_mm !== undefined
                                && record.total_correction_y_mm !== undefined) {
                            fallbackCorrection = {
                                x: Number(record.total_correction_x_mm),
                                y: Number(record.total_correction_y_mm),
                                source: 'latest total from ' + record.recorded_at
                            };
                            if (record.recorded_z_mm !== undefined) {
                                lastZ = Number(record.recorded_z_mm);
                            }
                        }
                        else if (record.correction_x_mm !== undefined
                                && record.correction_y_mm !== undefined) {
                            fallbackCorrection = {
                                x: Number(record.correction_x_mm),
                                y: Number(record.correction_y_mm),
                                source: 'legacy residual from ' + record.recorded_at
                            };
                            if (record.recorded_z_mm !== undefined) {
                                lastZ = Number(record.recorded_z_mm);
                            }
                        }
                    }
                    catch (parseError) {
                        print('Skipping unreadable touch calibration record: ' + parseError);
                    }
                }
                line = reader.readLine();
            }
        }
        finally {
            reader.close();
        }

        if (sampleXs.length > 0 && sampleYs.length > 0) {
            correction.x = medianNumber(sampleXs);
            correction.y = medianNumber(sampleYs);
            correction.z = lastZ;
            correction.source = 'median of ' + sampleXs.length + ' saved jog sample(s)'
                + (lastRecordedAt === null ? '' : '; latest ' + lastRecordedAt);
            return correction;
        }

        if (legacySampleXs.length > 0) {
            correction.x = medianNumber(legacySampleXs);
            correction.y = 0.0;
            correction.z = lastZ;
            correction.source = 'legacy X median of ' + legacySampleXs.length + ' sample(s); Y reset for '
                + currentCoordinateTransformVersion
                + (lastRecordedAt === null ? '' : '; latest ' + lastRecordedAt);
            return correction;
        }

        if (fallbackCorrection !== null) {
            correction.x = fallbackCorrection.x;
            correction.y = fallbackCorrection.y;
            correction.z = lastZ;
            correction.source = fallbackCorrection.source;
        }
        return correction;
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

    function writePickReviewDecisions(scanDir, scanId, targets, decisions, debrisSubtypes) {
        var file = reviewDecisionFile(scanDir);
        var writer = new FileWriter(file);
        try {
            for (var i = 0; i < targets.length; i++) {
                var target = targets[i];
                var decision = decisions[String(target.objectIndex)] || 'specimen';
                var debrisSubtype = decision === 'debris'
                    ? String(debrisSubtypes[String(target.objectIndex)] || 'uncertain')
                    : '';
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
                    detection_score: target.score,
                    detection_quality_score: targetQualityScore(target),
                    reviewed_at: new Date().toISOString()
                };
                writer.write(JSON.stringify(record) + '\n');
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
        var targets = readPickTargets(scanDir, true, true, false);
        targets.sort(function(a, b) {
            return Number(a.objectIndex) - Number(b.objectIndex);
        });
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
                var EmptyBorder = Packages.javax.swing.border.EmptyBorder;
                var ActionListener = Packages.java.awt.event.ActionListener;
                var WindowAdapter = Packages.java.awt.event.WindowAdapter;

                var frame = new JFrame('Detected Target Review');
                frame.setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);
                frame.setAlwaysOnTop(true);

                var panel = new JPanel(new BorderLayout(8, 8));
                panel.setBorder(new EmptyBorder(12, 12, 12, 12));

                var details = new JPanel(new GridLayout(0, 1, 2, 2));
                var objectCount = complete === null ? 0 : Number(complete.object_count || 0);
                var candidateCount = complete === null ? 0 : Number(complete.candidate_count || 0);
                var duplicateCount = complete === null ? 0 : Number(complete.duplicate_count || 0);
                details.add(new JLabel('Unique targets: ' + objectCount));
                details.add(new JLabel('Frame candidates: ' + candidateCount + '   Duplicates: ' + duplicateCount));
                panel.add(details, BorderLayout.NORTH);

                var centerPanel = new JPanel(new GridLayout(1, 2, 10, 0));
                var imageLabel = makeScaledImageLabel(summaryFile, ImageIcon, JLabel, Image, 520, 720);
                if (imageLabel !== null) {
                    centerPanel.add(new JScrollPane(imageLabel));
                }
                else {
                    centerPanel.add(new JLabel('No detection summary image found: ' + summaryFile.getAbsolutePath()));
                }

                var reviewPanel = new JPanel(new BorderLayout(6, 6));
                var targetLabel = new JLabel('');
                var zoomLabel = new JLabel('');
                zoomLabel.setHorizontalAlignment(JLabel.CENTER);
                var zoomScroll = new JScrollPane(zoomLabel);
                zoomScroll.setPreferredSize(new Dimension(640, 520));
                var specimenButton = new JRadioButton('pick - specimen');
                var debrisButton = new JRadioButton("don't pick - debris");
                var debrisSubtypeLabel = new JLabel('debris type');
                var debrisSubtypeModel = new DefaultComboBoxModel();
                debrisSubtypeModel.addElement('uncertain');
                debrisSubtypeModel.addElement('insect part');
                debrisSubtypeModel.addElement('plant debris');
                debrisSubtypeModel.addElement('non-insect specimen');
                debrisSubtypeModel.addElement('shadow/artifact');
                var debrisSubtypeBox = new JComboBox(debrisSubtypeModel);
                var selectionCountLabel = new JLabel('');
                var group = new ButtonGroup();
                group.add(specimenButton);
                group.add(debrisButton);
                var decisions = {};
                var debrisSubtypes = {};
                var currentIndex = 0;

                for (var targetIndex = 0; targetIndex < targets.length; targetIndex++) {
                    targets[targetIndex].reviewNumber = targetIndex + 1;
                    decisions[String(targets[targetIndex].objectIndex)] = 'specimen';
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
                    selectionCountLabel.setText('Initial targets: ' + targets.length
                        + '   Selected to pick: ' + selectedSpecimenCount()
                        + '   Unsafe close: ' + unsafeTargetCount());
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

                function showTarget(index) {
                    if (targets.length === 0) {
                        targetLabel.setText('No unique targets available.');
                        zoomLabel.setIcon(null);
                        specimenButton.setEnabled(false);
                        debrisButton.setEnabled(false);
                        debrisSubtypeLabel.setEnabled(false);
                        debrisSubtypeBox.setEnabled(false);
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
                    targetLabel.setText('Target ' + target.reviewNumber
                        + ' of ' + targets.length
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
                    var targetImage = imageFileForTarget(scanDir, target);
                    var icon = scaledIconForFile(targetImage, ImageIcon, Image, 620, 500);
                    if (icon !== null) {
                        zoomLabel.setText('');
                        zoomLabel.setIcon(icon);
                    }
                    else {
                        zoomLabel.setIcon(null);
                        zoomLabel.setText('No target image found for object ' + target.objectIndex);
                    }
                }

                var nav = new JPanel(new FlowLayout(FlowLayout.CENTER));
                var prevButton = new JButton('<');
                var nextButton = new JButton('>');
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
                nav.add(prevButton);
                nav.add(targetLabel);
                nav.add(nextButton);

                var choicePanel = new JPanel(new FlowLayout(FlowLayout.CENTER));
                choicePanel.add(specimenButton);
                choicePanel.add(debrisButton);
                choicePanel.add(debrisSubtypeLabel);
                choicePanel.add(debrisSubtypeBox);
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

                reviewPanel.add(nav, BorderLayout.NORTH);
                reviewPanel.add(zoomScroll, BorderLayout.CENTER);
                reviewPanel.add(choicePanel, BorderLayout.SOUTH);
                centerPanel.add(reviewPanel);
                panel.add(centerPanel, BorderLayout.CENTER);

                var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
                var startButton = new JButton('Start Picking');
                buttons.add(startButton);
                panel.add(buttons, BorderLayout.SOUTH);

                function startPicking() {
                    saveCurrentDecision();
                    writePickReviewDecisions(scanDir, scanId, targets, decisions, debrisSubtypes);
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
        moveNozzleToXyAtZ(nozzle, moveX, moveY, pickZ);
        Packages.java.lang.Thread.sleep(1000);
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

    function inspectPickedTargetOnBottomCamera(scanDir, scanId, target, targetIndex, totalTargets, nozzle, travelZ) {
        var bottomCamera = findCameraByName('Bottom');
        var inspectionZ = -75.0;
        var inspectionHome = bottomInspectionHomeLocation();
        var inspectionX = inspectionHome.x;
        var inspectionY = inspectionHome.y;
        var inspectionDir = new File(scanDir, 'bottom_inspections');
        inspectionDir.mkdirs();

        var imageName = 'target_' + pad(targetIndex + 1, 3)
            + '_object_' + pad(target.objectIndex, 6)
            + '_' + timestamp()
            + '_bottom.png';
        var imageFile = new File(inspectionDir, imageName);

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

        var image = bottomCamera.settleAndCapture();
        ImageIO.write(image, 'PNG', imageFile);
        print('Saved bottom-camera inspection image: ' + imageFile.getAbsolutePath());
        writeInspectionPreview(
            scanDir,
            scanId,
            target,
            targetIndex,
            totalTargets,
            imageFile,
            inspectionX,
            inspectionY,
            inspectionZ
        );
        moveNozzleToXyAtZ(nozzle, inspectionX, inspectionY, travelZ);
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

    function inspectPlacedWell(scanDir, scanId, target, targetIndex, totalTargets, statusFile, topCamera, well, touchCorrection) {
        var qaDir = new File(scanDir, 'qa/wells');
        qaDir.mkdirs();
        var cameraX = well.x - touchCorrection.x;
        var cameraY = well.y - touchCorrection.y;
        var beforeCameraLocation = topCamera.getLocation();
        var imageName = 'well_' + well.name
            + '_target_' + pad(targetIndex + 1, 3)
            + '_' + timestamp()
            + '_top.png';
        var imageFile = new File(qaDir, imageName);

        writeStatus(
            statusFile,
            'qa',
            scanId,
            targetIndex + 1,
            totalTargets,
            'Moving Top camera over well ' + well.name
                + ' after drop: camera X ' + cameraX.toFixed(3)
                + ', Y ' + cameraY.toFixed(3)
        );
        print('POST-DROP QA: moving Top camera to well ' + well.name
            + ' at camera X=' + cameraX.toFixed(3)
            + ' Y=' + cameraY.toFixed(3)
            + ' to inspect N1 drop point X=' + well.x.toFixed(3)
            + ' Y=' + well.y.toFixed(3)
            + ' using inverse pick correction dX=' + (-touchCorrection.x).toFixed(3)
            + ' dY=' + (-touchCorrection.y).toFixed(3)
            + ' from pick correction source=' + touchCorrection.source);
        print('POST-DROP QA: Top camera before move: ' + formatLocation(beforeCameraLocation)
            + ' delta X=' + (cameraX - beforeCameraLocation.x).toFixed(3)
            + ' delta Y=' + (cameraY - beforeCameraLocation.y).toFixed(3));
        moveCameraToXy(topCamera, cameraX, cameraY);
        print('POST-DROP QA: Top camera after move: ' + formatLocation(topCamera.getLocation()));
        var image = topCamera.settleAndCapture();
        ImageIO.write(image, 'PNG', imageFile);
        print('POST-DROP QA: saved well inspection image: ' + imageFile.getAbsolutePath());
        var result = runQaInspection(scanDir, imageFile, 'well', targetIndex);
        print('Well QA for ' + well.name
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
            imageFile,
            'Well QA ' + well.name + (result.well_empty ? ' | empty' : ' | occupied'),
            cameraX,
            cameraY,
            topCamera.getLocation().z,
            result
        );
        Packages.java.lang.Thread.sleep(1500);
        return result;
    }

    function inspectNozzleAfterEmptyWell(scanDir, scanId, target, targetIndex, totalTargets, nozzle, travelZ) {
        var imageFile = inspectPickedTargetOnBottomCamera(
            scanDir,
            scanId,
            target,
            targetIndex,
            totalTargets,
            nozzle,
            travelZ
        );
        var result = runQaInspection(scanDir, imageFile, 'nozzle', targetIndex);
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
            imageFile,
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

    function recoveryPlateWipeOnly(nozzle, vacuumActuator, travelZ, targetIndex, totalTargets, statusFile, scanId) {
        var recoveryWell = recoveryWellLocationForIndex(targetIndex);
        var wipeZ = -42.0;
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
            + ' at X=' + recoveryWell.x.toFixed(3)
            + ' Y=' + recoveryWell.y.toFixed(3)
            + ' travel Z=' + travelZ.toFixed(3)
            + ' wipe Z=' + wipeZ.toFixed(3));
        moveNozzleToXyAtZ(nozzle, recoveryWell.x, recoveryWell.y, travelZ);
        print('Turning vacuum off before recovery wipe descent so stuck specimens can fall onto the kim wipe.');
        setVacuum(vacuumActuator, false);
        warnDualNozzleZClearance(wipeZ, 'recovery plate descent');
        moveNozzleToXyAtZ(nozzle, recoveryWell.x, recoveryWell.y, wipeZ);
        recoveryPlateWipeRotation(nozzle, recoveryWell, wipeZ);
        moveNozzleToXyAtZ(nozzle, recoveryWell.x, recoveryWell.y, travelZ);
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

    function waitForSegmentation(scanDir, timeoutMs) {
        var completeFile = new File(scanDir, 'segmentation_complete.json');
        var start = new Date().getTime();
        while (!completeFile.exists()) {
            if ((new Date().getTime() - start) > timeoutMs) {
                print('Timed out waiting for segmentation: ' + completeFile.getAbsolutePath());
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
                        var pickX = record.pick_x_mm !== undefined ? record.pick_x_mm : record.estimated_x_mm;
                        var pickY = record.pick_y_mm !== undefined ? record.pick_y_mm : record.estimated_y_mm;
                        if (pickX !== undefined && pickY !== undefined) {
                            var objectIndex = record.object_index;
                            var decision = decisions[String(objectIndex)];
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
                                targets.push(makePickTarget(record, pickX, pickY, decision, false));
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
        markUnsafeMergedFootprints(targets);
        if (!includeUnsafe) {
            targets = filterUnsafeTargets(targets, quiet);
        }
        targets.sort(function(a, b) {
            if (a.y === b.y) {
                return a.x - b.x;
            }
            return a.y - b.y;
        });
        return targets;
    }

    function makePickTarget(record, pickX, pickY, decision, recoveredDuplicate) {
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
            frameIndex: Number(record.frame_index || 0),
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
                            var pickX = record.pick_x_mm !== undefined ? record.pick_x_mm : record.estimated_x_mm;
                            var pickY = record.pick_y_mm !== undefined ? record.pick_y_mm : record.estimated_y_mm;
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
                                    targets.push(makePickTarget(record, pickX, pickY, decision, true));
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
                        var pickX = record.pick_x_mm !== undefined ? record.pick_x_mm : record.estimated_x_mm;
                        var pickY = record.pick_y_mm !== undefined ? record.pick_y_mm : record.estimated_y_mm;
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

    function wellLocationForIndex(index) {
        if (index < 0 || index >= 96) {
            throw new Error('96-well plate only has room for 96 targets; requested well index ' + index);
        }

        var calibration = loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        var a1X = Number(calibration.plateA1X);
        var a1Y = Number(calibration.plateA1Y);
        var wellPitch = Number(calibration.plateWellPitchMm);
        var rowIndex = Math.floor(index / 12);
        var columnIndex = index % 12;

        return {
            name: wellNameForIndex(index),
            x: a1X + (wellPitch * rowIndex),
            y: a1Y + (wellPitch * columnIndex)
        };
    }

    function recoveryWellLocationForIndex(index) {
        if (index < 0 || index >= 96) {
            throw new Error('Recovery plate only has room for 96 targets; requested well index ' + index);
        }

        var calibration = loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        var a1X = 93.0;
        var a1Y = 287.0;
        var wellPitch = Number(calibration.plateWellPitchMm);
        var rowIndex = Math.floor(index / 12);
        var columnIndex = index % 12;

        return {
            name: wellNameForIndex(index),
            x: a1X + (wellPitch * rowIndex),
            y: a1Y + (wellPitch * columnIndex)
        };
    }

    function pickAndDropTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames, plateContext, wellQueue) {
        var pickHeadName = 'H1';
        var pickNozzleName = 'N1';
        var pickNozzleLabel = 'left nozzle N1';
        var dryRunFile = new File(projectDir, 'control/pick_dry_run.flag');
        var dryRun = dryRunFile.exists();
        var pickTool = findPickTool(pickHeadName, pickNozzleName);
        var nozzle = pickTool.nozzle;
        var vacuumActuator = findVacuumActuator(pickTool.head, nozzle);
        var topCamera = findCameraByName('Top');
        var travelZ = nozzle.location.z;
        var touchCorrection = readTouchCorrection();
        var trayCalibration = loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        var pickZ = Number(trayCalibration.pickZMm);
        var dropZ = -33.5;
        var targets = readPickTargets(scanDir, false, false, false, true);
        var availableWells = wellQueue || wellQueueFromStart(plateContext);
        var targetLimit = Math.min(targets.length, availableWells.length);
        var emptyWells = [];

        print('Pick sequence has ' + targets.length + ' unique target(s).');
        print('Plate context: plate=' + plateContext.plateNumber
            + ' plate_id=' + plateContext.plateId
            + ' collection=' + plateContext.collectionCode
            + ' available wells=' + availableWells.length
            + ' target limit=' + targetLimit);
        print('Pick tool is ' + pickNozzleLabel + ' on head ' + pickHeadName
            + '; travel Z for XY moves: ' + travelZ.toFixed(3));
        print('Pick correction: dX=' + touchCorrection.x.toFixed(3)
            + ' dY=' + touchCorrection.y.toFixed(3)
            + ' source=' + touchCorrection.source);
        print('Tray height preset: ' + Number(trayCalibration.trayHeightMm).toFixed(3)
            + ' mm; size class=' + trayCalibration.sizeClass
            + '; N1 pick Z=' + pickZ.toFixed(3)
            + '; source=' + trayCalibration.source);
        print('Dual-nozzle Z prediction: N1 pick Z=' + pickZ.toFixed(3)
            + ' would put N2 at Z=' + n2ZWhenN1Z(pickZ).toFixed(3));
        print('N1 drop Z=' + dropZ.toFixed(3));
        if (dryRun) {
            print('Pick dry run flag is present: ' + dryRunFile.getAbsolutePath());
        }
        if (targets.length === 0) {
            parkPickerAtBottomInspectionHome(nozzle, travelZ);
            writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan completed; no pick targets found');
            return emptyWells;
        }
        if (targetLimit === 0) {
            parkPickerAtBottomInspectionHome(nozzle, travelZ);
            writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan completed; no wells available to fill');
            return emptyWells;
        }
        if (targets.length > availableWells.length) {
            print('Found ' + targets.length + ' pick targets but only ' + availableWells.length
                + ' wells are available; only the first ' + targetLimit + ' target(s) will be plated.');
        }

        for (var i = 0; i < targetLimit; i++) {
            if (!waitWhilePaused(pauseFile, stopFile, statusFile, scanId, i, targets.length)
                    || haltRequested(stopFile, statusFile, scanId, i, targets.length)) {
                print('Halt requested during pick sequence. Stopping before target ' + (i + 1) + '.');
                return emptyWells;
            }

            var target = targets[i];
            var moveX = target.x + touchCorrection.x;
            var moveY = target.y + touchCorrection.y;
            var well = wellLocationForIndex(Number(availableWells[i]));
            writePickingPreview(scanDir, scanId, target, i, targetLimit, moveX, moveY);
            writeStatus(
                statusFile,
                'picking',
                scanId,
                i + 1,
                targetLimit,
                'Picking target ' + (i + 1) + ' for well ' + well.name
                    + ' at X ' + moveX.toFixed(3) + ', Y ' + moveY.toFixed(3)
            );

            debugPickTarget(scanDir, target, nozzle, travelZ, dryRun, touchCorrection, moveX, moveY);
            if (dryRun) {
                writeStatus(statusFile, 'paused', scanId, i + 1, targetLimit, 'Dry run stopped above first pick target');
                return emptyWells;
            }

            print('Moving ' + pickNozzleLabel + ' above object ' + target.objectIndex
                + ' using corrected scan coordinates X=' + moveX.toFixed(3)
                + ' Y=' + moveY.toFixed(3)
                + ' at travel Z=' + travelZ.toFixed(3));
            moveNozzleToXyAtZ(nozzle, moveX, moveY, travelZ);

            print('Starting assumed-success net-tray pick for object ' + target.objectIndex
                + ' at X=' + moveX.toFixed(3)
                + ' Y=' + moveY.toFixed(3)
                + ' Z=' + pickZ.toFixed(3));
            pickAssumingSuccess(
                scanDir,
                target,
                nozzle,
                vacuumActuator,
                moveX,
                moveY,
                pickZ,
                i,
                scanId,
                targetLimit
            );
            moveNozzleToXyAtZ(nozzle, moveX, moveY, travelZ);

            var bottomInspectionImage = inspectPickedTargetOnBottomCamera(
                scanDir,
                scanId,
                target,
                i,
                targetLimit,
                nozzle,
                travelZ
            );
            var nozzleQa = runQaInspection(scanDir, bottomInspectionImage, 'nozzle', i);
            print('Bottom-camera nozzle QA for target ' + (i + 1)
                + ': bug_present=' + nozzleQa.bug_present
                + ' possible_multiple=' + nozzleQa.possible_multiple
                + ' component_count=' + nozzleQa.component_count
                + ' largest_area_px=' + Number(nozzleQa.largest_area_px || 0).toFixed(1)
                + ' dark_fraction=' + Number(nozzleQa.dark_fraction || 0).toFixed(5));
            if (!nozzleQa.bug_present || nozzleQa.possible_multiple) {
                writeStatus(
                    statusFile,
                    'qa',
                    scanId,
                    i + 1,
                    targetLimit,
                    'Skipping well drop for target ' + (i + 1)
                        + ': bottom camera '
                        + (!nozzleQa.bug_present ? 'did not confirm a specimen' : 'saw possible multiple specimens')
                );
                print('Skipping well drop for target ' + (i + 1)
                    + ' object ' + target.objectIndex
                    + ' based on bottom-camera nozzle QA.');
                recoveryPlateWipeOnly(
                    nozzle,
                    vacuumActuator,
                    travelZ,
                    i,
                    targetLimit,
                    statusFile,
                    scanId
                );
                emptyWells.push({
                    index: Number(availableWells[i]),
                    name: well.name,
                    imageFile: null,
                    reason: !nozzleQa.bug_present ? 'no specimen on nozzle' : 'possible multiple specimens on nozzle'
                });
                continue;
            }

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
                i + 1,
                targetLimit,
                'Checking well ' + well.name + ' after placing target ' + (i + 1)
            );
            var wellQa = inspectPlacedWell(
                scanDir,
                scanId,
                target,
                i,
                targetLimit,
                statusFile,
                topCamera,
                well,
                touchCorrection
            );
            var wellImageFile = new File(String(wellQa.image || ''));
            copyPlateWellImage(plateContext, well, wellImageFile);
            if (wellQa.well_empty) {
                emptyWells.push({
                    index: Number(availableWells[i]),
                    name: well.name,
                    imageFile: wellImageFile,
                    reason: 'QA well empty'
                });
                writeStatus(
                    statusFile,
                    'qa',
                    scanId,
                    i + 1,
                    targetLimit,
                    'Well ' + well.name + ' appears empty; moving to recovery plate'
                );
            }
            else {
                appendPlateSpreadsheetRow(plateContext, well);
            }
            recoveryPlateWipeOnly(
                nozzle,
                vacuumActuator,
                travelZ,
                i,
                targetLimit,
                statusFile,
                scanId
            );
        }

        parkPickerAtBottomInspectionHome(nozzle, travelZ);
        writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan and pick/drop sequence completed');
        return emptyWells;
    }

    task(function() {
        var camera = machine.defaultHead.defaultCamera;
        if (camera.getName() !== 'Top') {
            camera = findCameraByName('Top');
        }
        parkNozzlesForScan(machine.defaultHead);
        var calibrationPickTool = findPickTool('H1', 'N1');

        var calibration = loadTrainingTrayCalibration(defaultTrainingTrayCalibrationValues());
        calibration = promptForTrainingTrayBounds(calibration, camera, calibrationPickTool.nozzle);
        print('Calibration dialog accepted; raising nozzles back to safe travel height before scan.');
        parkNozzlesForScan(machine.defaultHead);
        var xLeft = calibration.xLeft;
        var xRight = calibration.xRight;
        var yTop = calibration.yTop;
        var fullYBottom = calibration.yBottom;
        var yBottom = fullYBottom;
        var cameraXOffsetMm = calibration.cameraXOffsetMm;
        var cameraYOffsetMm = calibration.cameraYOffsetMm;
        var xStepMm = calibration.xStepMm;
        var yStepMm = calibration.yStepMm;
        var plateContext = calibration.plateContext;
        ensurePlateSpreadsheetHeader(plateContext);

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
        launchHaltGui(controlDir);

        var pendingWellQueue = wellQueueFromStart(plateContext);
        var refillAttempt = 0;
        if (pendingWellQueue.length === 0) {
            JOptionPane.showMessageDialog(
                null,
                'No wells are available at or after ' + plateContext.startWell
                    + ' for plate ' + plateContext.plateNumber + '.',
                'No wells available',
                JOptionPane.INFORMATION_MESSAGE
            );
            return;
        }

        while (pendingWellQueue.length > 0) {
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
        var xs = positions(xLeft, xRight, xStepMm, false);
        var ys = positions(yTop, yBottom, yStepMm, false);
        var frameIndex = 0;
        var totalFrames = xs.length * ys.length;
        var stopAtFirstTarget = touchDryRunFile.exists() && !interactivePickFile.exists();
        var stopAfterFirstTarget = false;
        var interactiveState = null;

        print('Starting Top camera scan: ' + scanId);
        print('This scan will fill wells: ' + pendingWellQueue.map(function(wellIndex) {
            return wellNameForIndex(Number(wellIndex));
        }).join(', '));
        print('Frames directory: ' + framesDir.getAbsolutePath());
        print('Scan test area: X=' + xLeft.toFixed(3) + '..' + xRight.toFixed(3)
            + ' Y=' + yTop.toFixed(3) + '..' + yBottom.toFixed(3)
            + ' (full calibrated Y range)');
        print('Scan overlap step: X step=' + xStepMm.toFixed(3)
            + ' Y step=' + yStepMm.toFixed(3));
        print('Grid: ' + xs.length + ' columns x ' + ys.length + ' rows');
        print('Training tray calibration source: ' + calibration.source);
        print('Scan bounds are camera coordinates: ' + calibration.scanBoundsAreCameraCoordinates);
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
            interactivePickFile.exists()
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
        launchSegmentation(scanDir, controlDir);

        var cameraLocation = camera.getLocation();
        var unitsPerPixel = getUnitsPerPixelForCurrentZ(camera);
        var firstCommandedX = calibration.scanBoundsAreCameraCoordinates ? xs[0] : xs[0] + cameraXOffsetMm;
        var firstCommandedY = calibration.scanBoundsAreCameraCoordinates ? ys[0] : ys[0] + cameraYOffsetMm;
        print('Top camera location at scan start: ' + formatLocation(cameraLocation));
        print('First requested scan coordinate is X=' + xs[0].toFixed(3) + ' Y=' + ys[0].toFixed(3));
        print('First commanded camera target will be X=' + firstCommandedX.toFixed(3)
            + ' Y=' + firstCommandedY.toFixed(3));

        var halted = false;
        try {
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
                        unitsPerPixel
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
        }
        finally {
            manifest.close();
        }

        if (!halted) {
            if (!stopAfterFirstTarget) {
                writeStatus(statusFile, 'scan_complete', scanId, frameIndex, totalFrames, 'Scan completed; waiting for target segmentation');
                print('Completed Top camera scan: ' + scanDir.getAbsolutePath());
            }
            if (waitForSegmentation(scanDir, 120000)) {
                var emptyWells = [];
                var pickSequenceRan = false;
                if (interactivePickFile.exists()) {
                    print('Segmentation complete. Showing numbered detection summary.');
                    if (showDetectionSummaryAndConfirm(scanDir, statusFile, scanId, totalFrames)) {
                        print('Starting left nozzle N1 pick/drop sequence after summary confirmation.');
                        pickSequenceRan = true;
                        emptyWells = pickAndDropTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames, plateContext, pendingWellQueue);
                    }
                }
                else if (touchDryRunFile.exists()) {
                    print('Segmentation complete. Starting left nozzle N1 touch calibration sequence.');
                    touchTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames);
                }
                else {
                    print('Segmentation complete. Starting left nozzle N1 pick/drop sequence.');
                    pickSequenceRan = true;
                    emptyWells = pickAndDropTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames, plateContext, pendingWellQueue);
                }

                if (emptyWells.length > 0 && pickSequenceRan && !touchDryRunFile.exists()) {
                    var refillWells = promptRetryEmptyWells(emptyWells);
                    if (refillWells.length > 0) {
                        pendingWellQueue = [];
                        for (var emptyIndex = 0; emptyIndex < refillWells.length; emptyIndex++) {
                            pendingWellQueue.push(Number(refillWells[emptyIndex].index));
                        }
                        refillAttempt++;
                        print('User requested refill attempt for wells: ' + pendingWellQueue.map(function(wellIndex) {
                            return wellNameForIndex(Number(wellIndex));
                        }).join(', '));
                        continue;
                    }
                }
                pendingWellQueue = [];
                if (emptyWells.length === 0 && pickSequenceRan && !touchDryRunFile.exists()) {
                    JOptionPane.showMessageDialog(
                        null,
                        'All attempted wells were confirmed occupied for plate ' + plateContext.plateNumber + '.',
                        'Plate run complete',
                        JOptionPane.INFORMATION_MESSAGE
                    );
                }
            }
        }
        break;
        }
    });
}
