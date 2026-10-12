/**
 * Direct BugPicker taxonomy entry point.
 *
 * Run this from OpenPnP to classify/review an already completed plate without
 * launching the full picking workflow.
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

    function normalizePlateNumber(text) {
        var value = String(text || '').trim().toUpperCase();
        value = value.replace(/[^A-Z0-9_-]/g, '');
        if (value.length === 0) {
            throw new Error('Plate number must not be blank.');
        }
        return value;
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

    function showProgressWindow(plateNumber, mode, taxonomyDir, stdoutLog, stderrLog, process) {
        var frame = new JFrame('BugPicker Taxonomy - ' + plateNumber);
        frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
        frame.setLayout(new BorderLayout(8, 8));

        var statusLabel = new JLabel('Running ' + mode + ' taxonomy for plate ' + plateNumber + '...');
        statusLabel.setBorder(BorderFactory.createEmptyBorder(8, 8, 0, 8));
        frame.add(statusLabel, BorderLayout.NORTH);

        var logArea = new JTextArea(24, 90);
        logArea.setEditable(false);
        logArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        var scroll = new JScrollPane(logArea);
        scroll.setBorder(BorderFactory.createTitledBorder('Live log'));
        frame.add(scroll, BorderLayout.CENTER);

        var buttonPanel = new JPanel(new FlowLayout(FlowLayout.RIGHT));
        var folderButton = new JButton('Open Folder');
        var closeButton = new JButton('Close');
        buttonPanel.add(folderButton);
        buttonPanel.add(closeButton);
        frame.add(buttonPanel, BorderLayout.SOUTH);

        folderButton.addActionListener(new ActionListener({
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
        closeButton.addActionListener(new ActionListener({
            actionPerformed: function(event) {
                frame.dispose();
            }
        }));

        function processExitCode() {
            try {
                return process.exitValue();
            }
            catch (stillRunning) {
                return null;
            }
        }

        function summaryExitCode() {
            var summaryFile = new File(taxonomyDir, 'taxonomy_predictions_summary.json');
            if (!summaryFile.exists()) {
                return null;
            }
            try {
                var text = readTail(summaryFile, 4000);
                var summary = JSON.parse(String(text));
                if (summary.errors !== undefined && Number(summary.errors) === 0) {
                    return 0;
                }
            }
            catch (summaryError) {
                return null;
            }
            return null;
        }

        var finishedAt = null;
        var timer = new Timer(1000, null);
        timer.addActionListener(new ActionListener({
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
                var exitCode = processExitCode();
                if (exitCode === null) {
                    exitCode = summaryExitCode();
                }
                if (exitCode !== null) {
                    timer.stop();
                    statusLabel.setText(
                        exitCode === 0
                            ? 'Taxonomy finished for plate ' + plateNumber + '.'
                            : 'Taxonomy exited with code ' + exitCode + ' for plate ' + plateNumber + '.'
                    );
                    finishedAt = new Date().getTime();
                    var closeTimer = new Timer(5000, null);
                    closeTimer.addActionListener(new ActionListener({
                        actionPerformed: function(closeEvent) {
                            closeTimer.stop();
                            if (frame.isDisplayable() && finishedAt !== null) {
                                frame.dispose();
                            }
                        }
                    }));
                    closeTimer.start();
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
    var plateField = new JTextField('', 12);
    var modeBox = new JComboBox();
    modeBox.addItem('Train Taxonomy');
    modeBox.addItem('Auto Taxonomy');
    modeBox.setSelectedIndex(0);
    panel.add(new JLabel('Plate number'));
    panel.add(plateField);
    panel.add(new JLabel('Mode'));
    panel.add(modeBox);

    var result = JOptionPane.showConfirmDialog(
        null,
        panel,
        'Run BugPicker Taxonomy',
        JOptionPane.OK_CANCEL_OPTION,
        JOptionPane.QUESTION_MESSAGE
    );
    if (result !== JOptionPane.OK_OPTION) {
        throw new Error('Taxonomy launch cancelled.');
    }

    var plateNumber = normalizePlateNumber(plateField.getText());
    var mode = modeBox.getSelectedIndex() === 1 ? 'auto' : 'train';
    var taxonomyScript = new File(bugPickerRoot, '08_Classify_Plate_Taxonomy.py');
    var taxonomyDir = new File(new File(openPnpRoot, 'Plate_taxonomy'), 'P-' + plateNumber);
    taxonomyDir.mkdirs();
    var stdoutLog = new File(taxonomyDir, 'taxonomy_classifier_manual.out.log');
    var stderrLog = new File(taxonomyDir, 'taxonomy_classifier_manual.err.log');
    var staleSummary = new File(taxonomyDir, 'taxonomy_predictions_summary.json');
    if (staleSummary.exists()) {
        staleSummary.delete();
    }

    try {
        var builder = new java.lang.ProcessBuilder(
            python,
            taxonomyScript.getAbsolutePath(),
            '--openpnp-root',
            openPnpRoot.getAbsolutePath(),
            '--plate',
            plateNumber,
            '--mode',
            mode
        );
        builder.directory(openPnpRoot);
        builder.redirectOutput(stdoutLog);
        builder.redirectError(stderrLog);
        var process = builder.start();
        showProgressWindow(plateNumber, mode, taxonomyDir, stdoutLog, stderrLog, process);
    }
    catch (error) {
        appendText(stderrLog, new Date().toISOString() + ' Failed to launch taxonomy: ' + String(error) + '\n');
        JOptionPane.showMessageDialog(
            null,
            'Failed to launch taxonomy for plate ' + plateNumber + ':\n'
                + String(error) + '\n\nSee:\n' + stderrLog.getAbsolutePath(),
            'Taxonomy Launch Failed',
            JOptionPane.ERROR_MESSAGE
        );
        throw error;
    }
}
