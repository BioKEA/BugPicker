/**
 * 01: Scan the predefined rectangle with the Top camera and save images.
 *
 * Area:
 *   top left:     X 293, Y 321
 *   bottom right: X 383, Y 201
 *
 * Output:
 *   /home/sean/Documents/OpenInvert-PnP/scans/<scan_id>/
 *     frames/*.png
 *     manifest.jsonl
 *
 * Cooperative pause/resume:
 *   If /home/sean/Documents/OpenInvert-PnP/control/halt.flag exists, the
 *   scan pauses before the next move. Clearing the flag resumes the same run.
 *   The halt control GUI is launched automatically at scan start.
 */

load(scripting.getScriptsDirectory().toString() + '/Examples/JavaScript/Utility.js');

var imports = new JavaImporter(org.openpnp.model, java.io, javax.imageio);

with (imports) {
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

    function jsonLine(frameIndex, fileName, x, y, width, height, unitsPerPixel) {
        var record = {
            frame_index: frameIndex,
            file_name: fileName,
            camera: 'Top',
            x_mm: x,
            y_mm: y,
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

    function waitWhilePaused(haltFile, statusFile, scanId, frameIndex, totalFrames) {
        var announcedPause = false;

        while (haltFile.exists()) {
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
    }

    function launchHaltGui(controlDir) {
        var projectDir = new File('/home/sean/Documents/OpenInvert-PnP');
        var python = '/home/sean/Documents/OpenInvert-PnP/.venv/bin/python';
        var guiScript = '/home/sean/Documents/OpenInvert-PnP/scripts/00_Halt_Control.py';
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

    task(function() {
        var camera = machine.defaultHead.defaultCamera;
        if (camera.getName() !== 'Top') {
            camera = machine.getCameraByName('Top');
        }

        var xLeft = 293.0;
        var xRight = 383.0;
        var yTop = 321.0;
        var yBottom = 201.0;

        var xStepMm = 12.0;
        var yStepMm = 9.5;

        var controlDir = new File('/home/sean/Documents/OpenInvert-PnP/control');
        var haltFile = new File(controlDir, 'halt.flag');
        var statusFile = new File(controlDir, 'scan_status.json');
        var outputRoot = new File('/home/sean/Documents/OpenInvert-PnP/scans');
        var scanId = 'scan_' + timestamp();
        controlDir.mkdirs();
        launchHaltGui(controlDir);

        var scanDir = new File(outputRoot, scanId);
        var framesDir = new File(scanDir, 'frames');
        framesDir.mkdirs();

        var manifestFile = new File(scanDir, 'manifest.jsonl');
        var manifest = new FileWriter(manifestFile);
        var cameraLocation = camera.getLocation();
        var unitsPerPixel = camera.getUnitsPerPixel();
        var xs = positions(xLeft, xRight, xStepMm, false);
        var ys = positions(yTop, yBottom, yStepMm, true);
        var frameIndex = 0;
        var totalFrames = xs.length * ys.length;

        print('Starting Top camera scan: ' + scanId);
        print('Frames directory: ' + framesDir.getAbsolutePath());
        print('Grid: ' + xs.length + ' columns x ' + ys.length + ' rows');
        print('Cooperative pause flag: ' + haltFile.getAbsolutePath());
        writeStatus(statusFile, 'running', scanId, frameIndex, totalFrames, 'Scan started');

        try {
            for (var row = 0; row < ys.length; row++) {
                var leftToRight = (row % 2) === 0;

                for (var col = 0; col < xs.length; col++) {
                    waitWhilePaused(haltFile, statusFile, scanId, frameIndex, totalFrames);

                    var x = leftToRight ? xs[col] : xs[xs.length - 1 - col];
                    var y = ys[row];
                    var location = new Location(
                        LengthUnit.Millimeters,
                        x,
                        y,
                        cameraLocation.z,
                        cameraLocation.rotation
                    );

                    camera.moveTo(location);
                    var image = camera.settleAndCapture();
                    var fileName = 'frame_' + pad(frameIndex, 5)
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
                        image.getWidth(),
                        image.getHeight(),
                        unitsPerPixel
                    ));
                    manifest.flush();

                    print('Captured ' + fileName);
                    frameIndex++;
                    writeStatus(statusFile, 'running', scanId, frameIndex, totalFrames, 'Captured ' + fileName);
                }
            }
        }
        finally {
            manifest.close();
        }

        writeStatus(statusFile, 'completed', scanId, frameIndex, totalFrames, 'Scan completed');
        print('Completed Top camera scan: ' + scanDir.getAbsolutePath());
    });
}
