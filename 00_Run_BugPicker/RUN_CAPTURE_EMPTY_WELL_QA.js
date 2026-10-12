/** Capture confirmed-empty Lumen well images for binary Well QA training. */

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
    var root = scriptsRoot.getName() === 'BugPicker' ? scriptsRoot : new File(scriptsRoot, 'BugPicker');
    if (!root.exists()) root = scriptsRoot;

    function readText(file) {
        var reader = new BufferedReader(new FileReader(file));
        var lines = [];
        try {
            var line;
            while ((line = reader.readLine()) !== null) lines.push(String(line));
        }
        finally { reader.close(); }
        return lines.join('\n');
    }

    function appendJsonLine(file, record) {
        file.getParentFile().mkdirs();
        var writer = new FileWriter(file, true);
        try { writer.write(JSON.stringify(record) + '\n'); }
        finally { writer.close(); }
    }

    function pad(value, width) {
        var text = String(value);
        while (text.length < width) text = '0' + text;
        return text;
    }

    function timestamp() {
        var now = new Date();
        return now.getFullYear() + pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2)
            + '_' + pad(now.getHours(), 2) + pad(now.getMinutes(), 2)
            + pad(now.getSeconds(), 2) + '_' + pad(now.getMilliseconds(), 3);
    }

    function findCamera(name) {
        var cameras = machine.getCameras();
        for (var i = 0; i < cameras.size(); i++)
            if (String(cameras.get(i).getName()) === name) return cameras.get(i);
        var headCameras = machine.defaultHead.getCameras();
        for (var j = 0; j < headCameras.size(); j++)
            if (String(headCameras.get(j).getName()) === name) return headCameras.get(j);
        throw new Error('Camera not found: ' + name);
    }

    function findNozzle(name) {
        var nozzles = machine.defaultHead.getNozzles();
        for (var i = 0; i < nozzles.size(); i++)
            if (String(nozzles.get(i).getName()) === name) return nozzles.get(i);
        throw new Error('Nozzle not found: ' + name);
    }

    function moveCameraToXy(camera, x, y) {
        var current = camera.getLocation();
        camera.moveTo(current.add(new Location(
            LengthUnit.Millimeters, x - current.x, y - current.y, 0, 0
        )));
    }

    function plateForSlot(config, slot) {
        for (var i = 0; i < config.plates.length; i++)
            if (Number(config.plates[i].plate_slot) === slot) return config.plates[i];
        return null;
    }

    function wellName(index) {
        return String.fromCharCode('A'.charCodeAt(0) + Math.floor(index / 12))
            + String((index % 12) + 1);
    }

    function selectedIndices(count) {
        var result = [], used = {};
        for (var i = 0; i < count; i++) {
            var index = count === 1 ? 0 : Math.round(i * 95 / (count - 1));
            if (!used[index]) { result.push(index); used[index] = true; }
        }
        for (var candidate = 0; result.length < count && candidate < 96; candidate++)
            if (!used[candidate]) { result.push(candidate); used[candidate] = true; }
        result.sort(function(a, b) { return a - b; });
        return result;
    }

    function createStatus(total, outputDir) {
        var frame = new JFrame('BugPicker Empty-Well QA Capture');
        frame.setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);
        frame.setLayout(new BorderLayout(8, 8));
        var label = new JLabel('Preparing empty-well capture...');
        label.setBorder(BorderFactory.createEmptyBorder(8, 8, 0, 8));
        frame.add(label, BorderLayout.NORTH);
        var center = new JPanel(new BorderLayout(8, 8));
        center.setBorder(BorderFactory.createEmptyBorder(0, 8, 0, 8));
        var progress = new JProgressBar(0, total);
        progress.setStringPainted(true); progress.setString('0 / ' + total);
        center.add(progress, BorderLayout.NORTH);
        var details = new JTextArea(8, 68);
        details.setEditable(false); details.setText('Output folder:\n' + outputDir.getAbsolutePath());
        center.add(new JScrollPane(details), BorderLayout.CENTER); frame.add(center, BorderLayout.CENTER);
        var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
        var button = new JButton('Cancel'); buttons.add(button); frame.add(buttons, BorderLayout.SOUTH);
        var state = {cancelled: false, finished: false};
        button.addActionListener(new ActionListener({actionPerformed: function() {
            if (state.finished) { frame.dispose(); return; }
            state.cancelled = true; button.setEnabled(false); label.setText('Cancelling after this image...');
        }}));
        frame.pack(); frame.setLocationRelativeTo(null); frame.setVisible(true);
        return {frame: frame, label: label, progress: progress, details: details, button: button, state: state};
    }

    function updateStatus(ui, message, done, total, detail) {
        SwingUtilities.invokeLater(new Packages.java.lang.Runnable({run: function() {
            ui.label.setText(message); ui.progress.setValue(done); ui.progress.setString(done + ' / ' + total);
            if (detail) { ui.details.append('\n' + detail); ui.details.setCaretPosition(ui.details.getDocument().getLength()); }
        }}));
    }

    var panel = new JPanel(new GridLayout(0, 2, 8, 8));
    panel.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
    var slotField = new JTextField('1', 6), countField = new JTextField('48', 6);
    panel.add(new JLabel('Plate slot')); panel.add(slotField);
    panel.add(new JLabel('Empty wells to capture')); panel.add(countField);
    if (JOptionPane.showConfirmDialog(null, panel, 'Capture Empty-Well QA Images',
            JOptionPane.OK_CANCEL_OPTION, JOptionPane.QUESTION_MESSAGE) !== JOptionPane.OK_OPTION)
        throw new Error('Empty-well capture cancelled.');

    var slot = Number(String(slotField.getText()).trim());
    var count = Number(String(countField.getText()).trim());
    if (!isFinite(slot) || Math.floor(slot) !== slot || slot < 1 || slot > 2)
        throw new Error('Plate slot must be 1 or 2.');
    if (!isFinite(count) || Math.floor(count) !== count || count < 1 || count > 96)
        throw new Error('Empty wells must be a whole number from 1 to 96.');
    if (JOptionPane.showConfirmDialog(null,
            'Confirm that plate slot ' + slot + ' contains an EMPTY 96-well plate.\n\n'
            + 'Every captured image will be labeled empty_well automatically.\n'
            + 'The machine must be homed and the Top-camera A1 calibration must be current.',
            'Verify Empty Plate', JOptionPane.OK_CANCEL_OPTION,
            JOptionPane.WARNING_MESSAGE) !== JOptionPane.OK_OPTION)
        throw new Error('Empty-well capture cancelled.');
    if (!machine.isHomed()) throw new Error('Machine is not homed. Home it before capture.');

    var configFile = new File(root, 'multitray_calibration.json');
    if (!configFile.exists()) throw new Error('Missing calibration: ' + configFile.getAbsolutePath());
    var config = JSON.parse(readText(configFile));
    var plate = plateForSlot(config, slot);
    if (plate === null) throw new Error('No plate calibration found for slot ' + slot + '.');
    var pitch = Number(config.shared.plate_well_pitch_mm);
    var a1X = Number(plate.top_camera_a1_x_mm), a1Y = Number(plate.top_camera_a1_y_mm);
    if (![pitch, a1X, a1Y].every(function(value) { return isFinite(value); }))
        throw new Error('Top-camera plate calibration contains a non-numeric value.');

    var camera = findCamera('Top');
    var nozzle = findNozzle('N1');
    var feedbackDir = new File(new File(root, 'Data'), 'qa_feedback');
    var sessionId = 'empty_well_' + timestamp();
    var captureDir = new File(new File(feedbackDir, 'empty_well_captures'), sessionId);
    captureDir.mkdirs();
    var labelFile = new File(feedbackDir, 'well_qa_labels.jsonl');
    var indices = selectedIndices(count), captured = 0, captureError = null;
    var ui = createStatus(indices.length, captureDir);

    function runCapture() {
        try {
            updateStatus(ui, 'Raising N1 to safe Z...', captured, indices.length, null);
            nozzle.moveToSafeZ();
            for (var i = 0; i < indices.length; i++) {
                if (ui.state.cancelled) break;
                var index = indices[i], row = Math.floor(index / 12), column = index % 12;
                var name = wellName(index), x = a1X + pitch * row, y = a1Y + pitch * column;
                updateStatus(ui, 'Capturing empty well ' + name + '...', captured, indices.length, null);
                moveCameraToXy(camera, x, y); Packages.java.lang.Thread.sleep(250);
                var image = camera.settleAndCapture();
                var imageFile = new File(captureDir, 'empty_well_' + name + '_' + timestamp() + '_top.png');
                ImageIO.write(image, 'PNG', imageFile);
                appendJsonLine(labelFile, {
                    qa_mode: 'well', image_path: imageFile.getAbsolutePath(), priority: 100,
                    reason: 'dedicated confirmed-empty Lumen well capture', suggested_label: 'empty_well',
                    cv_prediction: 'not_evaluated', user_label: 'empty_well', reviewed_at: new Date().toISOString(),
                    review_source: 'empty_well_capture', capture_session: sessionId + '_row_' + row,
                    capture_index: i + 1, plate_slot: slot, well: name,
                    top_camera_x_mm: x, top_camera_y_mm: y
                });
                captured++;
                updateStatus(ui, 'Captured ' + captured + ' of ' + indices.length + ' empty wells.',
                    captured, indices.length, 'Saved ' + name + ' at X=' + x.toFixed(3) + ', Y=' + y.toFixed(3));
            }
        }
        catch (error) { captureError = error; }
        finally {
            try { nozzle.moveToSafeZ(); }
            catch (safeError) {
                if (captureError === null) captureError = safeError;
            }
        }
        ui.state.finished = true;
        var message = captureError ? 'Capture stopped because of an error.'
            : ui.state.cancelled ? 'Capture cancelled.' : 'Empty-well capture complete.';
        var detail = captureError ? 'ERROR: ' + String(captureError)
            : 'Captured and labeled ' + captured + ' images. Run Well QA training to include them.';
        updateStatus(ui, message, captured, indices.length, detail);
        SwingUtilities.invokeLater(new Packages.java.lang.Runnable({run: function() {
            ui.frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
            ui.button.setEnabled(true); ui.button.setText('Close');
        }}));
    }

    var UiUtils = Packages.org.openpnp.util.UiUtils;
    UiUtils['submitUiMachineTask(Thrunnable)'](function() { runCapture(); });
}
