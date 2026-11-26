const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getToolConfig } = require('./gemini_client');
const { resolveNdlocrLite } = require('./tool_resolver');

/**
 * ndlocr-lite に渡す引数（入力・出力と追加の指定）。起動の仕方（PyPI 版か src/ocr.py か）には依らない。
 * @param {string} sourcePath Path to an image file, a directory containing images, or a PDF.
 * @param {string} destDir Path to the output directory where ndlocr will save results.
 * @param {boolean|string} isDir True if sourcePath is a directory, 'pdf' for a PDF (--sourcepdf).
 * @param {string[]} extraArgs Additional ndlocr-lite arguments (e.g. --pdf-output).
 */
function buildNdlocrArgs(sourcePath, destDir, isDir: boolean | string = false, extraArgs: string[] = []) {
    const args = [];
    if (isDir === 'pdf') {
        args.push('--sourcepdf', sourcePath);
    } else if (isDir) {
        args.push('--sourcedir', sourcePath);
    } else {
        args.push('--sourceimg', sourcePath);
    }
    args.push('--output', destDir, ...extraArgs);
    return args;
}

/**
 * ndlocr-lite の起動の仕方（実行ファイル・先頭の引数・作業フォルダ）。
 * PyPI 版は venv の ndlocr-lite を、設定の repoPath（自分で clone した版）は python src/ocr.py を使う。
 */
function getNdlocrLaunch(resolved) {
    if (resolved.kind === 'repo') {
        const repoPath = resolved.repoPath;
        if (!repoPath || !fs.existsSync(repoPath)) {
            throw new Error(`ndlocr-lite のリポジトリが見つかりません。設定を確認してください: ${repoPath}`);
        }
        const ocrPyPath = path.join(repoPath, 'src', 'ocr.py');
        if (!fs.existsSync(ocrPyPath)) {
            throw new Error(`ocr.py が見つかりません: ${ocrPyPath}`);
        }
        return { command: resolved.pythonPath || 'python', args: [ocrPyPath], cwd: path.join(repoPath, 'src') };
    }

    if (!resolved.command || !fs.existsSync(resolved.command)) {
        throw new Error(`ndlocr-lite が見つかりません: ${resolved.command}`);
    }
    return { command: resolved.command, args: [], cwd: undefined };
}

/**
 * Executes ndlocr-lite on a given image file, directory or PDF.
 * @param {string} sourcePath Path to an image file or a directory containing images.
 * @param {string} destDir Path to the output directory where ndlocr will save results.
 * @param {boolean|string} isDir True if sourcePath is a directory, 'pdf' for a PDF (--sourcepdf).
 * @param {string[]} extraArgs Additional ndlocr-lite arguments (e.g. --pdf-output).
 */
async function runNdlocr(sourcePath, destDir, isDir: boolean | string = false, extraArgs: string[] = []) {
    const ndlocrLite = getToolConfig('ndlocrLite') || {};
    const resolved = await resolveNdlocrLite(ndlocrLite);
    const launch = getNdlocrLaunch(resolved);
    const args = [...launch.args, ...buildNdlocrArgs(sourcePath, destDir, isDir, extraArgs)];

    return new Promise((resolve, reject) => {
        console.log(`[ndlocr] 実行: ${launch.command} ${args.join(' ')}`);

        const child = spawn(launch.command, args, {
            cwd: launch.cwd,
            shell: false,
            windowsHide: true
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            const str = data.toString();
            stdout += str;
            // Ndlocr outputs progress, so we can log it if needed
            str.split('\n').forEach(line => {
                if (line.trim()) console.log(`[ndlocr] ${line.trim()}`);
            });
        });

        child.stderr.on('data', (data) => {
            const str = data.toString();
            stderr += str;
            str.split('\n').forEach(line => {
                if (line.trim()) console.warn(`[ndlocr-err] ${line.trim()}`);
            });
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`ndlocr-lite exited with code ${code}: ${stderr}`));
            }
        });

        child.on('error', (err) => {
            reject(new Error(`ndlocr-lite を起動できませんでした（${launch.command}）: ${err.message}`));
        });
    });
}

module.exports = {
    runNdlocr,
    buildNdlocrArgs,
    getNdlocrLaunch,
};
