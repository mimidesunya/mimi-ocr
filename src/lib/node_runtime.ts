const fs = require('fs');
const path = require('path');

function isExecutableFile(filePath: string) {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (_err) {
        return false;
    }
}

function isElectronExecutable(filePath: string) {
    return /electron(?:\.exe)?$/i.test(path.basename(String(filePath || '')));
}

function findOnPath(commandName: string, env: any = process.env, platform = process.platform) {
    const pathDirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    const extensions = platform === 'win32'
        ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
        : [''];
    const hasExt = path.extname(commandName) !== '';
    const names = platform === 'win32' && !hasExt
        ? extensions.map(ext => `${commandName}${ext.toLowerCase()}`).concat(extensions.map(ext => `${commandName}${ext.toUpperCase()}`))
        : [commandName];

    for (const dir of pathDirs) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (isExecutableFile(candidate)) return candidate;
        }
    }
    return null;
}

function getScriptNodeRuntime(options: any = {}) {
    const projectRoot = path.resolve(options.projectRoot || process.cwd());
    const execPath = String(options.execPath || process.execPath || '');
    const env = options.env || process.env;
    const platform = options.platform || process.platform;
    const nodeName = platform === 'win32' ? 'node.exe' : 'node';
    const envNode = String(env.MIMI_OCR_NODE || '').trim();

    if (envNode) {
        return { command: envNode, electronAsNode: isElectronExecutable(envNode) };
    }

    const candidates = [
        path.join(projectRoot, '..', 'runtime', 'node', nodeName),
        execPath ? path.join(path.dirname(path.dirname(execPath)), 'node', nodeName) : '',
        findOnPath(nodeName, env, platform),
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (isExecutableFile(candidate)) {
            return { command: candidate, electronAsNode: false };
        }
    }

    if (isElectronExecutable(execPath)) {
        return { command: execPath, electronAsNode: true };
    }

    return { command: platform === 'win32' ? 'node' : 'node', electronAsNode: false };
}

module.exports = {
    findOnPath,
    getScriptNodeRuntime,
    isElectronExecutable,
};
