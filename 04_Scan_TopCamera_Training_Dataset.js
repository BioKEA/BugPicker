/**
 * 04: Scan the full predefined tray area with the Top camera for training data.
 *
 * Area:
 *   X 361 to 411
 *   Y 208 to 319
 *
 * Output:
 *   <OpenPnP config>/training_scans/<training_scan_id>/
 *     frames/*.png
 *     manifest.jsonl
 *     scan_info.json
 *
 * This script only captures images. It does not launch segmentation, CV,
 * QA inspection, picking, dropping, or the halt-control GUI.
 */

try {
    load(scripting.getScriptsDirectory().toString() + '/Examples/JavaScript/Utility.js');
}
catch (loadError) {
    var scriptsDirectory = new java.io.File(scripting.getScriptsDirectory().toString());
    load(new java.io.File(scriptsDirectory.getParentFile(), 'Examples/JavaScript/Utility.js').getAbsolutePath());
}

var imports = new JavaImporter(org.openpnp.model, java.io, javax.imageio);

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

    function loadTrainingTrayCalibration(defaults) {
        var localCalibrationFile = new File(scriptsDir, 'training_tray_calibration.json');
        var controlCalibrationFile = new File(projectDir, 'control/training_tray_calibration.json');
        var calibrationFile = localCalibrationFile.exists() ? localCalibrationFile : controlCalibrationFile;
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
        calibration.source = calibrationFile.getAbsolutePath();
        return calibration;
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
        print('Parking nozzles before training scan XY motion.');
        printNozzleLocations(head);
        try {
            var nozzles = head.getNozzles();
            for (var i = 0; i < nozzles.size(); i++) {
                try {
                    nozzles.get(i).moveToSafeZ();
                    print('Parked nozzle with OpenPnP safe Z: ' + nozzles.get(i).getName()
                        + ' location=' + formatLocation(nozzles.get(i).location));
                }
                catch (parkError) {
                    print('Could not park nozzle ' + nozzles.get(i).getName() + ': ' + parkError);
                }
            }
        }
        catch (error) {
            print('Could not enumerate nozzles for parking: ' + error);
        }
        print('Nozzle states after parking:');
        printNozzleLocations(head);
    }

    task(function() {
        var camera = machine.defaultHead.defaultCamera;
        if (camera.getName() !== 'Top') {
            camera = findCameraByName('Top');
        }
        parkNozzlesForScan(machine.defaultHead);

        var calibration = loadTrainingTrayCalibration({
            xLeft: 361.0,
            xRight: 411.0,
            yTop: 208.0,
            yBottom: 319.0,
            cameraXOffsetMm: -23.0,
            cameraYOffsetMm: 64.0,
            scanBoundsAreCameraCoordinates: false,
            xStepMm: 8.0,
            yStepMm: 5.0
        });
        var xLeft = calibration.xLeft;
        var xRight = calibration.xRight;
        var yTop = calibration.yTop;
        var yBottom = calibration.yBottom;
        var cameraXOffsetMm = calibration.cameraXOffsetMm;
        var cameraYOffsetMm = calibration.cameraYOffsetMm;
        var xStepMm = calibration.xStepMm;
        var yStepMm = calibration.yStepMm;

        var controlDir = new File(projectDir, 'control');
        var statusFile = new File(controlDir, 'training_scan_status.json');
        var outputRoot = new File(projectDir, 'training_scans');
        var scanId = 'training_scan_' + timestamp();
        controlDir.mkdirs();

        var scanDir = new File(outputRoot, scanId);
        var framesDir = new File(scanDir, 'frames');
        framesDir.mkdirs();

        var manifestFile = new File(scanDir, 'manifest.jsonl');
        var scanInfoFile = new File(scanDir, 'scan_info.json');
        var manifest = new FileWriter(manifestFile);
        var xs = positions(xLeft, xRight, xStepMm, false);
        var ys = positions(yTop, yBottom, yStepMm, false);
        var frameIndex = 0;
        var totalFrames = xs.length * ys.length;

        print('Starting full-tray Top camera training scan: ' + scanId);
        print('Frames directory: ' + framesDir.getAbsolutePath());
        print('Training scan area: X=' + xLeft.toFixed(3) + '..' + xRight.toFixed(3)
            + ' Y=' + yTop.toFixed(3) + '..' + yBottom.toFixed(3)
            + ' (full tray range)');
        print('Scan overlap step: X step=' + xStepMm.toFixed(3)
            + ' Y step=' + yStepMm.toFixed(3));
        print('Grid: ' + xs.length + ' columns x ' + ys.length + ' rows'
            + ' = ' + totalFrames + ' frame(s)');
        print('Training tray calibration source: ' + calibration.source);
        print('Scan bounds are camera coordinates: ' + calibration.scanBoundsAreCameraCoordinates);
        print('Camera X compensation: ' + cameraXOffsetMm.toFixed(3) + ' mm');
        print('Camera Y compensation: +' + cameraYOffsetMm.toFixed(3) + ' mm');

        writeStatus(statusFile, 'running', scanId, frameIndex, totalFrames, 'Training scan started');

        var cameraLocation = camera.getLocation();
        var unitsPerPixel = getUnitsPerPixelForCurrentZ(camera);
        var firstCommandedX = calibration.scanBoundsAreCameraCoordinates ? xs[0] : xs[0] + cameraXOffsetMm;
        var firstCommandedY = calibration.scanBoundsAreCameraCoordinates ? ys[0] : ys[0] + cameraYOffsetMm;
        print('Top camera location at scan start: ' + formatLocation(cameraLocation));
        print('First requested scan coordinate is X=' + xs[0].toFixed(3) + ' Y=' + ys[0].toFixed(3));
        print('First commanded camera target will be X=' + firstCommandedX.toFixed(3)
            + ' Y=' + firstCommandedY.toFixed(3));

        writeText(scanInfoFile, JSON.stringify({
            scan_id: scanId,
            purpose: 'training_dataset',
            camera: 'Top',
            output_dir: scanDir.getAbsolutePath(),
            frames_dir: framesDir.getAbsolutePath(),
            x_left_mm: xLeft,
            x_right_mm: xRight,
            y_top_mm: yTop,
            y_bottom_mm: yBottom,
            x_step_mm: xStepMm,
            y_step_mm: yStepMm,
            camera_x_offset_mm: cameraXOffsetMm,
            camera_y_offset_mm: cameraYOffsetMm,
            scan_bounds_are_camera_coordinates: calibration.scanBoundsAreCameraCoordinates,
            calibration_source: calibration.source,
            columns: xs.length,
            rows: ys.length,
            total_frames: totalFrames,
            started_at: new Date().toISOString()
        }, null, 2) + '\n');

        try {
            for (var row = 0; row < ys.length; row++) {
                var leftToRight = (row % 2) === 0;

                for (var col = 0; col < xs.length; col++) {
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

                    print('Moving Top camera to training frame ' + frameIndex
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

                    print('Captured training image ' + fileName);
                    frameIndex++;
                    writeStatus(
                        statusFile,
                        'running',
                        scanId,
                        frameIndex,
                        totalFrames,
                        'Captured training image ' + frameIndex + ' of ' + totalFrames
                    );
                }
            }
        }
        finally {
            manifest.close();
        }

        writeStatus(
            statusFile,
            'completed',
            scanId,
            frameIndex,
            totalFrames,
            'Training scan completed; images saved without CV or picking'
        );
        print('Completed full-tray Top camera training scan: ' + scanDir.getAbsolutePath());
        print('No segmentation, QA inspection, picking, or dropping was started.');
    });
}
