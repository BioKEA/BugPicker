/** Audit the existing nozzle QA candidate after reviewing new backlog images. */

var imports = new JavaImporter(java.io, javax.swing);
with (imports) {
    var scriptsRoot = new File(scripting.getScriptsDirectory().toString());
    var root = scriptsRoot.getName() === 'BugPicker' ? scriptsRoot : new File(scriptsRoot, 'BugPicker');
    if (!root.exists()) root = scriptsRoot;
    var python = new File(root, '.venv/bin/python');
    var script = new File(root, '16_Audit_QA_Candidate.py');
    var process = new Packages.java.lang.ProcessBuilder(
        python.exists() ? python.getAbsolutePath() : 'python3',
        script.getAbsolutePath()
    ).directory(root).redirectErrorStream(true).start();
    var reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
    var lines = [], line;
    while ((line = reader.readLine()) !== null) lines.push(String(line));
    var exitCode = process.waitFor();
    var output = lines.join('\n');
    if (exitCode !== 0) {
        JOptionPane.showMessageDialog(
            null,
            output,
            'QA Candidate Audit Did Not Pass',
            JOptionPane.WARNING_MESSAGE
        );
    }
    else {
        var answer = JOptionPane.showConfirmDialog(
            null,
            output + '\n\nPromote this audited candidate for live nozzle QA?',
            'QA Candidate Audit Passed',
            JOptionPane.YES_NO_OPTION,
            JOptionPane.QUESTION_MESSAGE
        );
        if (answer === JOptionPane.YES_OPTION) {
            try {
                var modelDir = new File(root, 'Data/qa_feedback/models');
                var candidate = new File(modelDir, 'nozzle_qa_classifier_candidate.pt');
                var active = new File(modelDir, 'nozzle_qa_classifier.pt');
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
                JOptionPane.showMessageDialog(
                    null,
                    'Promoted model:\n' + active.getAbsolutePath(),
                    'QA Candidate Promoted',
                    JOptionPane.INFORMATION_MESSAGE
                );
            }
            catch (error) {
                JOptionPane.showMessageDialog(
                    null,
                    'Could not promote candidate:\n' + String(error),
                    'Promotion Failed',
                    JOptionPane.ERROR_MESSAGE
                );
            }
        }
    }
}
