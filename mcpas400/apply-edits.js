export async function applyEditsToActiveFile(edits) {
    const fs = await import('fs/promises');
    const path = await import('path');
    // Read active file to detect line endings
    const activeFilePath = path.join(process.cwd(), '.amazonq', 'active-file.json');
    let normalizedEdits = edits;
    try {
        const activeFileData = JSON.parse(await fs.readFile(activeFilePath, 'utf-8'));
        const content = activeFileData.content || '';
        // Detect line endings: \r\n (Windows) or \n (Unix)
        const hasWindowsLineEndings = content.includes('\r\n');
        if (hasWindowsLineEndings) {
            // Normalize edits to use Windows line endings
            normalizedEdits = edits.map(edit => ({
                oldText: edit.oldText.replace(/\n/g, '\r\n'),
                newText: edit.newText.replace(/\n/g, '\r\n')
            }));
        }
    }
    catch {
        // If can't read active file, use edits as-is
    }
    const requestId = Date.now().toString();
    const amazonqDir = path.join(process.cwd(), '.amazonq');
    const requestPath = path.join(amazonqDir, 'edit-request.json');
    const responsePath = path.join(amazonqDir, 'edit-response.json');
    // Create .amazonq directory if it doesn't exist
    try {
        await fs.mkdir(amazonqDir, { recursive: true });
    }
    catch { }
    // Write edit request
    await fs.writeFile(requestPath, JSON.stringify({ requestId, edits: normalizedEdits }));
    // Wait for response (with timeout)
    const maxWait = 5000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
        try {
            const responseContent = await fs.readFile(responsePath, 'utf-8');
            const response = JSON.parse(responseContent);
            if (response.requestId === requestId) {
                // Clean up response file
                await fs.unlink(responsePath).catch(() => { });
                return response;
            }
        }
        catch {
            // File doesn't exist yet, wait
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timeout waiting for VS Code to apply edits');
}
//# sourceMappingURL=apply-edits.js.map
