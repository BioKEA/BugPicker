/** Review and promote candidates from the latest completed model update. */

var imports = new JavaImporter(java.io, javax.swing, java.awt);
with (imports) {
    function readFile(file) {
        var reader = new BufferedReader(new FileReader(file));
        var builder = new Packages.java.lang.StringBuilder();
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

    var scriptsRoot = new File(scripting.getScriptsDirectory().toString());
    var root = scriptsRoot.getName() === 'BugPicker' ? scriptsRoot : new File(scriptsRoot, 'BugPicker');
    if (!root.exists()) root = scriptsRoot;
    var reportFile = new File(root, 'Data/model_update_reports/model_update_latest.json');
    if (!reportFile.exists()) {
        JOptionPane.showMessageDialog(
            null,
            'No completed model-update report was found.',
            'No Model Update Report',
            JOptionPane.WARNING_MESSAGE
        );
    }
    else {
        var report = JSON.parse(readFile(reportFile));
        var candidates = report.promotion_candidates || [];
        if (String(report.status || '') !== 'completed' || candidates.length === 0) {
            JOptionPane.showMessageDialog(
                null,
                'The latest report has no completed candidates available for promotion.',
                'No Candidates Available',
                JOptionPane.WARNING_MESSAGE
            );
        }
        else {
            var panel = new JPanel(new GridLayout(0, 1, 6, 6));
            panel.add(new JLabel('<html>Select the existing trained candidates to promote.<br>No training will be run.</html>'));
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
                null,
                panel,
                'Review Existing Model Candidates',
                JOptionPane.OK_CANCEL_OPTION,
                JOptionPane.QUESTION_MESSAGE
            );
            if (result === JOptionPane.OK_OPTION) {
                var promoted = [];
                try {
                    var copyOptions = Java.to(
                        [Packages.java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                         Packages.java.nio.file.StandardCopyOption.COPY_ATTRIBUTES],
                        'java.nio.file.CopyOption[]'
                    );
                    for (var selectedIndex = 0; selectedIndex < candidates.length; selectedIndex++) {
                        if (!boxes[selectedIndex].isSelected()) continue;
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
                        null,
                        promoted.length > 0 ? 'Promoted: ' + promoted.join(', ') : 'No models were selected.',
                        'Model Promotion Complete',
                        JOptionPane.INFORMATION_MESSAGE
                    );
                }
                catch (error) {
                    JOptionPane.showMessageDialog(
                        null,
                        String(error),
                        'Model Promotion Failed',
                        JOptionPane.ERROR_MESSAGE
                    );
                }
            }
        }
    }
}
