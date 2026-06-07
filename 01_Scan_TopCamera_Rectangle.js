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

var imports = new JavaImporter(org.openpnp.model, java.io, javax.imageio);

with (imports) {
    var scriptsDir = new File(scripting.getScriptsDirectory().toString());
    var projectDir = scriptsDir.getParentFile();
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

    function showDetectionSummaryAndConfirm(scanDir, statusFile, scanId, totalFrames) {
        var complete = readJsonFile(new File(scanDir, 'segmentation_complete.json'));
        var summaryFile = complete !== null && complete.summary_file
            ? new File(scanDir, String(complete.summary_file))
            : new File(scanDir, 'detection_summary.png');
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
                var WindowAdapter = Packages.java.awt.event.WindowAdapter;

                var frame = new JFrame('Detected Bug Summary');
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

                var imageLabel = makeScaledImageLabel(summaryFile, ImageIcon, JLabel, Image, 1180, 760);
                if (imageLabel !== null) {
                    panel.add(imageLabel, BorderLayout.CENTER);
                }
                else {
                    panel.add(new JLabel('No detection summary image found: ' + summaryFile.getAbsolutePath()), BorderLayout.CENTER);
                }

                var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
                var startButton = new JButton('Start Picking');
                buttons.add(startButton);
                panel.add(buttons, BorderLayout.SOUTH);

                function startPicking() {
                    queue.offer('start');
                    frame.dispose();
                }

                startButton.addActionListener(new ActionListener({ actionPerformed: function(event) { startPicking(); } }));
                frame.addWindowListener(new WindowAdapter({ windowClosing: function(event) { startPicking(); } }));

                frame.setContentPane(panel);
                frame.pack();
                frame.setLocationRelativeTo(null);
                frame.setVisible(true);
            }
        });

        Packages.javax.swing.SwingUtilities.invokeLater(runnable);
        queue.take();
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

    function inspectPickedTargetOnBottomCamera(scanDir, scanId, target, targetIndex, totalTargets, nozzle, travelZ) {
        var bottomCamera = findCameraByName('Bottom');
        var bottomLocation = bottomCamera.getLocation();
        var inspectionZ = -75.0;
        var n2ToN1BottomCameraOffsetX = 45.905;
        var n2ToN1BottomCameraOffsetY = 0.994;
        var inspectionX = bottomLocation.x + n2ToN1BottomCameraOffsetX;
        var inspectionY = bottomLocation.y + n2ToN1BottomCameraOffsetY;
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
            + n2ToN1BottomCameraOffsetX.toFixed(3)
            + ' dY=' + n2ToN1BottomCameraOffsetY.toFixed(3) + ')'
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

    function inspectPlacedWell(scanDir, scanId, target, targetIndex, totalTargets, statusFile, topCamera, well) {
        var qaDir = new File(scanDir, 'qa/wells');
        qaDir.mkdirs();
        var qaCameraCorrectionX = 23.0;
        var qaCameraCorrectionY = 0.0;
        var cameraX = well.x + qaCameraCorrectionX;
        var cameraY = well.y + qaCameraCorrectionY;
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
            + ' using empirical QA camera correction dX=' + qaCameraCorrectionX.toFixed(3)
            + ' dY=' + qaCameraCorrectionY.toFixed(3));
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
        print('Vacuum off at well; holding 0.5s release dwell. VAC1 is configured as a Boolean actuator, so no reverse command was sent.');
        Packages.java.lang.Thread.sleep(500);
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

    function moveNozzleToXyAtZ(nozzle, x, y, z) {
        nozzle.moveTo(nozzleLocationAt(nozzle, x, y, z));
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

    function readPickTargets(scanDir, quiet) {
        var objectsFile = new File(scanDir, 'objects.jsonl');
        var targets = [];
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
                            targets.push({
                                objectIndex: record.object_index,
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
                                centroidX: Number(record.centroid_x_px || 0),
                                centroidY: Number(record.centroid_y_px || 0),
                                score: Number(record.score || 0)
                            });
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

        targets.sort(function(a, b) {
            return targetQualityScore(b) - targetQualityScore(a);
        });
        return deduplicateTargets(targets, 6.0);
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

        var a1X = 72.4;
        var a1Y = 238.6;
        var wellPitch = 9.0;
        var rowIndex = Math.floor(index / 12);
        var columnIndex = index % 12;

        return {
            name: wellNameForIndex(index),
            x: a1X + (wellPitch * rowIndex),
            y: a1Y + (wellPitch * columnIndex)
        };
    }

    function pickAndDropTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames) {
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
        var pickZ = touchCorrection.z + 0.5;
        var dropZ = touchCorrection.z + 3.0;
        var targets = readPickTargets(scanDir);

        print('Pick sequence has ' + targets.length + ' unique target(s).');
        print('Pick tool is ' + pickNozzleLabel + ' on head ' + pickHeadName
            + '; travel Z for XY moves: ' + travelZ.toFixed(3));
        print('Pick correction: dX=' + touchCorrection.x.toFixed(3)
            + ' dY=' + touchCorrection.y.toFixed(3)
            + ' source=' + touchCorrection.source);
        print('Dual-nozzle Z prediction: N1 pick Z=' + pickZ.toFixed(3)
            + ' would put N2 at Z=' + n2ZWhenN1Z(pickZ).toFixed(3));
        if (dryRun) {
            print('Pick dry run flag is present: ' + dryRunFile.getAbsolutePath());
        }
        if (targets.length === 0) {
            writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan completed; no pick targets found');
            return;
        }
        if (targets.length > 96) {
            throw new Error('Refusing pick/drop: found ' + targets.length + ' targets but the plate has 96 wells.');
        }

        for (var i = 0; i < targets.length; i++) {
            if (!waitWhilePaused(pauseFile, stopFile, statusFile, scanId, i, targets.length)
                    || haltRequested(stopFile, statusFile, scanId, i, targets.length)) {
                print('Halt requested during pick sequence. Stopping before target ' + (i + 1) + '.');
                return;
            }

            var target = targets[i];
            var moveX = target.x + touchCorrection.x;
            var moveY = target.y + touchCorrection.y;
            var well = wellLocationForIndex(i);
            writePickingPreview(scanDir, scanId, target, i, targets.length, moveX, moveY);
            writeStatus(
                statusFile,
                'picking',
                scanId,
                i + 1,
                targets.length,
                'Picking target ' + (i + 1) + ' for well ' + well.name
                    + ' at X ' + moveX.toFixed(3) + ', Y ' + moveY.toFixed(3)
            );

            debugPickTarget(scanDir, target, nozzle, travelZ, dryRun, touchCorrection, moveX, moveY);
            if (dryRun) {
                writeStatus(statusFile, 'paused', scanId, i + 1, targets.length, 'Dry run stopped above first pick target');
                return;
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
                targets.length
            );
            moveNozzleToXyAtZ(nozzle, moveX, moveY, travelZ);

            inspectPickedTargetOnBottomCamera(
                scanDir,
                scanId,
                target,
                i,
                targets.length,
                nozzle,
                travelZ
            );

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

            writeStatus(
                statusFile,
                'qa',
                scanId,
                i + 1,
                targets.length,
                'Checking well ' + well.name + ' after placing target ' + (i + 1)
            );
            var wellQa = inspectPlacedWell(
                scanDir,
                scanId,
                target,
                i,
                targets.length,
                statusFile,
                topCamera,
                well
            );
            if (wellQa.well_empty) {
                writeStatus(
                    statusFile,
                    'qa',
                    scanId,
                    i + 1,
                    targets.length,
                    'Well ' + well.name + ' appears empty; checking nozzle for stuck bug'
                );
                var nozzleQa = inspectNozzleAfterEmptyWell(
                    scanDir,
                    scanId,
                    target,
                    i,
                    targets.length,
                    nozzle,
                    travelZ
                );
                if (nozzleQa.bug_present) {
                    writeStatus(
                        statusFile,
                        'qa',
                        scanId,
                        i + 1,
                        targets.length,
                        'Bug appears stuck on nozzle; brush-cleaning before next target'
                    );
                    brushCleanNozzle(nozzle, travelZ);
                }
            }
        }

        writeStatus(statusFile, 'completed', scanId, totalFrames, totalFrames, 'Scan and pick/drop sequence completed');
    }

    task(function() {
        var camera = machine.defaultHead.defaultCamera;
        if (camera.getName() !== 'Top') {
            camera = findCameraByName('Top');
        }
        parkNozzlesForScan(machine.defaultHead);

        var xLeft = 361.0;
        var xRight = 411.0;
        var yTop = 208.0;
        var fullYBottom = 319.0;
        var yBottom = yTop + ((fullYBottom - yTop) * 0.25);
        var cameraXOffsetMm = -23.0;
        var cameraYOffsetMm = 64.0;

        var xStepMm = 8.0;
        var yStepMm = 5.0;

        var controlDir = new File(projectDir, 'control');
        var pauseFile = new File(controlDir, 'pause.flag');
        var stopFile = new File(controlDir, 'stop.flag');
        var pickDryRunFile = new File(controlDir, 'pick_dry_run.flag');
        var touchDryRunFile = new File(controlDir, 'touch_dry_run.flag');
        var interactivePickFile = new File(controlDir, 'interactive_pick.flag');
        var statusFile = new File(controlDir, 'scan_status.json');
        var detectionStatusFile = new File(controlDir, 'detection_status.json');
        var outputRoot = new File(projectDir, 'scans');
        var scanId = 'scan_' + timestamp();
        controlDir.mkdirs();
        if (stopFile.exists()) {
            stopFile.delete();
        }
        launchHaltGui(controlDir);

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
        print('Frames directory: ' + framesDir.getAbsolutePath());
        print('Scan test area: X=' + xLeft.toFixed(3) + '..' + xRight.toFixed(3)
            + ' Y=' + yTop.toFixed(3) + '..' + yBottom.toFixed(3)
            + ' (top 25% of full Y range ending at ' + fullYBottom.toFixed(3) + ')');
        print('Scan overlap step: X step=' + xStepMm.toFixed(3)
            + ' Y step=' + yStepMm.toFixed(3));
        print('Grid: ' + xs.length + ' columns x ' + ys.length + ' rows');
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
        print('Top camera location at scan start: ' + formatLocation(cameraLocation));
        print('First requested scan coordinate is X=' + xs[0].toFixed(3) + ' Y=' + ys[0].toFixed(3));
        print('First commanded camera target will be X=' + (xs[0] + cameraXOffsetMm).toFixed(3)
            + ' Y=' + (ys[0] + cameraYOffsetMm).toFixed(3));

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

                    var requestedX = leftToRight ? xs[col] : xs[xs.length - 1 - col];
                    var requestedY = ys[row];
                    var x = requestedX + cameraXOffsetMm;
                    var y = requestedY + cameraYOffsetMm;
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
                if (interactivePickFile.exists()) {
                    print('Segmentation complete. Showing numbered detection summary.');
                    if (showDetectionSummaryAndConfirm(scanDir, statusFile, scanId, totalFrames)) {
                        print('Starting left nozzle N1 pick/drop sequence after summary confirmation.');
                        pickAndDropTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames);
                    }
                }
                else if (touchDryRunFile.exists()) {
                    print('Segmentation complete. Starting left nozzle N1 touch calibration sequence.');
                    touchTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames);
                }
                else {
                    print('Segmentation complete. Starting left nozzle N1 pick/drop sequence.');
                    pickAndDropTargets(scanDir, pauseFile, stopFile, statusFile, scanId, totalFrames);
                }
            }
        }
    });
}
