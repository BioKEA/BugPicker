/**
 * Train candidate BugPicker well/nozzle QA ML models from reviewed QA labels.
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
        var builder = new java.lang.StringBuilder();
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
        var builder = new java.lang.StringBuilder();
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

    function completedExitCode(process) {
        try {
            return process.exitValue();
        }
        catch (error) {
            // Java 8 throws IllegalThreadStateException while the process is alive.
            return null;
        }
    }

    function showProgressWindow(mode, modelDir, stdoutLog, stderrLog, process) {
        var frame = new JFrame('BugPicker QA Model Training');
        frame.setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);
        frame.setLayout(new BorderLayout(8, 8));

        var statusLabel = new JLabel('Training ' + mode + ' QA candidate model...');
        statusLabel.setBorder(BorderFactory.createEmptyBorder(8, 8, 0, 8));
        frame.add(statusLabel, BorderLayout.NORTH);

        var logArea = new JTextArea(22, 92);
        logArea.setEditable(false);
        logArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        frame.add(new JScrollPane(logArea), BorderLayout.CENTER);

        var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
        var folderButton = new JButton('Open Models');
        var promoteButton = new JButton('Promote Candidate');
        promoteButton.setEnabled(false);
        var closeButton = new JButton('Cancel Training');
        buttons.add(folderButton);
        buttons.add(promoteButton);
        buttons.add(closeButton);
        frame.add(buttons, BorderLayout.SOUTH);

        folderButton.addActionListener(new ActionListener({
            actionPerformed: function(event) {
                try {
                    Desktop.getDesktop().open(modelDir);
                }
                catch (error) {
                    JOptionPane.showMessageDialog(frame, String(error), 'Open Models Failed', JOptionPane.ERROR_MESSAGE);
                }
            }
        }));
        function requestClose() {
            if (completedExitCode(process) === null) {
                var answer = JOptionPane.showConfirmDialog(
                    frame,
                    'Training is still running. Cancel it and close this window?',
                    'Cancel QA Training',
                    JOptionPane.YES_NO_OPTION,
                    JOptionPane.WARNING_MESSAGE
                );
                if (answer !== JOptionPane.YES_OPTION) {
                    return;
                }
                process.destroy();
                try {
                    if (!process.waitFor(5, Packages.java.util.concurrent.TimeUnit.SECONDS)) {
                        process.destroyForcibly();
                    }
                }
                catch (stopError) {
                    process.destroyForcibly();
                }
            }
            frame.dispose();
        }
        closeButton.addActionListener(new ActionListener({
            actionPerformed: function(event) {
                requestClose();
            }
        }));
        frame.addWindowListener(new WindowAdapter({
            windowClosing: function(event) {
                requestClose();
            }
        }));
        var latestReport = null;
        promoteButton.addActionListener(new ActionListener({
            actionPerformed: function(event) {
                if (latestReport === null) {
                    return;
                }
                var recommendation = String(latestReport.recommendation || 'No recommendation available.');
                var answer = JOptionPane.showConfirmDialog(
                    frame,
                    recommendation + '\n\nPromote this candidate for live QA?',
                    'Promote QA Candidate',
                    JOptionPane.YES_NO_OPTION,
                    latestReport.promotion_recommended
                        ? JOptionPane.QUESTION_MESSAGE
                        : JOptionPane.WARNING_MESSAGE
                );
                if (answer !== JOptionPane.YES_OPTION) {
                    return;
                }
                try {
                    var candidate = new File(String(latestReport.candidate_model));
                    var active = new File(modelDir, mode + '_qa_classifier.pt');
                    var copyOptions = Java.to(
                        [Packages.java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                         Packages.java.nio.file.StandardCopyOption.COPY_ATTRIBUTES],
                        'java.nio.file.CopyOption[]'
                    );
                    if (active.exists()) {
                        var backup = new File(
                            modelDir,
                            active.getName() + '.backup_' + java.lang.System.currentTimeMillis()
                        );
                        Packages.java.nio.file.Files.copy(active.toPath(), backup.toPath(), copyOptions);
                    }
                    Packages.java.nio.file.Files.copy(candidate.toPath(), active.toPath(), copyOptions);
                    promoteButton.setEnabled(false);
                    statusLabel.setText('QA candidate promoted for live use.');
                    JOptionPane.showMessageDialog(
                        frame,
                        'Promoted model:\n' + active.getAbsolutePath(),
                        'QA Candidate Promoted',
                        JOptionPane.INFORMATION_MESSAGE
                    );
                }
                catch (error) {
                    JOptionPane.showMessageDialog(
                        frame,
                        'Could not promote candidate:\n' + String(error),
                        'Promotion Failed',
                        JOptionPane.ERROR_MESSAGE
                    );
                }
            }
        }));

        var timer = new Timer(1000, null);
        timer.addActionListener(new ActionListener({
            actionPerformed: function(event) {
                var text = readTail(stdoutLog, 16000);
                var errors = readTail(stderrLog, 10000);
                if (errors.length > 0) {
                    text = text + '\n--- stderr ---\n' + errors;
                }
                if (text.length === 0) {
                    text = 'Waiting for QA model training output...';
                }
                logArea.setText(text);
                logArea.setCaretPosition(logArea.getDocument().getLength());
                var exitCode = completedExitCode(process);
                if (exitCode !== null) {
                    timer.stop();
                    var elapsedSeconds = Math.round(
                        (java.lang.System.currentTimeMillis() - startedAt) / 1000.0
                    );
                    if (exitCode === 0) {
                        var reportFile = new File(
                            modelDir,
                            mode + '_qa_classifier_report.json'
                        );
                        var reportText = readFile(reportFile);
                        var summary = 'QA model training finished successfully in '
                            + elapsedSeconds + ' seconds.\n';
                        if (reportText.length > 0) {
                            try {
                                var report = JSON.parse(String(reportText));
                                latestReport = report;
                                var validation = report.validation || {};
                                var accuracy = Number(validation.accuracy);
                                summary += '\nResults\n';
                                if (report.nozzle_framework_version) {
                                    summary += '  Nozzle framework: v'
                                        + report.nozzle_framework_version + '\n';
                                    summary += '  Tip crop fraction: '
                                        + Number(report.nozzle_tip_crop_fraction).toFixed(2) + '\n';
                                }
                                summary += '  Labeled examples: ' + report.examples_total + '\n';
                                summary += '  Training examples: ' + report.train_examples + '\n';
                                summary += '  Validation examples: ' + report.validation_examples + '\n';
                                if (report.training_runs) {
                                    summary += '  Training runs: ' + report.training_runs
                                        + ' (selected run ' + report.selected_run
                                        + ', seed ' + report.selected_seed + ')\n';
                                }
                                if (!isNaN(accuracy)) {
                                    summary += '  Validation accuracy: '
                                        + (accuracy * 100.0).toFixed(1) + '%\n';
                                }
                                var balancedAccuracy = Number(validation.balanced_accuracy);
                                if (!isNaN(balancedAccuracy)) {
                                    summary += '  Balanced accuracy: '
                                        + (balancedAccuracy * 100.0).toFixed(1) + '%\n';
                                }
                                if (report.class_counts) {
                                    summary += '  Class counts: '
                                        + JSON.stringify(report.class_counts) + '\n';
                                }
                                if (validation.per_class_recall) {
                                    summary += '  Per-class recall: '
                                        + JSON.stringify(validation.per_class_recall) + '\n';
                                }
                                if (report.operational_decision) {
                                    var decision = report.operational_decision;
                                    summary += '  False-empty specimen frames: '
                                        + decision.false_empty_count + ' / '
                                        + decision.specimen_frames + '\n';
                                    summary += '  True empty frames cleared: '
                                        + decision.true_empty_clear_count + ' / '
                                        + decision.empty_frames + '\n';
                                    summary += '  Empty confidence threshold: '
                                        + Number(decision.empty_confidence_threshold).toFixed(3) + '\n';
                                }
                                if (report.operational_pair_decision) {
                                    var pairDecision = report.operational_pair_decision;
                                    summary += '  False-empty specimen pairs: '
                                        + pairDecision.false_empty_pair_count + ' / '
                                        + pairDecision.specimen_pairs + '\n';
                                    summary += '  Empty pairs cleared: '
                                        + pairDecision.true_empty_pair_clear_count + ' / '
                                        + pairDecision.empty_pairs + '\n';
                                    summary += '  Live pair threshold: '
                                        + Number(pairDecision.empty_confidence_threshold).toFixed(3) + '\n';
                                }
                                summary += '\nRecommendation\n  '
                                    + String(report.recommendation || 'No recommendation available.') + '\n';
                                summary += '  Candidate model: ' + report.candidate_model + '\n';
                                summary += '  Promoted: '
                                    + (report.promoted_model ? 'yes' : 'no') + '\n';
                                summary += '  Report: ' + reportFile.getAbsolutePath() + '\n';
                                promoteButton.setEnabled(true);
                            }
                            catch (error) {
                                summary += '\nThe report was created but could not be parsed: '
                                    + String(error) + '\n';
                            }
                        }
                        else {
                            summary += '\nNo training report was created.\n';
                        }
                        if (text.length > 0) {
                            summary += '\nTraining output\n' + text;
                        }
                        logArea.setText(summary);
                        statusLabel.setText('QA model training finished successfully.');
                        closeButton.setText('Close');
                    }
                    else {
                        statusLabel.setText('QA model training failed (exit code '
                            + exitCode + ').');
                        logArea.setText(
                            'QA model training failed after ' + elapsedSeconds
                            + ' seconds (exit code ' + exitCode + ').\n\n' + text
                        );
                        closeButton.setText('Close');
                    }
                    logArea.setCaretPosition(0);
                }
            }
        }));

        frame.pack();
        frame.setLocationRelativeTo(null);
        frame.setVisible(true);
        var startedAt = java.lang.System.currentTimeMillis();
        timer.start();
    }

    var panel = new JPanel(new GridLayout(0, 2, 8, 8));
    panel.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
    var modeBox = new JComboBox();
    modeBox.addItem('Well QA');
    modeBox.addItem('Bottom/Nozzle QA');
    var epochsField = new JTextField('8', 6);
    var runsField = new JTextField('3', 6);
    modeBox.addActionListener(new ActionListener({
        actionPerformed: function(event) {
            if (modeBox.getSelectedIndex() === 1) {
                epochsField.setText('4');
                runsField.setText('1');
            }
            else {
                epochsField.setText('8');
                runsField.setText('3');
            }
        }
    }));
    panel.add(new JLabel('Model'));
    panel.add(modeBox);
    panel.add(new JLabel('Epochs'));
    panel.add(epochsField);
    panel.add(new JLabel('Training runs'));
    panel.add(runsField);

    var result = JOptionPane.showConfirmDialog(
        null,
        panel,
        'Train BugPicker QA Model',
        JOptionPane.OK_CANCEL_OPTION,
        JOptionPane.QUESTION_MESSAGE
    );
    if (result !== JOptionPane.OK_OPTION) {
        throw new Error('QA model training cancelled.');
    }

    var mode = modeBox.getSelectedIndex() === 0 ? 'well' : 'nozzle';
    var qaDir = new File(new File(bugPickerRoot, 'Data'), 'qa_feedback');
    var modelDir = new File(qaDir, 'models');
    modelDir.mkdirs();
    var sessionId = String(java.lang.System.currentTimeMillis());
    var stdoutLog = new File(modelDir, 'qa_model_train_' + mode + '_' + sessionId + '.out.log');
    var stderrLog = new File(modelDir, 'qa_model_train_' + mode + '_' + sessionId + '.err.log');
    var trainScript = new File(bugPickerRoot, '15_Retrain_QA_Classifier.py');

    var command = new java.util.ArrayList();
    command.add(python);
    command.add(trainScript.getAbsolutePath());
    command.add('--mode');
    command.add(mode);
    command.add('--epochs');
    command.add(String(epochsField.getText()).trim());
    command.add('--runs');
    command.add(String(runsField.getText()).trim());
    command.add('--parent-pid');
    command.add(String(Packages.java.lang.ProcessHandle.current().pid()));

    try {
        var builder = new java.lang.ProcessBuilder(command);
        builder.directory(bugPickerRoot);
        builder.redirectOutput(stdoutLog);
        builder.redirectError(stderrLog);
        var process = builder.start();
        showProgressWindow(mode, modelDir, stdoutLog, stderrLog, process);
    }
    catch (error) {
        appendText(stderrLog, new Date().toISOString() + ' Failed to launch QA model training: ' + String(error) + '\n');
        JOptionPane.showMessageDialog(
            null,
            'Failed to launch QA model training:\n' + String(error) + '\n\nSee:\n' + stderrLog.getAbsolutePath(),
            'QA Model Training Failed',
            JOptionPane.ERROR_MESSAGE
        );
        throw error;
    }
}
