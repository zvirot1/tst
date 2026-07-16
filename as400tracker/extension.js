const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let outputChannel;
let isUpdatingFromWatcher = false;
let isWritingToAmazonq = false;

function activate(context) {
    outputChannel = vscode.window.createOutputChannel('IBM i Tracker');
    outputChannel.appendLine('IBM i Tracker activated!');
    
    // Write editor content to .amazonq
    const writeToAmazonq = (editor) => {
        if (!editor) return;
        if (isUpdatingFromWatcher) {
            outputChannel.appendLine('[SKIP] isUpdatingFromWatcher = true');
            return;
        }
        
        const uri = editor.document.uri;
        outputChannel.appendLine(`[WRITE] scheme: ${uri.scheme}, path: ${uri.path}`);
        
        // Check if IBM i file
        const isIBMi = uri.scheme === 'member' || uri.scheme === 'rdomember';
        const isRocket = uri.scheme === 'file' && uri.path.includes('/QSYS.LIB/');
        
        if (!isIBMi && !isRocket) {
            outputChannel.appendLine('[SKIP] Not an IBM i file');
            return;
        }
        
        let library, sourceFile, member;
        
        if (isIBMi) {
            const parts = uri.path.split('/').filter(p => p);
            if (parts.length < 3) return;
            [library, sourceFile, member] = parts;
        } else if (isRocket) {
            const match = uri.path.match(/\/QSYS\.LIB\/([^\/]+)\.LIB\/([^\/]+)\.FILE\/([^\/]+)\.MBR/i);
            if (!match) return;
            [, library, sourceFile, member] = match;
        }
        
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;
        
        const dir = path.join(workspaceFolder.uri.fsPath, '.amazonq', library, sourceFile);
        const filePath = path.join(dir, member);
        
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        isWritingToAmazonq = true;
        fs.writeFileSync(filePath, editor.document.getText());

        // Write active-file.json
        const activeFilePath = path.join(workspaceFolder.uri.fsPath, '.amazonq', 'active-file.json');
        fs.writeFileSync(activeFilePath, JSON.stringify({ library, sourceFile, member }, null, 2));
        setTimeout(() => { isWritingToAmazonq = false; }, 500);

        outputChannel.appendLine(`[WRITE] ✅ ${library}/${sourceFile}/${member}`);
    };
    
    // Track editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(writeToAmazonq),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.scheme === 'output') return;
            if (vscode.window.activeTextEditor?.document === e.document) {
                writeToAmazonq(vscode.window.activeTextEditor);
            }
        })
    );
    
    // Initial write
    writeToAmazonq(vscode.window.activeTextEditor);
    
    // Watch .amazonq directory using VS Code API (reliable for external process changes)
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        const watchPattern = new vscode.RelativePattern(workspaceFolder, '.amazonq/**/*');
        outputChannel.appendLine(`[WATCH] Watching: ${workspaceFolder.uri.fsPath}/.amazonq/**/*`);

        const watcher = vscode.workspace.createFileSystemWatcher(watchPattern);

        const onFileChange = (uri) => {
            if (isWritingToAmazonq) {
                outputChannel.appendLine(`[WATCH] Skipping - own write`);
                return;
            }
            const filename = uri.fsPath;
            // Handle edit-request.json - apply edits directly to editor
            if (filename.endsWith('edit-request.json')) {
                outputChannel.appendLine(`[WATCH] Edit request detected: ${filename}`);
                setTimeout(() => handleEditRequest(filename), 50);
                return;
            }
            if (!filename.includes('active-file.json') &&
                !filename.includes('rules') &&
                !filename.includes('temp')) {
                outputChannel.appendLine(`[WATCH] File changed externally: ${filename}`);
                setTimeout(() => syncEditorFromFile(), 200);
            }
        };

        watcher.onDidChange(onFileChange);
        watcher.onDidCreate(onFileChange);

        context.subscriptions.push(watcher);
    }
    
    // Sync editor from .amazonq file
    async function syncEditorFromFile() {
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                outputChannel.appendLine('[SYNC] No active editor');
                return;
            }
            
            const uri = editor.document.uri;
            const isIBMi = uri.scheme === 'member' || uri.scheme === 'rdomember';
            const isRocket = uri.scheme === 'file' && uri.path.includes('/QSYS.LIB/');
            
            if (!isIBMi && !isRocket) {
                outputChannel.appendLine('[SYNC] Not an IBM i file');
                return;
            }
            
            let library, sourceFile, member;
            
            if (isIBMi) {
                const parts = uri.path.split('/').filter(p => p);
                if (parts.length < 3) return;
                [library, sourceFile, member] = parts;
            } else if (isRocket) {
                const match = uri.path.match(/\/QSYS\.LIB\/([^\/]+)\.LIB\/([^\/]+)\.FILE\/([^\/]+)\.MBR/i);
                if (!match) return;
                [, library, sourceFile, member] = match;
            }
            
            const workspaceFolder2 = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder2) return;
            
            const memberFilePath = path.join(workspaceFolder2.uri.fsPath, '.amazonq', library, sourceFile, member);
            if (!fs.existsSync(memberFilePath)) {
                outputChannel.appendLine('[SYNC] File not found');
                return;
            }
            
            const fileContent = fs.readFileSync(memberFilePath, 'utf-8');
            const editorContent = editor.document.getText();
            
            if (fileContent !== editorContent) {
                outputChannel.appendLine('[SYNC] Contents differ - updating editor');
                isUpdatingFromWatcher = true;
                
                await editor.edit(editBuilder => {
                    const firstLine = editor.document.lineAt(0);
                    const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
                    const fullRange = new vscode.Range(firstLine.range.start, lastLine.range.end);
                    editBuilder.replace(fullRange, fileContent);
                });
                
                outputChannel.appendLine('[SYNC] ✅ Editor updated');
                setTimeout(() => { 
                    isUpdatingFromWatcher = false;
                    outputChannel.appendLine('[SYNC] isUpdatingFromWatcher = false');
                }, 1000);
            } else {
                outputChannel.appendLine('[SYNC] Contents match - no update needed');
            }
        } catch (error) {
            outputChannel.appendLine(`[SYNC] Error: ${error.message}`);
        }
    }
    
    outputChannel.appendLine('IBM i Tracker ready!');

    const isIBMiEditor = (e) => e && (
        e.document.uri.scheme === 'member' ||
        e.document.uri.scheme === 'rdomember' ||
        (e.document.uri.scheme === 'file' && e.document.uri.path.includes('/QSYS.LIB/'))
    );

    async function handleEditRequest(requestFilePath) {
        try {
            if (!fs.existsSync(requestFilePath)) return;

            const requestData = JSON.parse(fs.readFileSync(requestFilePath, 'utf-8'));
            const { edits, requestId } = requestData;
            outputChannel.appendLine(`[EDIT] Processing ${edits.length} edit(s), requestId=${requestId}`);

            // Find IBM i editor - check active first, then all visible editors
            let editor = vscode.window.activeTextEditor;
            if (!isIBMiEditor(editor)) {
                editor = vscode.window.visibleTextEditors.find(isIBMiEditor);
            }
            if (!editor) {
                outputChannel.appendLine('[EDIT] No IBM i editor found');
                return;
            }

            let success = false;
            try {
                success = await editor.edit(editBuilder => {
                    for (const edit of edits) {
                        const text = editor.document.getText();
                        const startOffset = text.indexOf(edit.oldText);
                        if (startOffset === -1) {
                            throw new Error(`Text not found: ${edit.oldText.substring(0, 50)}`);
                        }
                        const startPos = editor.document.positionAt(startOffset);
                        const endPos = editor.document.positionAt(startOffset + edit.oldText.length);
                        editBuilder.replace(new vscode.Range(startPos, endPos), edit.newText);
                    }
                });
                outputChannel.appendLine(`[EDIT] ✅ Editor updated, success=${success}`);
            } catch (e) {
                outputChannel.appendLine(`[EDIT] Error applying edits: ${e.message}`);
                success = false;
            }

            // Write response immediately so MCP doesn't timeout
            const responseFilePath = requestFilePath.replace('edit-request.json', 'edit-response.json');
            isWritingToAmazonq = true;
            fs.writeFileSync(responseFilePath, JSON.stringify({ requestId, success }));
            setTimeout(() => { isWritingToAmazonq = false; }, 500);

            // Delete request file
            fs.unlinkSync(requestFilePath);
            outputChannel.appendLine(`[EDIT] Response written`);
        } catch (error) {
            outputChannel.appendLine(`[EDIT] Error: ${error.message}`);
        }
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
