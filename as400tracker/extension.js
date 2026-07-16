const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let outputChannel;

function activate(context) {
    outputChannel = vscode.window.createOutputChannel('IBM i Active File Tracker');
    outputChannel.appendLine('IBM i Active File Tracker activated');
    console.log('IBM i Active File Tracker activated');

    // Register command to apply text edits
    const applyEditsCommand = vscode.commands.registerCommand('ibmi-active-file-tracker.applyEdits', async (edits) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return { success: false, error: 'No active editor' };
        }

        try {
            const success = await editor.edit(editBuilder => {
                for (const edit of edits) {
                    const document = editor.document;
                    const text = document.getText();
                    
                    // Find the old text in the document
                    const startOffset = text.indexOf(edit.oldText);
                    if (startOffset === -1) {
                        throw new Error(`Text not found: ${edit.oldText.substring(0, 50)}...`);
                    }
                    
                    const startPos = document.positionAt(startOffset);
                    const endPos = document.positionAt(startOffset + edit.oldText.length);
                    const range = new vscode.Range(startPos, endPos);
                    
                    editBuilder.replace(range, edit.newText);
                }
            });
            
            return { success };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
    
    context.subscriptions.push(applyEditsCommand);

    const updateActiveFile = async (editor) => {
        if (!editor) {
            outputChannel.appendLine('No active editor');
            return;
        }

        const uri = editor.document.uri;
        outputChannel.appendLine(`Active editor changed: scheme=${uri.scheme}, path=${uri.path}, fsPath=${uri.fsPath}`);
        
        // Check if this is an IBM i member or streamfile
        // Support both Code for IBM i (member/streamfile) and Rocket DevOps (rdomember)
        const isIBMiScheme = uri.scheme === 'member' || uri.scheme === 'streamfile' || uri.scheme === 'rdomember';
        const isRocketFile = uri.scheme === 'file' && (uri.path.includes('/QSYS.LIB/') || uri.path.includes('\\QSYS.LIB\\'));
        
        outputChannel.appendLine(`isIBMiScheme=${isIBMiScheme}, isRocketFile=${isRocketFile}`);
        
        if (!isIBMiScheme && !isRocketFile) {
            outputChannel.appendLine('Not an IBM i file, skipping');
            return;
        }

        try {
            // Parse IBM i URI
            const uriPath = uri.path;
            let library = '';
            let sourceFile = '';
            let member = '';
            
            if (uri.scheme === 'member' || uri.scheme === 'rdomember') {
                // member://library/sourcefile/member or rdomember://library/sourcefile/member
                const parts = uriPath.split('/').filter(p => p);
                if (parts.length >= 3) {
                    library = parts[0];
                    sourceFile = parts[1];
                    member = parts[2];
                }
            } else if (isRocketFile) {
                // Rocket DevOps: file:///QSYS.LIB/LIBRARY.LIB/SOURCEFILE.FILE/MEMBER.MBR
                const match = uriPath.match(/\/QSYS\.LIB\/([^\/]+)\.LIB\/([^\/]+)\.FILE\/([^\/]+)\.MBR/i) ||
                             uriPath.match(/\\QSYS\.LIB\\([^\\]+)\.LIB\\([^\\]+)\.FILE\\([^\\]+)\.MBR/i);
                if (match) {
                    library = match[1];
                    sourceFile = match[2];
                    member = match[3];
                }
            }

            if (!library || !sourceFile || !member) {
                return;
            }

            // Get current content (including unsaved changes)
            const content = editor.document.getText();
            const isDirty = editor.document.isDirty;

            // Prepare data
            const activeFileData = {
                library,
                sourceFile,
                member,
                content,
                isDirty,
                timestamp: new Date().toISOString()
            };

            // Write to .amazonq/active-file.json
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
                const amazonqDir = path.join(workspaceFolder.uri.fsPath, '.amazonq');
                const activeFilePath = path.join(amazonqDir, 'active-file.json');

                // Create .amazonq directory if it doesn't exist
                if (!fs.existsSync(amazonqDir)) {
                    fs.mkdirSync(amazonqDir, { recursive: true });
                }

                // Write the file
                fs.writeFileSync(activeFilePath, JSON.stringify(activeFileData, null, 2));
            }
        } catch (error) {
            console.error('Error updating active file:', error);
        }
    };

    // Track active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateActiveFile)
    );

    // Track document changes (for unsaved edits)
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (vscode.window.activeTextEditor?.document === event.document) {
                updateActiveFile(vscode.window.activeTextEditor);
            }
        })
    );

    // Initial update
    updateActiveFile(vscode.window.activeTextEditor);

    // Watch for changes to active-file.json
    const watchPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.amazonq');
    outputChannel.appendLine(`Watching for changes at: ${watchPath}`);
    
    const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
        outputChannel.appendLine(`File change detected: ${eventType} - ${filename}`);
        if (filename === 'edit-request.json') {
            outputChannel.appendLine('Edit request detected, handling...');
            setTimeout(() => handleEditRequest(), 50);
        }
        // Sync editor when member file changes (from external process like Claude MCP)
        if (filename &&
            filename !== 'active-file.json' &&
            !filename.includes('edit-') &&
            !filename.includes('diff-')) {
            outputChannel.appendLine(`Member file changed externally: ${filename}`);
            setTimeout(() => syncEditorFromFile(), 200);
        }
    });
    
    context.subscriptions.push({ dispose: () => watcher.close() });
}

async function updateEditorFromJson() {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;
        
        const activeFilePath = path.join(workspaceFolder.uri.fsPath, '.amazonq', 'active-file.json');
        if (!fs.existsSync(activeFilePath)) return;
        
        const activeFileData = JSON.parse(fs.readFileSync(activeFilePath, 'utf-8'));
        const editor = vscode.window.activeTextEditor;
        
        if (!editor) return;
        
        // Check if this is the same file
        const uri = editor.document.uri;
        if (uri.scheme !== 'member') return;
        
        const uriPath = uri.path;
        const parts = uriPath.split('/').filter(p => p);
        if (parts.length < 3) return;
        
        const [library, sourceFile, member] = parts;
        
        if (library !== activeFileData.library || 
            sourceFile !== activeFileData.sourceFile || 
            member !== activeFileData.member) {
            return;
        }
        
        // Update editor content
        const currentContent = editor.document.getText();
        if (currentContent !== activeFileData.content) {
            await editor.edit(editBuilder => {
                const firstLine = editor.document.lineAt(0);
                const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
                const fullRange = new vscode.Range(firstLine.range.start, lastLine.range.end);
                editBuilder.replace(fullRange, activeFileData.content);
            });
            outputChannel.appendLine('Editor updated from JSON');
        }
    } catch (error) {
        outputChannel.appendLine(`Error updating editor: ${error.message}`);
    }
}

async function handleEditRequest() {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            outputChannel.appendLine('No workspace folder found');
            return;
        }
        
        const editRequestPath = path.join(workspaceFolder.uri.fsPath, '.amazonq', 'edit-request.json');
        outputChannel.appendLine(`Looking for edit request at: ${editRequestPath}`);
        
        if (!fs.existsSync(editRequestPath)) {
            outputChannel.appendLine('Edit request file does not exist');
            return;
        }
        
        const requestData = JSON.parse(fs.readFileSync(editRequestPath, 'utf-8'));
        const { edits, requestId, beforePath, afterPath, backupPath } = requestData;
        outputChannel.appendLine(`Processing ${edits.length} edit(s) for request ${requestId}`);
        
        // Show diff if paths provided
        if (beforePath && afterPath && fs.existsSync(beforePath) && fs.existsSync(afterPath)) {
            outputChannel.appendLine('Opening diff view...');
            const beforeUri = vscode.Uri.file(beforePath);
            const afterUri = vscode.Uri.file(afterPath);
            
            await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, 'Changes Preview');
            
            // Wait a bit for user to see the diff
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Apply edits
        const result = await vscode.commands.executeCommand('ibmi-active-file-tracker.applyEdits', edits);
        outputChannel.appendLine(`Edit result: ${JSON.stringify(result)}`);
        
        // Write response
        const responsePath = path.join(workspaceFolder.uri.fsPath, '.amazonq', 'edit-response.json');
        fs.writeFileSync(responsePath, JSON.stringify({ requestId, backupPath, ...result }));
        outputChannel.appendLine(`Response written to: ${responsePath}`);
        
        // Delete request file
        fs.unlinkSync(editRequestPath);
        outputChannel.appendLine('Request file deleted');
    } catch (error) {
        outputChannel.appendLine(`Error handling edit request: ${error.message}`);
        console.error('Error handling edit request:', error);
    }
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
