/**
 * Capture confirmed-empty N1 images at the normal bottom-inspection position
 * and add them directly to the nozzle QA training labels.
 */

load(scripting.getScriptsDirectory().toString() + '/Examples/JavaScript/Utility.js');

var imports = new JavaImporter(
    org.openpnp.model,
    java.io,
    javax.imageio,
    javax.swing,
    java.awt,
    java.awt.event
);

with (imports) {
    var scriptsRoot = new File(scripting.getScriptsDirectory().toString());
    var bugPickerRoot = scriptsRoot.getName() === 'BugPicker'
        ? scriptsRoot
        : new File(scriptsRoot, 'BugPicker');
    if (!bugPickerRoot.exists()) {
        bugPickerRoot = scriptsRoot;
    }

    function pad(value, width) {
        var text = String(value);
        while (text.length < width) {
            text = '0' + text;
        }
        return text;
    }

    function timestamp() {
        var now = new Date();
        return now.getFullYear()
            + pad(now.getMonth() + 1, 2)
            + pad(now.getDate(), 2) + '_'
            + pad(now.getHours(), 2)
            + pad(now.getMinutes(), 2)
            + pad(now.getSeconds(), 2)
            + '_' + pad(now.getMilliseconds(), 3);
    }

    function findCamera(name) {
        var cameras = machine.getCameras();
        for (var i = 0; i < cameras.size(); i++) {
            if (String(cameras.get(i).getName()) === name) {
                return cameras.get(i);
            }
        }
        var headCameras = machine.defaultHead.getCameras();
        for (var j = 0; j < headCameras.size(); j++) {
            if (String(headCameras.get(j).getName()) === name) {
                return headCameras.get(j);
            }
        }
        throw new Error('Camera not found: ' + name);
    }

    function findNozzle(name) {
        var nozzles = machine.defaultHead.getNozzles();
        for (var i = 0; i < nozzles.size(); i++) {
            if (String(nozzles.get(i).getName()) === name) {
                return nozzles.get(i);
            }
        }
        throw new Error('Nozzle not found: ' + name);
    }

    function appendJsonLine(file, record) {
        file.getParentFile().mkdirs();
        var writer = new FileWriter(file, true);
        try {
            writer.write(JSON.stringify(record) + '\n');
        }
        finally {
            writer.close();
        }
    }

    function nozzleLocation(nozzle, x, y, z, rotation) {
        return new Location(
            LengthUnit.Millimeters,
            x,
            y,
            z,
            rotation === undefined || rotation === null
                ? nozzle.getLocation().getRotation()
                : rotation
        );
    }

    function normalizedRotation(rotation) {
        var normalized = rotation % 360.0;
        if (normalized > 180.0) {
            normalized -= 360.0;
        }
        if (normalized <= -180.0) {
            normalized += 360.0;
        }
        return normalized;
    }

    function createStatusWindow(totalImages, outputDir) {
        var frame = new JFrame('BugPicker Empty-Nozzle QA Capture');
        frame.setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);
        frame.setLayout(new BorderLayout(8, 8));

        var statusLabel = new JLabel('Preparing empty-nozzle capture...');
        statusLabel.setBorder(BorderFactory.createEmptyBorder(8, 8, 0, 8));
        frame.add(statusLabel, BorderLayout.NORTH);

        var center = new JPanel(new BorderLayout(8, 8));
        center.setBorder(BorderFactory.createEmptyBorder(0, 8, 0, 8));
        var progressBar = new JProgressBar(0, totalImages);
        progressBar.setStringPainted(true);
        progressBar.setString('0 / ' + totalImages);
        center.add(progressBar, BorderLayout.NORTH);

        var details = new JTextArea(9, 72);
        details.setEditable(false);
        details.setLineWrap(true);
        details.setWrapStyleWord(true);
        details.setText('Output folder:\n' + outputDir.getAbsolutePath());
        center.add(new JScrollPane(details), BorderLayout.CENTER);
        frame.add(center, BorderLayout.CENTER);

        var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
        var cancelButton = new JButton('Cancel');
        buttons.add(cancelButton);
        frame.add(buttons, BorderLayout.SOUTH);

        var state = {
            cancelled: false,
            finished: false
        };
        cancelButton.addActionListener(new ActionListener({
            actionPerformed: function(event) {
                if (state.finished) {
                    frame.dispose();
                    return;
                }
                state.cancelled = true;
                cancelButton.setEnabled(false);
                statusLabel.setText('Cancelling after the current capture...');
            }
        }));

        frame.pack();
        frame.setLocationRelativeTo(null);
        frame.setVisible(true);

        return {
            frame: frame,
            statusLabel: statusLabel,
            progressBar: progressBar,
            details: details,
            button: cancelButton,
            state: state
        };
    }

    function updateStatus(statusWindow, message, captured, total, detail) {
        Packages.javax.swing.SwingUtilities.invokeLater(
            new Packages.java.lang.Runnable({
                run: function() {
                    statusWindow.statusLabel.setText(message);
                    statusWindow.progressBar.setValue(captured);
                    statusWindow.progressBar.setString(captured + ' / ' + total);
                    if (detail) {
                        statusWindow.details.append('\n' + detail);
                        statusWindow.details.setCaretPosition(
                            statusWindow.details.getDocument().getLength()
                        );
                    }
                }
            })
        );
    }

    var panel = new JPanel(new GridLayout(0, 2, 8, 8));
    panel.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
    var countField = new JTextField('50', 8);
    var intervalField = new JTextField('250', 8);
    var jitterField = new JTextField('0.40', 8);
    panel.add(new JLabel('Images'));
    panel.add(countField);
    panel.add(new JLabel('Interval (ms)'));
    panel.add(intervalField);
    panel.add(new JLabel('Framing variation (mm)'));
    panel.add(jitterField);

    var choice = JOptionPane.showConfirmDialog(
        null,
        panel,
        'Capture Empty-Nozzle QA Images',
        JOptionPane.OK_CANCEL_OPTION,
        JOptionPane.QUESTION_MESSAGE
    );
    if (choice !== JOptionPane.OK_OPTION) {
        throw new Error('Empty-nozzle capture cancelled.');
    }

    var count = Number(String(countField.getText()).trim());
    var intervalMs = Number(String(intervalField.getText()).trim());
    var jitterMm = Number(String(jitterField.getText()).trim());
    if (!isFinite(count) || count < 1 || count > 500 || Math.floor(count) !== count) {
        throw new Error('Images must be a whole number from 1 to 500.');
    }
    if (!isFinite(intervalMs) || intervalMs < 0 || intervalMs > 10000) {
        throw new Error('Interval must be from 0 to 10000 ms.');
    }
    if (!isFinite(jitterMm) || jitterMm < 0 || jitterMm > 1.0) {
        throw new Error('Framing variation must be from 0 to 1.0 mm.');
    }

    var confirmed = JOptionPane.showConfirmDialog(
        null,
        'Confirm that N1 is completely empty and clean.\n\n'
            + 'The machine must be homed. N1 will move over the Bottom camera\n'
            + 'and descend to the normal inspection height.',
        'Verify Empty Nozzle',
        JOptionPane.OK_CANCEL_OPTION,
        JOptionPane.WARNING_MESSAGE
    );
    if (confirmed !== JOptionPane.OK_OPTION) {
        throw new Error('Empty-nozzle capture cancelled.');
    }

    try {
        if (!machine.isHomed()) {
            throw new Error('Machine is not homed. Home it before capturing QA images.');
        }
    }
    catch (homedError) {
        if (String(homedError).indexOf('not homed') >= 0) {
            throw homedError;
        }
    }

    var bottomCamera = findCamera('Bottom');
    var nozzle = findNozzle('N1');
    var cameraLocation = bottomCamera.getLocation();
    var centerX = Number(cameraLocation.getX()) + 45.905;
    var centerY = Number(cameraLocation.getY()) + 0.994;
    var inspectionZ = -75.0;
    var startingRotation = Number(nozzle.getLocation().getRotation());

    var feedbackDir = new File(new File(bugPickerRoot, 'Data'), 'qa_feedback');
    var sessionId = 'empty_nozzle_' + timestamp();
    var captureDir = new File(new File(feedbackDir, 'empty_nozzle_captures'), sessionId);
    captureDir.mkdirs();
    var labelFile = new File(feedbackDir, 'nozzle_qa_labels.jsonl');
    var captured = 0;
    var statusWindow = createStatusWindow(count, captureDir);
    var captureError = null;

    function runCapture() {
      try {
        updateStatus(statusWindow, 'Moving N1 to safe Z...', captured, count, null);
        nozzle.moveToSafeZ();
        updateStatus(statusWindow, 'Moving N1 over the Bottom camera...', captured, count, null);
        nozzle.moveTo(nozzleLocation(nozzle, centerX, centerY, nozzle.getLocation().getZ()));
        updateStatus(statusWindow, 'Descending to the inspection height...', captured, count, null);
        nozzle.moveTo(nozzleLocation(nozzle, centerX, centerY, inspectionZ));
        Packages.java.lang.Thread.sleep(500);

        for (var index = 0; index < count; index++) {
            if (statusWindow.state.cancelled) {
                break;
            }
            // Cycle over a compact 3x3 grid to include normal centering variation.
            var gridX = (index % 3) - 1;
            var gridY = (Math.floor(index / 3) % 3) - 1;
            var x = centerX + (gridX * jitterMm);
            var y = centerY + (gridY * jitterMm);
            var rotation = normalizedRotation(
                startingRotation + (Math.floor(index / 5) * 90.0)
            );
            updateStatus(
                statusWindow,
                'Capturing empty-nozzle image ' + (index + 1) + ' of ' + count
                    + ' at ' + rotation.toFixed(1) + ' degrees...',
                captured,
                count,
                null
            );
            nozzle.moveTo(nozzleLocation(nozzle, x, y, inspectionZ, rotation));
            Packages.java.lang.Thread.sleep(intervalMs);

            var image = bottomCamera.settleAndCapture();
            var cropWidth = Math.max(1, Math.round(image.getWidth() * 0.50));
            var cropHeight = Math.max(1, Math.round(image.getHeight() * 0.50));
            var cropX = Math.max(0, Math.round((image.getWidth() - cropWidth) / 2));
            var cropY = Math.max(0, Math.round((image.getHeight() - cropHeight) / 2));
            var crop = image.getSubimage(cropX, cropY, cropWidth, cropHeight);
            var imageFile = new File(
                captureDir,
                'empty_nozzle_' + pad(index + 1, 3) + '_' + timestamp() + '.png'
            );
            ImageIO.write(crop, 'PNG', imageFile);

            appendJsonLine(labelFile, {
                qa_mode: 'nozzle',
                image_path: imageFile.getAbsolutePath(),
                priority: 100,
                reason: 'dedicated confirmed-empty nozzle capture',
                suggested_label: 'empty_nozzle',
                cv_prediction: 'not_evaluated',
                user_label: 'empty_nozzle',
                reviewed_at: new Date().toISOString(),
                review_source: 'empty_nozzle_capture',
                capture_session: sessionId,
                capture_index: index + 1,
                inspection_x_mm: x,
                inspection_y_mm: y,
                inspection_z_mm: inspectionZ,
                nozzle_rotation_deg: rotation
            });
            captured++;
            updateStatus(
                statusWindow,
                'Captured ' + captured + ' of ' + count + ' images.',
                captured,
                count,
                'Saved ' + imageFile.getName()
                    + ' at X=' + x.toFixed(3) + ', Y=' + y.toFixed(3)
                    + ', rotation=' + rotation.toFixed(1) + ' degrees'
            );
        }
      }
      catch (error) {
        captureError = error;
      }
      finally {
        try {
            updateStatus(statusWindow, 'Returning N1 to safe Z...', captured, count, null);
            nozzle.moveToSafeZ();
            nozzle.moveTo(nozzleLocation(
                nozzle,
                nozzle.getLocation().getX(),
                nozzle.getLocation().getY(),
                nozzle.getLocation().getZ(),
                startingRotation
            ));
        }
        catch (safeZError) {
            updateStatus(
                statusWindow,
                'Could not return N1 to safe Z.',
                captured,
                count,
                'ERROR: ' + String(safeZError)
            );
            if (captureError === null) {
                captureError = safeZError;
            }
        }
      }

      statusWindow.state.finished = true;
      if (captureError !== null) {
        updateStatus(
            statusWindow,
            'Capture stopped because of an error.',
            captured,
            count,
            'ERROR: ' + String(captureError)
        );
      }
      else if (statusWindow.state.cancelled) {
        updateStatus(
            statusWindow,
            'Capture cancelled. N1 returned to safe Z.',
            captured,
            count,
            'The ' + captured + ' completed images remain labeled and usable.'
        );
      }
      else {
        updateStatus(
            statusWindow,
            'Capture complete. N1 returned to safe Z.',
            captured,
            count,
            'Captured and labeled ' + captured
                + ' empty-nozzle images. Run nozzle QA training to include them.'
        );
      }
      Packages.javax.swing.SwingUtilities.invokeLater(
          new Packages.java.lang.Runnable({
              run: function() {
                  statusWindow.frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
                  statusWindow.button.setEnabled(true);
                  statusWindow.button.setText('Close');
              }
          })
      );
    }

    var UiUtils = Packages.org.openpnp.util.UiUtils;
    UiUtils['submitUiMachineTask(Thrunnable)'](function() {
        runCapture();
    });
}
