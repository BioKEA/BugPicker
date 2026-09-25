/**
 * Evaluate current BugPicker CV well/nozzle QA against reviewed QA labels.
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

    function showProgressWindow(mode, reportDir, stdoutLog, stderrLog, process) {
        var frame = new JFrame('BugPicker QA CV Evaluation');
        frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
        frame.setLayout(new BorderLayout(8, 8));

        var statusLabel = new JLabel('Evaluating ' + mode + ' QA labels...');
        statusLabel.setBorder(BorderFactory.createEmptyBorder(8, 8, 0, 8));
        frame.add(statusLabel, BorderLayout.NORTH);

        var logArea = new JTextArea(18, 88);
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
                    Desktop.getDesktop().open(reportDir);
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
                var text = readTail(stdoutLog, 12000);
                var errors = readTail(stderrLog, 8000);
                if (errors.length > 0) {
                    text = text + '\n--- stderr ---\n' + errors;
                }
                if (text.length === 0) {
                    text = 'Waiting for QA CV evaluation output...';
                }
                logArea.setText(text);
                logArea.setCaretPosition(logArea.getDocument().getLength());
                if (!process.isAlive()) {
                    timer.stop();
                    var exitCode = process.exitValue();
                    statusLabel.setText(exitCode === 0
                        ? 'QA CV evaluation finished.'
                        : 'QA CV evaluation exited with code ' + exitCode + '.');
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
    modeBox.addItem('Both');
    modeBox.addItem('Well QA');
    modeBox.addItem('Bottom/Nozzle QA');
    panel.add(new JLabel('Evaluate'));
    panel.add(modeBox);

    var result = JOptionPane.showConfirmDialog(
        null,
        panel,
        'Run BugPicker QA CV Evaluation',
        JOptionPane.OK_CANCEL_OPTION,
        JOptionPane.QUESTION_MESSAGE
    );
    if (result !== JOptionPane.OK_OPTION) {
        throw new Error('QA CV evaluation cancelled.');
    }

    var mode = modeBox.getSelectedIndex() === 1
        ? 'well'
        : modeBox.getSelectedIndex() === 2
        ? 'nozzle'
        : 'both';
    var reportDir = new File(new File(new File(bugPickerRoot, 'Data'), 'qa_feedback'), 'reports');
    reportDir.mkdirs();
    var stdoutLog = new File(reportDir, 'qa_cv_evaluation.out.log');
    var stderrLog = new File(reportDir, 'qa_cv_evaluation.err.log');
    var evalScript = new File(bugPickerRoot, '14_Evaluate_QA_CV.py');

    try {
        var builder = new java.lang.ProcessBuilder(
            python,
            evalScript.getAbsolutePath(),
            '--mode',
            mode,
            '--report-dir',
            reportDir.getAbsolutePath()
        );
        builder.directory(bugPickerRoot);
        builder.redirectOutput(stdoutLog);
        builder.redirectError(stderrLog);
        var process = builder.start();
        showProgressWindow(mode, reportDir, stdoutLog, stderrLog, process);
    }
    catch (error) {
        appendText(stderrLog, new Date().toISOString() + ' Failed to launch QA CV evaluation: ' + String(error) + '\n');
        JOptionPane.showMessageDialog(
            null,
            'Failed to launch QA CV evaluation:\n' + String(error) + '\n\nSee:\n' + stderrLog.getAbsolutePath(),
            'QA CV Evaluation Failed',
            JOptionPane.ERROR_MESSAGE
        );
        throw error;
    }
}
