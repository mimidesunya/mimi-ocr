const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const repoRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(repoRoot, 'package.json'));
const packageVersion = String(process.env.MIMI_RELEASE_VERSION || packageJson.version || '').trim();
const releaseRoot = path.resolve(process.env.MIMI_RELEASE_DIR || path.join(repoRoot, 'release', 'mimi-ocr-win-x64'));
const appDir = path.join(releaseRoot, 'app');
const runtimeDir = path.join(releaseRoot, 'runtime');
const electronSourceDir = path.join(repoRoot, 'node_modules', 'electron', 'dist');
const electronDestDir = path.join(runtimeDir, 'electron');
const nodeRuntimeSourcePath = path.resolve(process.env.MIMI_NODE_RUNTIME || process.execPath);
const nodeRuntimeDestDir = path.join(runtimeDir, 'node');
const nodeRuntimeDestPath = path.join(nodeRuntimeDestDir, process.platform === 'win32' ? 'node.exe' : 'node');
const launcherScript = path.join(repoRoot, 'platforms', 'windows', 'build_launcher.js');

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
    ...options,
  });

  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function assertSafeReleasePath(targetPath) {
  const resolved = path.resolve(targetPath);
  const allowedRoot = path.resolve(repoRoot, 'release');
  if (!resolved.startsWith(allowedRoot + path.sep) && resolved !== allowedRoot) {
    throw new Error(`Refusing to clean release path outside ${allowedRoot}: ${resolved}`);
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function shouldSkipNodeModuleCopy(src) {
  const relative = path.relative(path.join(repoRoot, 'node_modules'), src);
  const topLevel = relative.split(path.sep)[0];
  if (topLevel === 'electron') return true;

  const name = path.basename(src).toLowerCase();
  if (name === '.cache' || name === '.bin') return true;
  return false;
}

function copyDir(src, dest, filter = () => true) {
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (source) => filter(source),
  });
}

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function pruneFilesByExtension(rootDir, extensions) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [rootDir];
  const normalized = new Set(extensions.map((ext) => ext.toLowerCase()));
  let removedCount = 0;
  let removedBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && normalized.has(path.extname(entry.name).toLowerCase())) {
        const size = fs.statSync(entryPath).size;
        fs.rmSync(entryPath, { force: true });
        removedCount++;
        removedBytes += size;
      }
    }
  }

  if (removedCount > 0) {
    console.log(`[release] Removed ${removedCount} metadata files (${formatBytes(removedBytes)})`);
  }
}

function pruneNodeModulesForRelease() {
  const nodeModulesDir = path.join(appDir, 'node_modules');
  removeIfExists(path.join(nodeModulesDir, 'electron'));
  removeIfExists(path.join(nodeModulesDir, '.bin'));
  removeIfExists(path.join(nodeModulesDir, '@types'));
  pruneFilesByExtension(nodeModulesDir, ['.map', '.d.ts', '.tsbuildinfo', '.pdb', '.iobj', '.ipdb', '.exp', '.lib']);
}

function rebuildNativeNodeModulesForRelease() {
  console.log('[release] Rebuilding native dependency: canvas');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['rebuild', 'canvas'], {
    cwd: appDir,
  });
}

function pruneElectronRuntimeForRelease() {
  const localesDir = path.join(electronDestDir, 'locales');
  if (!fs.existsSync(localesDir)) return;
  const keepLocales = new Set(['en-US.pak', 'ja.pak']);
  let removedCount = 0;
  let removedBytes = 0;

  for (const entry of fs.readdirSync(localesDir, { withFileTypes: true })) {
    if (!entry.isFile() || keepLocales.has(entry.name)) continue;
    const entryPath = path.join(localesDir, entry.name);
    removedBytes += fs.statSync(entryPath).size;
    fs.rmSync(entryPath, { force: true });
    removedCount++;
  }

  if (removedCount > 0) {
    console.log(`[release] Removed ${removedCount} unused Electron locale files (${formatBytes(removedBytes)})`);
  }
}

function copyNodeRuntimeForRelease() {
  if (!fs.existsSync(nodeRuntimeSourcePath)) {
    throw new Error(`Node runtime not found: ${nodeRuntimeSourcePath}`);
  }
  console.log(`[release] Copying Node runtime: ${nodeRuntimeSourcePath}`);
  fs.mkdirSync(nodeRuntimeDestDir, { recursive: true });
  copyFile(nodeRuntimeSourcePath, nodeRuntimeDestPath);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('') + '-' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function sanitizeFilePart(value) {
  return String(value || '').replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function writeReadme() {
  const text = [
    'MIMI OCR Windows リリースパッケージ',
    packageVersion ? `バージョン: ${packageVersion}` : '',
    '',
    '起動:',
    '  mimi-ocr.exe をダブルクリックしてください。',
    '',
    'このパッケージには Electron ランタイムを同梱しているため、利用者側で Node.js / npm を入れる必要はありません。',
    'OCR の子プロセス用 Node ランタイムも同梱しています。',
    '',
    '初回設定:',
    '  - Gemini を使う場合は、画面上部の「APIキー」から取得手順を確認し、設定に APIキーを保存してください。',
    '  - ndlocr-lite を使う場合は、初回実行時にアプリ標準の保存先へ GitHub から自動取得します。',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(releaseRoot, 'README-START.txt'), text, 'utf-8');
}

function buildZipArchive() {
  const timestamp = process.env.MIMI_RELEASE_TIMESTAMP || formatTimestamp();
  const releaseName = path.basename(releaseRoot);
  const versionPart = packageVersion ? `${sanitizeFilePart(packageVersion)}-` : '';
  const zipPath = path.join(path.dirname(releaseRoot), `${releaseName}-${versionPart}${timestamp}.zip`);
  assertSafeReleasePath(zipPath);

  console.log(`[release] Building zip: ${zipPath}`);
  fs.rmSync(zipPath, { force: true });
  const zip = new AdmZip();
  zip.addLocalFolder(releaseRoot, releaseName);
  zip.writeZip(zipPath);

  const size = fs.statSync(zipPath).size;
  console.log(`[release] zip: ${formatBytes(size)}`);
  return zipPath;
}

function main() {
  if (process.platform !== 'win32') {
    throw new Error('This release builder currently supports Windows only.');
  }
  if (!fs.existsSync(electronSourceDir)) {
    throw new Error(`Electron runtime not found: ${electronSourceDir}`);
  }

  assertSafeReleasePath(releaseRoot);

  console.log('[release] Building TypeScript assets');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);

  console.log(`[release] Cleaning ${releaseRoot}`);
  fs.rmSync(releaseRoot, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });

  console.log('[release] Copying app files');
  copyDir(path.join(repoRoot, 'dist'), path.join(appDir, 'dist'));
  copyFile(path.join(repoRoot, 'package.json'), path.join(appDir, 'package.json'));
  copyFile(path.join(repoRoot, 'package-lock.json'), path.join(appDir, 'package-lock.json'));
  copyFile(path.join(repoRoot, 'app.defaults.json'), path.join(appDir, 'app.defaults.json'));
  copyFile(path.join(repoRoot, 'config.template.json'), path.join(appDir, 'config.template.json'));
  copyFile(path.join(repoRoot, 'README.md'), path.join(appDir, 'README.md'));

  console.log('[release] Copying node_modules');
  copyDir(path.join(repoRoot, 'node_modules'), path.join(appDir, 'node_modules'), (source) => !shouldSkipNodeModuleCopy(source));

  console.log('[release] Pruning development dependencies');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['prune', '--omit=dev', '--ignore-scripts'], {
    cwd: appDir,
  });
  rebuildNativeNodeModulesForRelease();
  pruneNodeModulesForRelease();

  console.log('[release] Copying Electron runtime');
  copyDir(electronSourceDir, electronDestDir);
  pruneElectronRuntimeForRelease();

  copyNodeRuntimeForRelease();

  console.log('[release] Building launcher');
  run(process.execPath, [launcherScript], {
    env: {
      ...process.env,
      MIMI_LAUNCHER_OUTPUT_DIR: releaseRoot,
    },
  });

  writeReadme();

  const launcherPath = path.join(releaseRoot, 'mimi-ocr.exe');
  const mainPath = path.join(appDir, 'dist', 'src', 'gui', 'main.js');
  const electronPath = path.join(electronDestDir, 'electron.exe');
  for (const required of [launcherPath, mainPath, electronPath, nodeRuntimeDestPath]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Release output is incomplete: ${required}`);
    }
  }

  console.log(`[release] Done: ${releaseRoot}`);
  const zipPath = buildZipArchive();
  console.log(`[release] Zip done: ${zipPath}`);
  console.log('[release] Start with: mimi-ocr.exe');
}

try {
  main();
} catch (err) {
  console.error(`[release] ${err.message}`);
  process.exit(1);
}
