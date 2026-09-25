/**
 * Run BugPicker weekly model dataset updates and optional retraining.
 */

var imports = new JavaImporter(java.io, javax.swing, java.awt, java.awt.event);

with (imports) {
    var scriptsRootDir = new File(scripting.getScriptsDirectory().toString());
    var bugPickerRoot = scriptsRootDir.getName() === 'BugPicker'
        ? scriptsRootDir
        : new File(scriptsRootDir, 'BugPicker');
    if (!bugPickerRoot.exists()) {
        bugPickerRoot = scriptsRootDir;
    }

    var openPnpRoot = bugPickerRoot.getName() === 'BugPicker'
        && bugPickerRoot.getParentFile() !== null
        && bugPickerRoot.getParentFile().getName() === 'scripts'
        ? bugPickerRoot.getParentFile().getParentFile()
        : bugPickerRoot.getParentFile();

    var scriptLocalPython = new File(bugPickerRoot, '.venv/bin/python');
    var projectLocalPython = new File(openPnpRoot, '.venv/bin/python');
    var python = scriptLocalPython.exists()
        ? scriptLocalPython.getAbsolutePath()
        : projectLocalPython.exists()
        ? projectLocalPython.getAbsolutePath()
        : 'python3';

    function appendText(file, text) {
        var writer = new FileWriter(file, true);
        try {
            writer.write(text);
        }
        finally {
            writer.close();
        }
    }

    function readTail(file, maxChars) {
        if (!file.exists()) {
            return '';
        }
        var reader = new BufferedReader(new FileReader(file));
        var builder = new StringBuilder();
        try {
            var line;
            while ((line = reader.readLine()) !== null) {
                builder.append(line).append('\n');
                if (builder.length() > maxChars * 2) {
                    builder.delete(0, builder.length() - maxChars);
                }
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

    function readFile(file) {
        if (!file.exists()) {
            return '';
        }
        var reader = new BufferedReader(new FileReader(file));
        var builder = new StringBuilder();
        try {
            var line;
            while ((line = reader.readLine()) !== null) {
                builder.append(line).append('\n');
            }
        }
        finally {
            reader.close();
        }
        return builder.toString();
    }

    function formatDuration(milliseconds) {
        var totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
        var hours = Math.floor(totalSeconds / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        var seconds = totalSeconds % 60;
        if (hours > 0) {
            return hours + 'h ' + minutes + 'm ' + seconds + 's';
        }
        if (minutes > 0) {
            return minutes + 'm ' + seconds + 's';
        }
        return seconds + 's';
    }

    function progressDescription(line) {
        var text = String(line || '').trim();
        try {
            var record = JSON.parse(text);
            if (record.epoch !== undefined) {
                var details = 'Epoch ' + record.epoch;
                if (record.epoch_total !== undefined) {
                    details += ' of ' + record.epoch_total;
                }
                if (record.accuracy !== undefined) {
                    details += ' | accuracy ' + (Number(record.accuracy) * 100).toFixed(1) + '%';
                }
                if (record.training_loss !== undefined) {
                    details += ' | loss ' + Number(record.training_loss).toFixed(4);
                }
                return details;
            }
            if (record.discovery !== undefined) {
                return 'Taxonomy images discovered; preparing embeddings';
            }
        }
        catch (ignored) {
        }
        if (text.indexOf('06_Retrain_Insect_Debris_Classifier.py') >= 0) {
            return 'Starting debris classifier training';
        }
        if (text.indexOf('10_Retrain_Taxonomy_Classifier.py') >= 0) {
            return 'Starting taxonomy Order-head training';
        }
        if (text.indexOf('11_Evaluate_Taxonomy_Candidate.py') >= 0) {
            return 'Evaluating taxonomy candidate';
        }
        return text;
    }

    function reviewAndPromote(parent, candidates) {
        var panel = new JPanel(new GridLayout(0, 1, 6, 6));
        var boxes = [];
        for (var i = 0; i < candidates.length; i++) {
            var candidate = candidates[i];
            var box = new JCheckBox(
                String(candidate.name) + (candidate.promotion_recommended ? ' (recommended)' : ''),
                Boolean(candidate.promotion_recommended)
            );
            boxes.push(box);
            panel.add(box);
            panel.add(new JLabel('<html>' + String(candidate.recommendation || 'No recommendation available.') + '</html>'));
        }
        var result = JOptionPane.showConfirmDialog(
            parent,
            panel,
            'Review Model Promotion',
            JOptionPane.OK_CANCEL_OPTION,
            JOptionPane.QUESTION_MESSAGE
        );
        if (result !== JOptionPane.OK_OPTION) {
            return;
        }
        var promoted = [];
        try {
            var copyOptions = Java.to(
                [Packages.java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                 Packages.java.nio.file.StandardCopyOption.COPY_ATTRIBUTES],
                'java.nio.file.CopyOption[]'
            );
            for (var selectedIndex = 0; selectedIndex < candidates.length; selectedIndex++) {
                if (!boxes[selectedIndex].isSelected()) {
                    continue;
                }
                var selected = candidates[selectedIndex];
                var candidateFile = new File(String(selected.candidate_model));
                var activeFile = new File(String(selected.active_model));
                if (!candidateFile.exists()) {
                    throw new Error('Candidate model is missing: ' + candidateFile.getAbsolutePath());
                }
                if (activeFile.exists()) {
                    var backup = new File(
                        activeFile.getAbsolutePath() + '.backup_' + java.lang.System.currentTimeMillis()
                    );
                    Packages.java.nio.file.Files.copy(activeFile.toPath(), backup.toPath(), copyOptions);
                }
                Packages.java.nio.file.Files.copy(candidateFile.toPath(), activeFile.toPath(), copyOptions);
                promoted.push(String(selected.name));
            }
            JOptionPane.showMessageDialog(
                parent,
                promoted.length > 0
                    ? 'Promoted: ' + promoted.join(', ')
                    : 'No models were promoted.',
                'Model Promotion Complete',
                JOptionPane.INFORMATION_MESSAGE
            );
        }
        catch (error) {
            JOptionPane.showMessageDialog(parent, String(error), 'Model Promotion Failed', JOptionPane.ERROR_MESSAGE);
        }
    }

    function showCompletionWindow(parent, exitCode, elapsedMillis, outputDir, launchedAt) {
        var latestJson = new File(outputDir, 'model_update_latest.json');
        var latestText = new File(outputDir, 'model_update_latest.txt');
        var reportFile = latestText;
        var reportText = '';
        var report = null;

        if (latestJson.exists() && latestJson.lastModified() >= launchedAt) {
            try {
                report = JSON.parse(readFile(latestJson));
                if (report.report_text) {
                    reportFile = new File(String(report.report_text));
                }
            }
            catch (error) {
                reportText = 'The saved JSON report could not be read:\n' + String(error) + '\n\n';
            }
        }
        if (reportFile.exists() && reportFile.lastModified() >= launchedAt) {
            reportText = reportText + readFile(reportFile);
        }
        else {
            reportText = reportText
                + (exitCode === 0 ? 'Model update completed.' : 'Model update failed with exit code ' + exitCode + '.')
                + '\nDuration: ' + formatDuration(elapsedMillis)
                + '\n\nNo new completion report was found. Review the progress logs in:\n'
                + outputDir.getAbsolutePath();
        }

        var reportArea = new JTextArea(reportText, 24, 78);
        reportArea.setEditable(false);
        reportArea.setLineWrap(false);
        reportArea.setCaretPosition(0);
        reportArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        var hasCandidates = report !== null
            && report.promotion_candidates
            && report.promotion_candidates.length > 0;
        var options = hasCandidates
            ? ['Review Promotion', 'Open Report', 'Open Reports Folder', 'Close']
            : ['Open Report', 'Open Reports Folder', 'Close'];
        var choice = JOptionPane.showOptionDialog(
            parent,
            new JScrollPane(reportArea),
            exitCode === 0 ? 'Model Update Complete' : 'Model Update Failed',
            JOptionPane.DEFAULT_OPTION,
            exitCode === 0 ? JOptionPane.INFORMATION_MESSAGE : JOptionPane.ERROR_MESSAGE,
            null,
            options,
            options[2]
        );
        try {
            if (hasCandidates && choice === 0) {
                reviewAndPromote(parent, report.promotion_candidates);
            }
            else if (choice === (hasCandidates ? 1 : 0)) {
                Desktop.getDesktop().open(reportFile);
            }
            else if (choice === (hasCandidates ? 2 : 1)) {
                Desktop.getDesktop().open(outputDir);
            }
        }
        catch (error) {
            JOptionPane.showMessageDialog(parent, String(error), 'Open Report Failed', JOptionPane.ERROR_MESSAGE);
        }
    }

    function showProgressWindow(stdoutLog, stderrLog, process, outputDir, launchedAt) {
        var frame = new JFrame('BugPicker Model Update');
        frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
        frame.setLayout(new BorderLayout(8, 8));

        var statusPanel = new JPanel(new BorderLayout(8, 4));
        statusPanel.setBorder(BorderFactory.createEmptyBorder(8, 8, 0, 8));
        var statusLabel = new JLabel('Running model dataset update...');
        var activityBar = new JProgressBar();
        activityBar.setIndeterminate(true);
        statusPanel.add(statusLabel, BorderLayout.NORTH);
        statusPanel.add(activityBar, BorderLayout.SOUTH);
        frame.add(statusPanel, BorderLayout.NORTH);

        var logArea = new JTextArea(26, 95);
        logArea.setEditable(false);
        logArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        frame.add(new JScrollPane(logArea), BorderLayout.CENTER);

        var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
        var folderButton = new JButton('Open Reports');
        var closeButton = new JButton('Close');
        buttons.add(folderButton);
        buttons.add(closeButton);
        frame.add(buttons, BorderLayout.SOUTH);

        folderButton.addActionListener(new ActionListener({
            actionPerformed: function(event) {
                try {
                    Desktop.getDesktop().open(outputDir);
                }
                catch (error) {
                    JOptionPane.showMessageDialog(frame, String(error), 'Open Reports Failed', JOptionPane.ERROR_MESSAGE);
                }
            }
        }));
        closeButton.addActionListener(new ActionListener({
            actionPerformed: function(event) {
                frame.dispose();
            }
        }));

        var timer = new Timer(1000, null);
        timer.addActionListener(new ActionListener({
            actionPerformed: function(event) {
                var text = readTail(stdoutLog, 16000);
                var errors = readTail(stderrLog, 8000);
                if (errors.length > 0) {
                    text = text + '\n--- stderr ---\n' + errors;
                }
                if (text.length === 0) {
                    text = 'Waiting for model update output...';
                }
                logArea.setText(text);
                logArea.setCaretPosition(logArea.getDocument().getLength());
                var elapsedMillis = java.lang.System.currentTimeMillis() - launchedAt;
                if (process.isAlive()) {
                    var stage = 'Waiting for trainer output';
                    var stdoutLines = String(text).split(/\r?\n/);
                    for (var lineIndex = stdoutLines.length - 1; lineIndex >= 0; lineIndex--) {
                        var candidateLine = String(stdoutLines[lineIndex] || '').trim();
                        if (candidateLine.length > 0 && candidateLine !== '--- stderr ---') {
                            stage = candidateLine;
                            break;
                        }
                    }
                    stage = progressDescription(stage);
                    if (stage.length > 110) {
                        stage = stage.substring(0, 107) + '...';
                    }
                    statusLabel.setText(
                        'Working - ' + formatDuration(elapsedMillis) + ' elapsed | ' + stage
                    );
                }
                else {
                    timer.stop();
                    var exitCode = process.exitValue();
                    activityBar.setIndeterminate(false);
                    activityBar.setValue(exitCode === 0 ? 100 : 0);
                    statusLabel.setText(exitCode === 0
                        ? 'Model update finished in ' + formatDuration(elapsedMillis) + '.'
                        : 'Model update exited with code ' + exitCode + ' after ' + formatDuration(elapsedMillis) + '.');
                    showCompletionWindow(frame, exitCode, elapsedMillis, outputDir, launchedAt);
                }
            }
        }));

        frame.pack();
        frame.setLocationRelativeTo(null);
        frame.setVisible(true);
        timer.start();
    }

    var panel = new JPanel(new GridLayout(0, 2, 8, 8));
    panel.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
    var updateDebrisBox = new JCheckBox('Weekly: retrain debris classifier', true);
    var updateTaxonomyBox = new JCheckBox('Weekly: retrain taxonomy Order head', true);
    var updateBackboneBox = new JCheckBox('Monthly: fine-tune taxonomy BioCLIP backbone', false);
    var debrisEpochsField = new JTextField('8', 5);
    var taxonomyEpochsField = new JTextField('8', 5);
    var backboneEpochsField = new JTextField('2', 5);
    panel.add(updateDebrisBox);
    panel.add(new JLabel('Candidate only; review after training'));
    panel.add(updateTaxonomyBox);
    panel.add(new JLabel('Candidate only; review after training'));
    panel.add(updateBackboneBox);
    panel.add(new JLabel('Candidate only; review after training'));
    panel.add(new JLabel('Debris epochs'));
    panel.add(debrisEpochsField);
    panel.add(new JLabel('Taxonomy Order-head epochs'));
    panel.add(taxonomyEpochsField);
    panel.add(new JLabel('BioCLIP backbone epochs'));
    panel.add(backboneEpochsField);

    var result = JOptionPane.showConfirmDialog(
        null,
        panel,
        'Run BugPicker Model Update',
        JOptionPane.OK_CANCEL_OPTION,
        JOptionPane.QUESTION_MESSAGE
    );
    if (result !== JOptionPane.OK_OPTION) {
        throw new Error('Model update cancelled.');
    }

    var updateDir = new File(new File(bugPickerRoot, 'Data'), 'model_update_reports');
    updateDir.mkdirs();
    var stdoutLog = new File(updateDir, 'model_update.out.log');
    var stderrLog = new File(updateDir, 'model_update.err.log');
    var updaterScript = new File(bugPickerRoot, '09_Update_Training_Datasets.py');
    var command = new java.util.ArrayList();
    command.add(python);
    command.add(updaterScript.getAbsolutePath());
    command.add('--openpnp-root');
    command.add(openPnpRoot.getAbsolutePath());
    if (updateDebrisBox.isSelected()) {
        command.add('--run-debris');
    }
    if (updateTaxonomyBox.isSelected()) {
        command.add('--run-taxonomy');
    }
    if (updateBackboneBox.isSelected()) {
        command.add('--run-taxonomy-backbone');
    }
    command.add('--debris-epochs');
    command.add(String(debrisEpochsField.getText()).trim());
    command.add('--taxonomy-epochs');
    command.add(String(taxonomyEpochsField.getText()).trim());
    command.add('--taxonomy-backbone-epochs');
    command.add(String(backboneEpochsField.getText()).trim());

    try {
        var builder = new java.lang.ProcessBuilder(command);
        builder.directory(bugPickerRoot);
        builder.redirectOutput(stdoutLog);
        builder.redirectError(stderrLog);
        var launchedAt = java.lang.System.currentTimeMillis();
        var process = builder.start();
        showProgressWindow(stdoutLog, stderrLog, process, updateDir, launchedAt);
    }
    catch (error) {
        appendText(stderrLog, new Date().toISOString() + ' Failed to launch model update: ' + String(error) + '\n');
        JOptionPane.showMessageDialog(
            null,
            'Failed to launch model update:\n' + String(error) + '\n\nSee:\n' + stderrLog.getAbsolutePath(),
            'Model Update Failed',
            JOptionPane.ERROR_MESSAGE
        );
        throw error;
    }
}
