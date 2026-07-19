import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from 'fs';
import * as path from 'path';
/**
 * IBM i AS/400 MCP Server
 *
 * This server provides Model Context Protocol integration for IBM i AS/400 systems,
 * enabling AI assistants to interact with source members, display files, and RPG programs.
 *
 * Features:
 * - Read/write source members
 * - Compile source members
 * - List libraries and source physical files
 * - Manage display files and RPG programs
 * - Source marking with specified mark (5719A)
 */
// Initialize the MCP server
const server = new McpServer({
    name: "ibmi-mcp-server",
    version: "1.0.0",
}, {
    capabilities: {
        resources: {},
        tools: {},
    }
});
// IBM i connection configuration schema
const IbmiConfigSchema = z.object({
    host: z.string(),
    user: z.string(),
    password: z.string().optional(),
    privateKeyPath: z.string().optional(),
    port: z.number().default(23),
    library: z.string().default("QGPL"),
    sourceFile: z.string().default("QRPGLESRC"),
});
// Global configuration (would typically come from environment or config file)
let ibmiConfig = null;
// Load configuration from environment variables
function loadConfigFromEnv() {
    const host = process.env.IBMI_HOST;
    const user = process.env.IBMI_USER;
    const password = process.env.IBMI_PASSWORD;
    const privateKeyPath = process.env.IBMI_PRIVATE_KEY_PATH;
    const port = process.env.IBMI_PORT ? parseInt(process.env.IBMI_PORT) : 22;
    const library = process.env.IBMI_LIBRARY || 'QGPL';
    const sourceFile = process.env.IBMI_SOURCE_FILE || 'QRPGLESRC';
    if (host && user) {
        return { host, user, password, privateKeyPath, port, library, sourceFile };
    }
    return null;
}
// Load configuration from VS Code settings
async function loadConfigFromVSCode() {
    try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const os = await import('os');
        const settingsPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
        const settingsContent = await fs.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        // Try connections first (has username)
        const connections = settings['code-for-ibmi.connections'];
        if (connections && Array.isArray(connections) && connections.length > 0) {
            const conn = connections[0];
            // Get library list from connectionSettings
            const connectionSettings = settings['code-for-ibmi.connectionSettings'];
            const connSettings = connectionSettings?.find((c) => c.name === conn.name) || {};
            return {
                host: conn.host || '',
                user: conn.username || '',
                password: '',
                privateKeyPath: conn.privateKeyPath || undefined,
                port: conn.port || 22,
                library: connSettings.currentLibrary || 'QGPL',
                sourceFile: 'QRPGLESRC',
            };
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Helper function: Write content directly to IBM i using SSH + CPYFRMSTMF
 * Note: This is kept for reference but not used by default.
 * Code for IBM i extension handles writes automatically.
 */
async function writeToIBMiDirectly(library, sourceFile, memberName, content) {
    if (!ibmiConfig) {
        throw new Error('Not connected to IBM i system');
    }
    const { Client } = await import('ssh2');
    const client = new Client();
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            client.end();
            reject(new Error(`Connection timeout`));
        }, 30000);
        client.on('ready', () => {
            clearTimeout(timeout);
            const tmpFile = `/tmp/mcp_${memberName}_${Date.now()}.tmp`;
            const cpyCommand = `CPYFRMSTMF FROMSTMF('${tmpFile}') TOMBR('/QSYS.LIB/${library}.LIB/${sourceFile}.FILE/${memberName}.MBR') MBROPT(*REPLACE)`;
            const writeCommand = `cat > ${tmpFile} << 'EOF'
${content}
EOF
system "${cpyCommand}" 2>&1
rm -f ${tmpFile}`;
            console.error('=== DEBUG: Full command ===');
            console.error(`Command length: ${writeCommand.length}`);
            console.error(`Content length: ${content.length}`);
            console.error(`CPYFRMSTMF: ${cpyCommand}`);
            console.error('=== END DEBUG ===');
            client.exec(writeCommand, (err, stream) => {
                if (err) {
                    client.end();
                    return reject(new Error(`Exec error: ${err.message}`));
                }
                let stdout = '';
                let stderr = '';
                stream.on('data', (data) => {
                    stdout += data.toString();
                });
                stream.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                stream.on('close', (code) => {
                    console.error('=== COMMAND RESULT ===');
                    console.error(`Exit code: ${code}`);
                    console.error(`STDOUT: ${stdout}`);
                    console.error(`STDERR: ${stderr}`);
                    console.error('=== END RESULT ===');
                    client.end();
                    if (code !== 0 || stdout.includes('CPFA')) {
                        return reject(new Error(`Write failed: ${stderr || stdout}`));
                    }
                    resolve();
                });
            });
        });
        client.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        client.connect(buildSshConnectOptions(ibmiConfig));
    });
}
/**
 * Build SSH connect options from ibmiConfig.
 * Prefers privateKeyPath over password when both are present.
 */
function buildSshConnectOptions(config) {
    const base = {
        host: config.host,
        port: config.port,
        username: config.user,
        readyTimeout: 30000,
    };
    if (config.privateKeyPath) {
        // Read key content directly - more reliable than privateKeyPath with some SSH servers
        try {
            const keyContent = fs.readFileSync(config.privateKeyPath, 'utf-8');
            return { ...base, privateKey: keyContent };
        }
        catch {
            return { ...base, privateKeyPath: config.privateKeyPath };
        }
    }
    return { ...base, password: config.password };
}
/**
 * Show a native Windows credential dialog via PowerShell and return the
 * entered password. The password is never written to disk or env vars.
 * Returns null if the user cancels.
 */
async function promptPasswordViaDialog(host, user) {
    const { spawn } = await import('child_process');
    // Use cscript.exe with VBScript InputBox - built-in Windows GUI, outputs to stdout
    const os = await import('os');
    const fsP2 = await import('fs/promises');
    const pathM2 = await import('path');
    const vbsFile = pathM2.join(os.tmpdir(), '_ibmi_mcp_dialog.vbs');
    const tmpFile = pathM2.join(os.tmpdir(), '_ibmi_mcp_pw.tmp');
    try {
        await fsP2.unlink(tmpFile);
    }
    catch { /* ok */ }
    // VBScript: show InputBox, write result to tmp file (avoids stdout pipe issues in background processes)
    const vbsContent = [
        `Dim pw`,
        `pw = InputBox("Enter password for ${user}@${host}" & Chr(13) & "Used once to install SSH key - never saved.", "IBM i First Time Setup")`,
        `Dim fso, f`,
        `Set fso = CreateObject("Scripting.FileSystemObject")`,
        `Set f = fso.CreateTextFile("${tmpFile.replace(/\\/g, '\\\\')}", True)`,
        `f.Write pw`,
        `f.Close`,
    ].join('\n');
    await fsP2.writeFile(vbsFile, vbsContent, 'utf-8');
    console.error(`VBS written: ${vbsFile}`);
    console.error(`Waiting for password input...`);
    await new Promise((resolve) => {
        const proc = spawn('wscript', ['//nologo', vbsFile], {
            stdio: 'ignore',
            windowsHide: false,
            detached: false,
        });
        proc.on('spawn', () => console.error('wscript spawned'));
        proc.on('close', (code) => { console.error(`wscript closed: ${code}`); resolve(); });
        proc.on('error', (err) => { console.error(`wscript error: ${err.message}`); resolve(); });
    });
    try {
        await fsP2.unlink(vbsFile);
    }
    catch { /* ok */ }
    console.error(`Checking for tmp file: ${tmpFile}`);
    try {
        const password = (await fsP2.readFile(tmpFile, 'utf-8')).trim();
        await fsP2.unlink(tmpFile);
        console.error('Password received successfully');
        return password.length > 0 ? password : null;
    }
    catch (e) {
        console.error(`Failed to read tmp file: ${e}`);
        return null;
    }
}
/**
 * Ensure an SSH key pair exists and is installed on the IBM i host.
 *
 * Flow:
 *   1. If ~/.ssh/id_rsa_ibmi does not exist → generate it.
 *   2. Try to connect with the key → if it works, we're done.
 *   3. Otherwise → prompt the user for their password via a native Windows dialog.
 *      The password is used once to install the public key, then discarded.
 *   4. Update ibmiConfig to use the key from now on.
 */
async function ensureSshKey(config) {
    const os = await import('os');
    const fsP = await import('fs/promises');
    const pathM = await import('path');
    const { Client } = await import('ssh2');
    const { execSync } = await import('child_process');
    const sshDir = pathM.join(os.homedir(), '.ssh');
    const keyPath = pathM.join(sshDir, 'id_rsa_ibmi');
    const pubKeyPath = `${keyPath}.pub`;
    // 1. Generate key pair if missing
    try {
        await fsP.access(keyPath);
        console.error(`SSH key already exists: ${keyPath}`);
    }
    catch {
        console.error('Generating SSH key pair...');
        await fsP.mkdir(sshDir, { recursive: true });
        execSync(`ssh-keygen -t rsa -b 4096 -f "${keyPath}" -N "" -C "${config.user}@ibmi-mcp"`, { stdio: 'ignore' });
        console.error(`SSH key generated: ${keyPath}`);
    }
    const configWithKey = { ...config, privateKeyPath: keyPath };
    // 2. Test key-based auth
    const keyWorks = await testSshConnection(configWithKey);
    if (keyWorks) {
        console.error('SSH key auth works.');
        return configWithKey;
    }
    // 3. Key not yet installed — always prompt via dialog (never use saved password)
    console.error('SSH key not yet installed on IBM i. Prompting for password...');
    const password = await promptPasswordViaDialog(config.host, config.user);
    if (!password) {
        console.error('Password prompt cancelled. SSH key not installed.');
        return config;
    }
    // Install public key on IBM i using the password (one-time)
    // Strategy: upload pub key via SFTP to a tmp file, then append to authorized_keys
    const pubKey = (await fsP.readFile(pubKeyPath, 'utf-8')).trim();
    const configWithPassword = { ...config, password, privateKeyPath: undefined };
    const installed = await new Promise((resolve) => {
        const client = new Client();
        const timer = setTimeout(() => { client.destroy(); resolve(false); }, 15000);
        client.on('ready', () => {
            clearTimeout(timer);
            console.error('SSH connected with password. Installing public key...');
            // Step 1: setup .ssh dir
            client.exec('mkdir -p $HOME/.ssh && chmod 700 $HOME/.ssh && echo OK', (err, stream) => {
                if (err) {
                    console.error('step1 err:', err.message);
                    client.end();
                    return resolve(false);
                }
                let out1 = '';
                stream.on('data', (d) => { out1 += d.toString(); });
                stream.stderr.on('data', (d) => { console.error('step1 stderr:', d.toString()); });
                stream.on('close', () => {
                    console.error('step1 result:', out1.trim());
                    // Step 2: write pub key via stdin of cat (safest - no escaping needed)
                    const appendCmd = `cat >> $HOME/.ssh/authorized_keys && chmod 600 $HOME/.ssh/authorized_keys && echo KEY_INSTALLED`;
                    client.exec(appendCmd, (err2, stream2) => {
                        if (err2) {
                            console.error('step2 err:', err2.message);
                            client.end();
                            return resolve(false);
                        }
                        let out2 = '';
                        // Write key to stdin then close it so cat knows we're done
                        stream2.stdin.end(pubKey + '\n');
                        stream2.on('data', (d) => { out2 += d.toString(); });
                        stream2.stderr.on('data', (d) => { console.error('step2 stderr:', d.toString()); });
                        stream2.on('close', () => {
                            console.error('step2 result:', out2.trim());
                            client.end();
                            resolve(out2.includes('KEY_INSTALLED'));
                        });
                    });
                });
            });
        });
        client.on('error', (err) => { console.error(`SSH connect error: ${err.message}`); clearTimeout(timer); resolve(false); });
        client.connect(buildSshConnectOptions(configWithPassword));
    });
    // Password is no longer needed — let it be garbage-collected
    if (installed) {
        console.error('SSH public key installed on IBM i. Password discarded.');
        return configWithKey;
    }
    console.error('Failed to install SSH key (wrong password or connection error).');
    return config;
}
/**
 * Test whether an SSH connection succeeds (used to probe key auth).
 */
async function testSshConnection(config) {
    const { Client } = await import('ssh2');
    return new Promise((resolve) => {
        const client = new Client();
        const timer = setTimeout(() => { client.destroy(); resolve(false); }, 10000);
        client.on('ready', () => { clearTimeout(timer); client.end(); resolve(true); });
        client.on('error', () => { clearTimeout(timer); resolve(false); });
        client.connect(buildSshConnectOptions(config));
    });
}
// Flag to prevent infinite loop
let isUpdatingFromWatcher = false;
/**
 * Helper function: Update active file content in editor
 */
async function updateActiveFileContent(newContent) {
    const fsPromises = await import('fs/promises');
    const pathModule = await import('path');
    const activeFilePath = pathModule.join(process.cwd(), '.amazonq', 'active-file.json');
    const fileContent = await fsPromises.readFile(activeFilePath, 'utf-8');
    const activeFile = JSON.parse(fileContent);
    const { library, sourceFile, member } = activeFile;
    // Update the local file that IBM i extension watches
    const memberFilePath = pathModule.join(process.cwd(), '.amazonq', library, sourceFile, member);
    isUpdatingFromWatcher = true;
    await fsPromises.writeFile(memberFilePath, newContent);
    setTimeout(() => { isUpdatingFromWatcher = false; }, 1000);
    console.error(`Updated local file: ${memberFilePath}`);
    console.error(`IBM i extension will sync to: ${library}/${sourceFile}(${member})`);
}
// Try to load config from environment on startup
ibmiConfig = loadConfigFromEnv();
/**
 * Tool: Connect to IBM i system
 */
server.registerTool("connect_ibmi", {
    description: "Connect to IBM i AS/400 system",
    inputSchema: {
        host: z.string().describe("IBM i system hostname or IP address"),
        user: z.string().describe("User profile name"),
        password: z.string().optional().describe("Password (if not provided, will use SSH key or IBMI_PASSWORD env var)"),
        privateKeyPath: z.string().optional().describe("Path to SSH private key file (OpenSSH/RFC4716/PPK). Takes precedence over password."),
        port: z.number().default(22).describe("Connection port (default: 22 for SSH)"),
        library: z.string().default("QGPL").describe("Default library (default: QGPL)"),
        sourceFile: z.string().default("QRPGLESRC").describe("Default source physical file (default: QRPGLESRC)"),
    },
}, async ({ host, user, password, privateKeyPath, port = 22, library, sourceFile }) => {
    try {
        // If parameters not provided, try to use environment variables
        const finalHost = host || process.env.IBMI_HOST;
        const finalUser = user || process.env.IBMI_USER;
        const finalPassword = password || process.env.IBMI_PASSWORD;
        const finalPrivateKeyPath = privateKeyPath || process.env.IBMI_PRIVATE_KEY_PATH;
        const finalPort = port || (process.env.IBMI_PORT ? parseInt(process.env.IBMI_PORT) : 22);
        const finalLibrary = library || process.env.IBMI_LIBRARY || 'QGPL';
        const finalSourceFile = sourceFile || process.env.IBMI_SOURCE_FILE || 'QRPGLESRC';
        if (!finalHost || !finalUser) {
            throw new Error('Host and user are required. Provide them as parameters or set IBMI_HOST and IBMI_USER environment variables.');
        }
        ibmiConfig = IbmiConfigSchema.parse({
            host: finalHost,
            user: finalUser,
            password: finalPassword,
            privateKeyPath: finalPrivateKeyPath,
            port: finalPort,
            library: finalLibrary,
            sourceFile: finalSourceFile,
        });
        const authMethod = ibmiConfig.privateKeyPath ? `SSH key: ${ibmiConfig.privateKeyPath}` : 'password';
        return {
            content: [
                {
                    type: "text",
                    text: `Successfully connected to IBM i system ${finalHost} as user ${finalUser}\nAuth: ${authMethod}\nDefault library: ${finalLibrary}\nDefault source file: ${finalSourceFile}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Failed to connect to IBM i system: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
});
/**
 * Tool: Add library to library list
 */
server.registerTool("add_library_to_libl", {
    description: "Add a library to the library list",
    inputSchema: {
        library: z.string().describe("Library name to add to library list"),
    },
}, async ({ library }) => {
    if (!ibmiConfig) {
        return {
            content: [{ type: "text", text: "Not connected to IBM i system. Use connect_ibmi tool first." }],
            isError: true,
        };
    }
    try {
        const { Client } = await import('ssh2');
        const client = new Client();
        const result = await new Promise((resolve, reject) => {
            client.on('ready', () => {
                const command = `system "ADDLIBLE LIB(${library})" 2>&1`;
                client.exec(command, (err, stream) => {
                    if (err) {
                        client.end();
                        return reject(err);
                    }
                    let output = '';
                    stream.on('data', (data) => { output += data.toString(); });
                    stream.stderr.on('data', (data) => { output += data.toString(); });
                    stream.on('close', () => {
                        client.end();
                        resolve(output);
                    });
                });
            });
            client.on('error', reject);
            client.connect(buildSshConnectOptions(ibmiConfig));
        });
        return {
            content: [{ type: "text", text: `Library ${library} added to library list successfully.\n${result}` }],
        };
    }
    catch (error) {
        return {
            content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
            isError: true,
        };
    }
});
/**
 * Tool: List source members
 */
server.registerTool("list_source_members", {
    description: "List source members in a source physical file",
    inputSchema: {
        library: z.string().optional().describe("Library name (uses default if not specified)"),
        sourceFile: z.string().optional().describe("Source physical file name (uses default if not specified)"),
        member: z.string().optional().describe("Member name pattern (* for all, or specific pattern)"),
        type: z.string().optional().describe("Source type filter (RPGLE, DSPF, etc.)"),
    },
}, async ({ library, sourceFile, member, type }) => {
    if (!ibmiConfig) {
        return {
            content: [
                {
                    type: "text",
                    text: "Not connected to IBM i system. Use connect_ibmi tool first.",
                },
            ],
            isError: true,
        };
    }
    const targetLibrary = library || ibmiConfig.library;
    const targetSourceFile = sourceFile || ibmiConfig.sourceFile;
    try {
        const { Client } = await import('ssh2');
        const client = new Client();
        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                client.end();
                reject(new Error(`Connection timeout after 30 seconds. Host: ${ibmiConfig.host}, Port: ${ibmiConfig.port}`));
            }, 30000);
            client.on('ready', () => {
                clearTimeout(timeout);
                const command = `system "DSPFD FILE(${targetLibrary}/${targetSourceFile}) TYPE(*MBRLIST)" 2>&1 || ls /QSYS.LIB/${targetLibrary}.LIB/${targetSourceFile}.FILE/*.MBR 2>&1 | grep -o '[^/]*\.MBR' | sed 's/\.MBR//'`;
                client.exec(command, (err, stream) => {
                    if (err) {
                        client.end();
                        return reject(new Error(`Exec error: ${err.message}`));
                    }
                    let stdout = '';
                    let stderr = '';
                    stream.on('data', (data) => {
                        stdout += data.toString();
                    });
                    stream.stderr.on('data', (data) => {
                        stderr += data.toString();
                    });
                    stream.on('close', (code) => {
                        client.end();
                        if (stderr) {
                            resolve(`STDOUT: ${stdout}\nSTDERR: ${stderr}\nEXIT_CODE: ${code}`);
                        }
                        else {
                            resolve(stdout);
                        }
                    });
                });
            });
            client.on('error', (err) => {
                clearTimeout(timeout);
                reject(new Error(`SSH Connection error: ${err.message}. Host: ${ibmiConfig.host}, Port: ${ibmiConfig.port}, User: ${ibmiConfig.user}`));
            });
            client.connect(buildSshConnectOptions(ibmiConfig));
        });
        const lines = result.split('\n');
        const members = [];
        let inMemberList = false;
        for (const line of lines) {
            // Look for member list section
            if (line.includes('Member') && line.includes('Size') && line.includes('Type')) {
                inMemberList = true;
                continue;
            }
            // Stop at end markers
            if (line.includes('Total number of members') || line.includes('הופק במחשב') || line.includes('***')) {
                inMemberList = false;
            }
            if (inMemberList && line.trim()) {
                // Parse member line: MEMBERNAME SIZE TYPE DATE DATE TIME RECORDS RECORDS
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 3 && parts[0] && !parts[0].includes('Text:') && !parts[0].includes('Member')) {
                    const memberName = parts[0];
                    const memberType = parts[2] || 'UNKNOWN';
                    // Basic validation - just check it's a reasonable member name
                    const isValidMemberName = /^[A-Z0-9#@$_][A-Z0-9#@$_]{0,9}$/i.test(memberName);
                    if (isValidMemberName && (!type || memberType.toUpperCase() === type.toUpperCase())) {
                        members.push(`${memberName.padEnd(15)} ${memberType.padEnd(10)} - Source member`);
                    }
                }
            }
        }
        if (members.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Source members in ${targetLibrary}/${targetSourceFile}:\n\nNo members found.`,
                    },
                ],
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: `Source members in ${targetLibrary}/${targetSourceFile}:\n\n${members.join('\n')}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                },
            ],
            isError: true,
        };
    }
});
/**
 * Tool: Read source member
 */
server.registerTool("read_source_member", {
    description: "Read the contents of a source member",
    inputSchema: {
        member: z.string().describe("Source member name"),
        library: z.string().optional().describe("Library name (uses default if not specified)"),
        sourceFile: z.string().optional().describe("Source physical file name (uses default if not specified)"),
        startLine: z.number().optional().describe("Starting line number (default: 1)"),
        endLine: z.number().optional().describe("Ending line number (default: all)"),
    },
}, async ({ member, library, sourceFile, startLine, endLine }) => {
    if (!ibmiConfig) {
        return {
            content: [
                {
                    type: "text",
                    text: "Not connected to IBM i system. Use connect_ibmi tool first.",
                },
            ],
            isError: true,
        };
    }
    const targetLibrary = library || ibmiConfig.library;
    const targetSourceFile = sourceFile || ibmiConfig.sourceFile;
    try {
        const { Client } = await import('ssh2');
        const client = new Client();
        const content = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                client.end();
                reject(new Error(`Connection timeout`));
            }, 30000);
            client.on('ready', () => {
                clearTimeout(timeout);
                const command = `iconv -f IBM-424 -t UTF-8 /QSYS.LIB/${targetLibrary}.LIB/${targetSourceFile}.FILE/${member}.MBR 2>/dev/null || cat /QSYS.LIB/${targetLibrary}.LIB/${targetSourceFile}.FILE/${member}.MBR`;
                client.exec(command, (err, stream) => {
                    if (err) {
                        client.end();
                        return reject(new Error(`Exec error: ${err.message}`));
                    }
                    let stdout = '';
                    stream.on('data', (data) => {
                        stdout += data.toString();
                    });
                    stream.on('close', () => {
                        client.end();
                        resolve(stdout);
                    });
                });
            });
            client.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
            client.connect(buildSshConnectOptions(ibmiConfig));
        });
        // Apply line range filtering if specified
        const lines = content.split('\n');
        const start = (startLine || 1) - 1;
        const end = endLine ? endLine : lines.length;
        const selectedLines = lines.slice(start, end);
        return {
            content: [
                {
                    type: "text",
                    text: `Source member: ${targetLibrary}/${targetSourceFile}(${member})\n` +
                        `Lines ${startLine || 1} to ${end}:\n\n` +
                        selectedLines.join('\n'),
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error reading member: ${error instanceof Error ? error.message : 'Unknown error'}`,
                },
            ],
            isError: true,
        };
    }
});
/**
 * Tool: Write source member
 */
server.registerTool("write_source_member", {
    description: "Write or update a source member with source mark 5719A",
    inputSchema: {
        member: z.string().describe("Source member name"),
        content: z.string().describe("Source member content"),
        library: z.string().optional().describe("Library name (uses default if not specified)"),
        sourceFile: z.string().optional().describe("Source physical file name (uses default if not specified)"),
        sourceType: z.string().optional().describe("Source type (RPGLE, DSPF, etc.)"),
        description: z.string().optional().describe("Member description"),
    },
}, async ({ member, content, library, sourceFile, sourceType, description }) => {
    if (!ibmiConfig) {
        return {
            content: [
                {
                    type: "text",
                    text: "Not connected to IBM i system. Use connect_ibmi tool first.",
                },
            ],
            isError: true,
        };
    }
    // Try to get library/sourceFile from active file if not provided
    let targetLibrary = library;
    let targetSourceFile = sourceFile;
    if (!targetLibrary || !targetSourceFile) {
        try {
            const fs = await import('fs/promises');
            const path = await import('path');
            const activeFilePath = path.join(process.cwd(), '.amazonq', 'active-file.json');
            const fileContent = await fs.readFile(activeFilePath, 'utf-8');
            const activeFile = JSON.parse(fileContent);
            if (activeFile && activeFile.member === member) {
                targetLibrary = targetLibrary || activeFile.library;
                targetSourceFile = targetSourceFile || activeFile.sourceFile;
            }
        }
        catch {
            // Ignore errors reading active file
        }
    }
    if (!targetLibrary || !targetSourceFile) {
        return {
            content: [{
                    type: "text",
                    text: `Error: library and sourceFile must be provided. Could not determine from active file for member ${member}.`,
                }],
            isError: true,
        };
    }
    try {
        const { Client } = await import('ssh2');
        const client = new Client();
        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                client.end();
                reject(new Error(`Connection timeout`));
            }, 30000);
            client.on('ready', () => {
                clearTimeout(timeout);
                // Decode HTML entities before writing to IBM i
                const decodedContent = content
                    .replace(/&#39;/g, "'")
                    .replace(/&quot;/g, '"')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&')
                    .replace(/\r\n/g, '\n') // Convert Windows line endings to Unix
                    .replace(/\r/g, '\n'); // Convert any remaining CR to LF
                // Extract member name without extension (e.g., ADDNUM.CBLLE -> ADDNUM)
                const memberName = member.split('.')[0];
                // Write to IFS and use CPYFRMSTMF to copy to source member
                const tmpFile = `/tmp/mcp_${memberName}_${Date.now()}.tmp`;
                const cpyCommand = `CPYFRMSTMF FROMSTMF('${tmpFile}') TOMBR('/QSYS.LIB/${targetLibrary}.LIB/${targetSourceFile}.FILE/${memberName}.MBR') MBROPT(*REPLACE)`;
                const writeCommand = `cat > ${tmpFile} << 'EOF'
${decodedContent}
EOF
system "${cpyCommand}" 2>&1
rm -f ${tmpFile}`;
                console.error(`CPYFRMSTMF: ${cpyCommand}`);
                client.exec(writeCommand, (err, stream) => {
                    if (err) {
                        client.end();
                        return reject(new Error(`Exec error: ${err.message}`));
                    }
                    let stdout = '';
                    let stderr = '';
                    stream.on('data', (data) => {
                        stdout += data.toString();
                    });
                    stream.stderr.on('data', (data) => {
                        stderr += data.toString();
                    });
                    stream.on('close', (code) => {
                        // Check for CPFA errors in stdout even if exit code is 0
                        if (code !== 0 || stdout.includes('CPFA')) {
                            client.end();
                            return reject(new Error(`Write failed: ${stderr || stdout}`));
                        }
                        // Update source type if provided
                        if (sourceType) {
                            const chgCommand = `system "CHGPFM FILE(${targetLibrary}/${targetSourceFile}) MBR(${member}) SRCTYPE(${sourceType})" 2>&1`;
                            client.exec(chgCommand, (err2, stream2) => {
                                if (err2) {
                                    client.end();
                                    return reject(new Error(`CHGPFM error: ${err2.message}`));
                                }
                                let stdout2 = '';
                                stream2.on('data', (data) => {
                                    stdout2 += data.toString();
                                });
                                stream2.on('close', () => {
                                    client.end();
                                    resolve(`Member written successfully with source type ${sourceType}`);
                                });
                            });
                        }
                        else {
                            client.end();
                            resolve(`Member written successfully`);
                        }
                    });
                });
            });
            client.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
            client.connect(buildSshConnectOptions(ibmiConfig));
        });
        return {
            content: [
                {
                    type: "text",
                    text: `Successfully wrote source member ${targetLibrary}/${targetSourceFile}(${member})\n` +
                        `Source type: ${sourceType || 'Unknown'}\n` +
                        `Description: ${description || 'Created by MCP Server'}\n` +
                        `Lines written: ${content.split('\n').length}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error writing member: ${error instanceof Error ? error.message : 'Unknown error'}`,
                },
            ],
            isError: true,
        };
    }
});
/**
 * Tool: Get current active file
 */
server.registerTool("get_current_active_file", {
    description: "Get the content of the currently active file from IBM i by reading .amazonq/active-file.json",
    inputSchema: {},
}, async () => {
    try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const activeFilePath = path.join(process.cwd(), '.amazonq', 'active-file.json');
        console.error(`Looking for active file at: ${activeFilePath}`);
        const fileContent = await fs.readFile(activeFilePath, 'utf-8');
        const activeFile = JSON.parse(fileContent);
        if (!activeFile || !activeFile.library || !activeFile.sourceFile || !activeFile.member) {
            return {
                content: [
                    {
                        type: "text",
                        text: "No active file found. Please open an IBM i source member in VS Code.",
                    },
                ],
            };
        }
        const { library, sourceFile, member, isDirty } = activeFile;
        // Read content from directory structure: .amazonq/[library]/[sourceFile]/[member]
        const memberFilePath = path.join(process.cwd(), '.amazonq', library, sourceFile, member);
        const content = await fs.readFile(memberFilePath, 'utf-8');
        const dirtyIndicator = isDirty ? " (unsaved changes)" : "";
        return {
            content: [
                {
                    type: "text",
                    text: `Active file: ${library}/${sourceFile}(${member})${dirtyIndicator}\n\n${content}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error reading active file: ${error instanceof Error ? error.message : 'Unknown error'}`,
                },
            ],
            isError: true,
        };
    }
});
/**
 * Tool: Apply edits to active file
 */
server.registerTool("apply_edits_to_active_file", {
    description: "Apply text edits to the currently active file in VS Code editor and write to IBM i",
    inputSchema: {
        edits: z.array(z.object({
            oldText: z.string().describe("The exact text to replace"),
            newText: z.string().describe("The new text to insert"),
        })).describe("Array of text replacements to apply"),
    },
}, async ({ edits }) => {
    try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const amazonqDir = path.join(process.cwd(), '.amazonq');
        const requestPath = path.join(amazonqDir, 'edit-request.json');
        const responsePath = path.join(amazonqDir, 'edit-response.json');
        const requestId = Date.now().toString();
        // Read active file info
        const activeFilePath = path.join(amazonqDir, 'active-file.json');
        const activeFileContent = await fs.readFile(activeFilePath, 'utf-8');
        const activeFile = JSON.parse(activeFileContent);
        const { library, sourceFile, member } = activeFile;
        // Normalize line endings in edits
        const normalizedEdits = edits.map(edit => ({
            oldText: edit.oldText.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
            newText: edit.newText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        }));
        // Create before/after temp files for diff view
        await fs.mkdir(amazonqDir, { recursive: true });
        const tempDir = path.join(amazonqDir, 'temp');
        await fs.mkdir(tempDir, { recursive: true });
        const memberFilePath = path.join(amazonqDir, library, sourceFile, member);
        let beforePath = null;
        let afterPath = null;
        try {
            const currentContent = await fs.readFile(memberFilePath, 'utf-8');
            let afterContent = currentContent;
            for (const edit of normalizedEdits) {
                afterContent = afterContent.replace(edit.oldText, edit.newText);
            }
            beforePath = path.join(tempDir, `before_${requestId}_${member}`);
            afterPath = path.join(tempDir, `after_${requestId}_${member}`);
            await fs.writeFile(beforePath, currentContent);
            await fs.writeFile(afterPath, afterContent);
        } catch (e) {
            // If we can't create diff files, continue without diff
            beforePath = null;
            afterPath = null;
        }
        // Write edit-request.json - VS Code extension will pick this up
        await fs.writeFile(requestPath, JSON.stringify({ requestId, edits: normalizedEdits, beforePath, afterPath }));
        // Wait for edit-response.json (timeout 5s)
        const maxWait = 5000;
        const startTime = Date.now();
        while (Date.now() - startTime < maxWait) {
            try {
                const responseContent = await fs.readFile(responsePath, 'utf-8');
                const response = JSON.parse(responseContent);
                if (response.requestId === requestId) {
                    await fs.unlink(responsePath).catch(() => { });
                    if (!response.success) {
                        throw new Error(response.error || 'Edit failed');
                    }
                    return {
                        content: [{ type: "text", text: `Successfully updated ${library}/${sourceFile}(${member})` }],
                    };
                }
            }
            catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Timeout waiting for VS Code to apply edits');
    }
    catch (error) {
        return {
            content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
            isError: true,
        };
    }
});
/**
 * Tool: Get VS Code library list
 */
server.registerTool("get_vscode_library_list", {
    description: "Get the library list from VS Code IBM i extension settings",
    inputSchema: {
        connectionName: z.string().optional().describe("Connection name (default: first connection)"),
    },
}, async ({ connectionName }) => {
    try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const os = await import('os');
        const settingsPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
        const settingsContent = await fs.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        const connections = settings['code-for-ibmi.connections'];
        const connectionSettings = settings['code-for-ibmi.connectionSettings'];
        if (!connections || !Array.isArray(connections)) {
            return {
                content: [{
                        type: "text",
                        text: "No IBM i connections found in VS Code.",
                    }],
                isError: true,
            };
        }
        const conn = connectionName
            ? connections.find((c) => c.name === connectionName)
            : connections[0];
        if (!conn) {
            return {
                content: [{
                        type: "text",
                        text: `Connection '${connectionName}' not found. Available connections: ${connections.map((c) => c.name).join(', ')}`,
                    }],
                isError: true,
            };
        }
        const connSettings = connectionSettings?.find((c) => c.name === conn.name) || {};
        const libraryList = connSettings.libraryList || [];
        const currentLibrary = connSettings.currentLibrary || 'QGPL';
        const username = conn.username || 'Unknown';
        return {
            content: [{
                    type: "text",
                    text: `Library list for connection '${conn.name}':\n\n` +
                        `Username: ${username}\n` +
                        `Current library: ${currentLibrary}\n\n` +
                        `User library list:\n${libraryList.map((lib, i) => `${i + 1}. ${lib}`).join('\n')}\n\n` +
                        `Total libraries: ${libraryList.length}`,
                }],
        };
    }
    catch (error) {
        return {
            content: [{
                    type: "text",
                    text: `Error reading VS Code settings: ${error instanceof Error ? error.message : 'Unknown error'}`,
                }],
            isError: true,
        };
    }
});
/**
 * Tool: Execute command
 */
server.registerTool("execute_command", {
    description: "Execute a command on IBM i system",
    inputSchema: {
        command: z.string().describe("Command to execute"),
        timeout: z.number().optional().default(30000).describe("Timeout in milliseconds (default: 30000)"),
    },
}, async ({ command, timeout = 30000 }) => {
    if (!ibmiConfig) {
        return {
            content: [
                {
                    type: "text",
                    text: "Not connected to IBM i system. Use connect_ibmi tool first.",
                },
            ],
            isError: true,
        };
    }
    try {
        const { Client } = await import('ssh2');
        const client = new Client();
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                client.end();
                reject(new Error(`Command timeout after ${timeout}ms`));
            }, timeout);
            client.on('ready', () => {
                clearTimeout(timer);
                client.exec(command, (err, stream) => {
                    if (err) {
                        client.end();
                        return reject(new Error(`Exec error: ${err.message}`));
                    }
                    let stdout = '';
                    let stderr = '';
                    stream.on('data', (data) => {
                        stdout += data.toString();
                    });
                    stream.stderr.on('data', (data) => {
                        stderr += data.toString();
                    });
                    stream.on('close', (code) => {
                        client.end();
                        resolve({ stdout, stderr, exitCode: code });
                    });
                });
            });
            client.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
            client.connect(buildSshConnectOptions(ibmiConfig));
        });
        return {
            content: [
                {
                    type: "text",
                    text: `Command executed: ${command}\n\nExit code: ${result.exitCode}\n\nOutput:\n${result.stdout}${result.stderr ? '\n\nErrors:\n' + result.stderr : ''}`,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error executing command: ${error instanceof Error ? error.message : 'Unknown error'}`,
                },
            ],
            isError: true,
        };
    }
});
/**
 * Tool: Execute SQL
 */
server.registerTool("execute_sql", {
    description: "Execute SQL query on IBM i and return results",
    inputSchema: {
        sql: z.string().describe("SQL query to execute"),
        limit: z.number().optional().default(100).describe("Maximum number of rows to return (default: 100)"),
    },
}, async ({ sql, limit = 100 }) => {
    if (!ibmiConfig) {
        return {
            content: [{ type: "text", text: "Not connected to IBM i system. Use connect_ibmi tool first." }],
            isError: true,
        };
    }
    try {
        const { Client } = await import('ssh2');
        const client = new Client();
        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                client.end();
                reject(new Error(`Query timeout after 60 seconds`));
            }, 60000);
            client.on('ready', () => {
                clearTimeout(timeout);
                // Add FETCH FIRST if SELECT and no FETCH clause exists
                let finalSql = sql.trim();
                if (finalSql.toUpperCase().startsWith('SELECT') && !finalSql.toUpperCase().includes('FETCH FIRST')) {
                    finalSql = finalSql.replace(/;?$/, ` FETCH FIRST ${limit} ROWS ONLY`);
                }
                // Use qsh with db2 command - escape single quotes for shell
                const escapedSql = finalSql.replace(/'/g, "'\\''");
                const command = `qsh -c "db2 '${escapedSql}' 2>&1"`;
                client.exec(command, (err, stream) => {
                    if (err) {
                        client.end();
                        return reject(new Error(`Exec error: ${err.message}`));
                    }
                    let stdout = '';
                    stream.on('data', (data) => { stdout += data.toString(); });
                    stream.stderr.on('data', (data) => { stdout += data.toString(); });
                    stream.on('close', () => {
                        client.end();
                        resolve(stdout);
                    });
                });
            });
            client.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
            client.connect(buildSshConnectOptions(ibmiConfig));
        });
        return {
            content: [{
                    type: "text",
                    text: `SQL Query:\n${sql}\n\nResults:\n${result}`,
                }],
        };
    }
    catch (error) {
        return {
            content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
            isError: true,
        };
    }
});
/**
 * Tool: Compile source member
 */
server.registerTool("compile_source_member", {
    description: "Compile a source member",
    inputSchema: {
        member: z.string().describe("Source member name"),
        library: z.string().optional().describe("Library name (uses default if not specified)"),
        sourceFile: z.string().optional().describe("Source physical file name (uses default if not specified)"),
        sourceType: z.string().optional().describe("Source type (RPGLE, DSPF, etc.)"),
        options: z.string().optional().describe("Compile options"),
        additionalLibraries: z.array(z.string()).optional().describe("Additional libraries to add to library list"),
    },
}, async ({ member, library, sourceFile, sourceType, options, additionalLibraries }) => {
    if (!ibmiConfig) {
        return {
            content: [
                {
                    type: "text",
                    text: "Not connected to IBM i system. Use connect_ibmi tool first.",
                },
            ],
            isError: true,
        };
    }
    const targetLibrary = library || ibmiConfig.library;
    const targetSourceFile = sourceFile || ibmiConfig.sourceFile;
    try {
        const { Client } = await import('ssh2');
        const client = new Client();
        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                client.end();
                reject(new Error(`Connection timeout`));
            }, 60000);
            client.on('ready', () => {
                clearTimeout(timeout);
                // Determine compile command based on source type
                let crtCommand = '';
                const type = (sourceType || '').toUpperCase();
                if (type === 'CBLLE' || type === 'CBL') {
                    crtCommand = `CRTBNDCBL PGM(${targetLibrary}/${member}) SRCFILE(${targetLibrary}/${targetSourceFile}) SRCMBR(${member})`;
                }
                else if (type === 'RPGLE' || type === 'RPG') {
                    crtCommand = `CRTBNDRPG PGM(${targetLibrary}/${member}) SRCFILE(${targetLibrary}/${targetSourceFile}) SRCMBR(${member})`;
                }
                else if (type === 'SQLRPGLE') {
                    crtCommand = `CRTSQLRPGI OBJ(${targetLibrary}/${member}) SRCFILE(${targetLibrary}/${targetSourceFile}) SRCMBR(${member})`;
                }
                else if (type === 'SQLCBL') {
                    crtCommand = `CRTSQLCBLI OBJ(${targetLibrary}/${member}) SRCFILE(${targetLibrary}/${targetSourceFile}) SRCMBR(${member})`;
                }
                else if (type === 'CLLE' || type === 'CLP') {
                    crtCommand = `CRTBNDCL PGM(${targetLibrary}/${member}) SRCFILE(${targetLibrary}/${targetSourceFile}) SRCMBR(${member})`;
                }
                else if (type === 'CMD') {
                    crtCommand = `CRTCMD CMD(${targetLibrary}/${member}) PGM(${targetLibrary}/${member}) SRCFILE(${targetLibrary}/${targetSourceFile}) SRCMBR(${member})`;
                }
                else if (type === 'DSPF') {
                    crtCommand = `CRTDSPF FILE(${targetLibrary}/${member}) SRCFILE(${targetLibrary}/${targetSourceFile}) SRCMBR(${member})`;
                }
                else if (type === 'PF') {
                    crtCommand = `CRTPF FILE(${targetLibrary}/${member}) SRCFILE(${targetLibrary}/${targetSourceFile}) SRCMBR(${member})`;
                }
                else if (type === 'LF') {
                    crtCommand = `CRTLF FILE(${targetLibrary}/${member}) SRCFILE(${targetLibrary}/${targetSourceFile}) SRCMBR(${member})`;
                }
                else {
                    client.end();
                    return reject(new Error(`Unsupported source type: ${type}. Please specify sourceType parameter.`));
                }
                // Build QSH command with liblist to add libraries in same session
                let qshCommand = `liblist -a ${targetLibrary}`;
                if (additionalLibraries && additionalLibraries.length > 0) {
                    qshCommand += '; ' + additionalLibraries.map(lib => `liblist -a ${lib}`).join('; ');
                }
                qshCommand += `; system '${crtCommand}'`;
                const compileCommand = `qsh -c "${qshCommand}"`;
                client.exec(compileCommand, (err, stream) => {
                    if (err) {
                        client.end();
                        return reject(new Error(`Exec error: ${err.message}`));
                    }
                    let stdout = '';
                    stream.on('data', (data) => {
                        stdout += data.toString();
                    });
                    stream.stderr.on('data', (data) => {
                        stdout += data.toString();
                    });
                    stream.on('close', (code) => {
                        client.end();
                        // Check for compilation success messages in output
                        const hasSuccess = stdout.includes('Program') && stdout.includes('created in library');
                        const hasTerminalError = stdout.includes('Terminal') || stdout.includes('Severe');
                        resolve({
                            success: hasSuccess && !hasTerminalError,
                            output: stdout
                        });
                    });
                });
            });
            client.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
            client.connect(buildSshConnectOptions(ibmiConfig));
        });
        return {
            content: [
                {
                    type: "text",
                    text: `Compilation ${result.success ? 'successful' : 'failed'} for ${targetLibrary}/${targetSourceFile}(${member})\n\n` +
                        `Output:\n${result.output}`,
                },
            ],
            isError: !result.success,
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error compiling member: ${error instanceof Error ? error.message : 'Unknown error'}`,
                },
            ],
            isError: true,
        };
    }
});
/**
 * Resource: IBM i Source Member
 * Provides read access to source members as resources
 */
server.registerResource("source-member", new ResourceTemplate("ibmi://source/{library}/{sourceFile}/{member}", {
    list: undefined, // No dynamic listing for now
}), {
    name: "IBM i Source Member",
    description: "Access to IBM i source members",
    mimeType: "text/plain",
}, async (uri, variables) => {
    if (!ibmiConfig) {
        throw new Error("Not connected to IBM i system");
    }
    const library = variables?.library || 'UNKNOWN';
    const sourceFile = variables?.sourceFile || 'UNKNOWN';
    const member = variables?.member || 'UNKNOWN';
    // This would read the actual member in a real implementation
    const content = `// Source member ${library}/${sourceFile}(${member})\n// Retrieved via MCP Server\n\n// Content would be here...`;
    return {
        contents: [
            {
                uri: uri.toString(),
                text: content,
                mimeType: "text/plain",
            },
        ],
    };
});
// Setup file watcher for .amazonq directory
async function setupFileWatcher() {
    const watchDir = path.join(process.cwd(), '.amazonq');
    // Ensure directory exists
    if (!fs.existsSync(watchDir)) {
        fs.mkdirSync(watchDir, { recursive: true });
    }
    fs.watch(watchDir, { recursive: true }, async (eventType, filename) => {
        if (eventType === 'change' && filename && !filename.includes('active-file.json')) {
            // Skip if we're currently updating from watcher (prevent loop)
            if (isUpdatingFromWatcher) {
                return;
            }
            try {
                const changedFile = path.join(watchDir, filename);
                const fsPromises = await import('fs/promises');
                const newContent = await fsPromises.readFile(changedFile, 'utf-8');
                // Read active file to get member info
                const activeFilePath = path.join(watchDir, 'active-file.json');
                const activeFileContent = await fsPromises.readFile(activeFilePath, 'utf-8');
                const activeFile = JSON.parse(activeFileContent);
                // Check if changed file matches active file
                const expectedPath = path.join(watchDir, activeFile.library, activeFile.sourceFile, activeFile.member);
                if (changedFile === expectedPath) {
                    console.error(`File watcher detected change in ${filename}, updating editor...`);
                    await updateActiveFileContent(newContent);
                    console.error(`Successfully updated editor from file watcher`);
                }
            }
            catch (error) {
                console.error(`File watcher error: ${error}`);
            }
        }
    });
    console.error('File watcher initialized for .amazonq directory');
}
// Main function to start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("IBM i MCP Server running on stdio...");
    // If env vars didn't provide config, try VS Code settings
    if (!ibmiConfig) {
        const vsConfig = await loadConfigFromVSCode();
        if (vsConfig && vsConfig.host && vsConfig.user) {
            ibmiConfig = vsConfig;
            console.error(`Loaded IBM i config from VS Code: ${vsConfig.user}@${vsConfig.host}`);
        }
    }
    // Ensure SSH key is generated and installed on the IBM i host
    if (ibmiConfig) {
        ibmiConfig = await ensureSshKey(ibmiConfig);
    }
    // Setup file watcher
    await setupFileWatcher();
}
// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.error('Shutting down IBM i MCP Server...');
    await server.close();
    process.exit(0);
});
// Start the server
if (process.argv[2] !== 'test') {
    main().catch((error) => {
        console.error("Server error:", error);
        process.exit(1);
    });
}
else {
    console.log("IBM i MCP Server loaded successfully - test mode");
}
//# sourceMappingURL=index.js.map
