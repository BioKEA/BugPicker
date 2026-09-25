/**
 * Launch the BugPicker well/nozzle QA label reviewer.
 *
 * This builds training labels for future CV tuning or ML QA models without
 * changing the live picking workflow.
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

    function showProgressWindow(mode, outputDir, stdoutLog, stderrLog, process) {
        var frame = new JFrame('BugPicker QA Label Review - ' + mode);
        frame.setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);
        frame.setLayout(new BorderLayout(8, 8));

        var statusLabel = new JLabel('Launching ' + mode + ' QA label review...');
        statusLabel.setBorder(BorderFactory.createEmptyBorder(8, 8, 0, 8));
        frame.add(statusLabel, BorderLayout.NORTH);

        var logArea = new JTextArea(16, 88);
        logArea.setEditable(false);
        logArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        frame.add(new JScrollPane(logArea), BorderLayout.CENTER);

        var buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
        var folderButton = new JButton('Open QA Feedback');
        var closeButton = new JButton('Cancel Review');
        buttons.add(folderButton);
        buttons.add(closeButton);
        frame.add(buttons, BorderLayout.SOUTH);

        folderButton.addActionListener(new ActionListener({
            actionPerformed: function(event) {
                try {
                    Desktop.getDesktop().open(outputDir);
                }
                catch (error) {
                    JOptionPane.showMessageDialog(frame, String(error), 'Open QA Feedback Failed', JOptionPane.ERROR_MESSAGE);
                }
            }
        }));
        function closeReview() {
            if (process.isAlive()) {
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
            actionPerformed: function(event) { closeReview(); }
        }));
        frame.addWindowListener(new WindowAdapter({
            windowClosing: function(event) { closeReview(); }
        }));

        var timer = new Timer(1000, null);
        timer.addActionListener(new ActionListener({
            actionPerformed: function(event) {
                var text = readTail(stdoutLog, 10000);
                var errors = readTail(stderrLog, 8000);
                if (errors.length > 0) {
                    text = text + '\n--- stderr ---\n' + errors;
                }
                if (text.length === 0) {
                    text = 'Waiting for QA label review output...';
                }
                logArea.setText(text);
                logArea.setCaretPosition(logArea.getDocument().getLength());
                if (!process.isAlive()) {
                    timer.stop();
                    var exitCode = process.exitValue();
                    statusLabel.setText(exitCode === 0
                        ? 'QA label review closed.'
                        : 'QA label review exited with code ' + exitCode + '.');
                    closeButton.setText('Close');
                }
                else {
                    statusLabel.setText('QA label review is running. Use the separate image review window to label examples.');
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
    var modeBox = new JComboBox();
    modeBox.addItem('Well QA');
    modeBox.addItem('Bottom/Nozzle QA');
    var maxExamplesField = new JTextField('250', 8);
    var modelPriorityBox = new JCheckBox('Deep model-priority scoring (slower startup)', false);
    var priorityOnlyBox = new JCheckBox('Legacy operational conflicts only', false);
    var includeReviewedBox = new JCheckBox('Also include reviewed high-confidence images', false);
    panel.add(new JLabel('Review set'));
    panel.add(modeBox);
    panel.add(new JLabel('Max examples'));
    panel.add(maxExamplesField);
    panel.add(modelPriorityBox);
    panel.add(new JLabel('Scores uncertainty and prior errors before opening'));
    panel.add(priorityOnlyBox);
    panel.add(includeReviewedBox);

    var result = JOptionPane.showConfirmDialog(
        null,
        panel,
        'Run BugPicker QA Label Review',
        JOptionPane.OK_CANCEL_OPTION,
        JOptionPane.QUESTION_MESSAGE
    );
    if (result !== JOptionPane.OK_OPTION) {
        throw new Error('QA label review cancelled.');
    }

    var mode = modeBox.getSelectedIndex() === 0 ? 'well' : 'nozzle';
    var feedbackDir = new File(new File(bugPickerRoot, 'Data'), 'qa_feedback');
    feedbackDir.mkdirs();
    var stdoutLog = new File(feedbackDir, 'qa_label_review_' + mode + '.out.log');
    var stderrLog = new File(feedbackDir, 'qa_label_review_' + mode + '.err.log');
    var reviewScript = new File(bugPickerRoot, '13_QA_Label_Review.py');

    var command = new java.util.ArrayList();
    command.add(python);
    command.add(reviewScript.getAbsolutePath());
    command.add('--openpnp-root');
    command.add(openPnpRoot.getAbsolutePath());
    command.add('--mode');
    command.add(mode);
    command.add('--max-examples');
    command.add(String(maxExamplesField.getText()).trim());
    if (modelPriorityBox.isSelected()) {
        command.add('--model-priority');
    }
    if (priorityOnlyBox.isSelected()) {
        command.add('--priority-only');
    }
    if (includeReviewedBox.isSelected()) {
        command.add('--include-reviewed');
    }

    try {
        var builder = new java.lang.ProcessBuilder(command);
        builder.directory(bugPickerRoot);
        builder.redirectOutput(stdoutLog);
        builder.redirectError(stderrLog);
        var process = builder.start();
        showProgressWindow(mode, feedbackDir, stdoutLog, stderrLog, process);
    }
    catch (error) {
        appendText(stderrLog, new Date().toISOString() + ' Failed to launch QA label review: ' + String(error) + '\n');
        JOptionPane.showMessageDialog(
            null,
            'Failed to launch QA label review:\n' + String(error) + '\n\nSee:\n' + stderrLog.getAbsolutePath(),
            'QA Label Review Failed',
            JOptionPane.ERROR_MESSAGE
        );
        throw error;
    }
}
