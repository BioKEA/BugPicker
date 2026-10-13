/** Commit and push BugPicker source changes through a guided window. */

var imports = new JavaImporter(java.io, javax.swing, java.awt, java.awt.event);
with (imports) {
    function readTail(file, maxChars) {
        if (!file.exists()) return '';
        var reader = new BufferedReader(new FileReader(file));
        var text = new java.lang.StringBuilder();
        try {
            var line;
            while ((line = reader.readLine()) !== null) text.append(line).append('\n');
        }
        finally { reader.close(); }
        return text.length() > maxChars
            ? text.substring(text.length() - maxChars) : text.toString();
    }

    function showProgress(root, process, output) {
        var frame = new JFrame('BugPicker GitHub Backup');
        var area = new JTextArea(18, 76);
        area.setEditable(false);
        area.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        var status = new JLabel('Uploading changes...');
        frame.setLayout(new BorderLayout(8, 8));
        frame.add(status, BorderLayout.NORTH);
        frame.add(new JScrollPane(area), BorderLayout.CENTER);
        frame.pack();
        frame.setLocation(30, 30);
        frame.setVisible(true);
        var timer = new Timer(750, null);
        timer.addActionListener(new ActionListener({actionPerformed: function(event) {
            area.setText(readTail(output, 24000));
            area.setCaretPosition(area.getDocument().getLength());
            if (!process.isAlive()) {
                timer.stop();
                var code = process.exitValue();
                status.setText(code === 0
                    ? 'Backup completed successfully.'
                    : 'Backup stopped with an error. No token was saved.');
                JOptionPane.showMessageDialog(
                    frame,
                    code === 0
                        ? 'GitHub backup completed successfully.'
                        : 'GitHub backup failed. Review the details in this window.',
                    code === 0 ? 'Backup Complete' : 'Backup Failed',
                    code === 0 ? JOptionPane.INFORMATION_MESSAGE : JOptionPane.ERROR_MESSAGE
                );
            }
        }}));
        timer.start();
    }

    var scriptsRoot = new File(scripting.getScriptsDirectory().toString());
    var root = scriptsRoot.getName() === 'BugPicker'
        ? scriptsRoot : new File(scriptsRoot, 'BugPicker');
    if (!root.exists()) root = scriptsRoot;
    var panel = new JPanel(new GridLayout(0, 2, 8, 6));
    var username = new JTextField('', 20);
    var token = new JPasswordField('', 20);
    var message = new JTextField('Update BugPicker programs', 28);
    var models = new JCheckBox('Include active ML models', false);
    panel.add(new JLabel('GitHub username')); panel.add(username);
    panel.add(new JLabel('Personal access token')); panel.add(token);
    panel.add(new JLabel('Commit message')); panel.add(message);
    panel.add(new JLabel('Models')); panel.add(models);
    panel.add(new JLabel(''));
    panel.add(new JLabel('<html>The token is used once and is not saved.</html>'));
    var choice = JOptionPane.showConfirmDialog(
        null, panel, 'GitHub Backup',
        JOptionPane.OK_CANCEL_OPTION, JOptionPane.PLAIN_MESSAGE
    );
    if (choice === JOptionPane.OK_OPTION) {
        var userText = String(username.getText()).trim();
        var tokenText = String(new java.lang.String(token.getPassword()));
        var messageText = String(message.getText()).trim();
        if (!userText || !tokenText || !messageText) {
            JOptionPane.showMessageDialog(
                null, 'Username, token, and commit message are required.',
                'Missing Information', JOptionPane.ERROR_MESSAGE
            );
        }
        else {
            var logDir = new File(root, 'Data/github_sync');
            logDir.mkdirs();
            var output = new File(logDir, 'github_backup.log');
            var command = new java.util.ArrayList();
            command.add('python3');
            command.add(new File(root, 'github_sync.py').getAbsolutePath());
            command.add('backup');
            command.add('--repo'); command.add(root.getAbsolutePath());
            command.add('--username'); command.add(userText);
            command.add('--message'); command.add(messageText);
            if (models.isSelected()) command.add('--include-models');
            var builder = new java.lang.ProcessBuilder(command);
            builder.directory(root);
            builder.redirectErrorStream(true);
            builder.redirectOutput(output);
            var process = builder.start();
            var writer = new BufferedWriter(
                new OutputStreamWriter(process.getOutputStream())
            );
            writer.write(tokenText); writer.newLine(); writer.close();
            tokenText = '';
            showProgress(root, process, output);
        }
    }
}
