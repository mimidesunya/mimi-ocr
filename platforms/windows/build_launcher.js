const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const projectPath = path.join(__dirname, 'launcher', 'Launcher.csproj');
const nativeSourcePath = path.join(__dirname, 'launcher', 'native_launcher.c');
const resourceScriptPath = path.join(__dirname, 'launcher', 'app.rc');
const outputDir = path.resolve(process.env.MIMI_LAUNCHER_OUTPUT_DIR || path.join(repoRoot, 'bin'));

const launcherOutputs = [
  'mimi-ocr.exe',
  'mimi-ocr.dll',
  'mimi-ocr.deps.json',
  'mimi-ocr.runtimeconfig.json',
  'mimi-ocr.pdb',
  'mimi-ocr.res.o',
];

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function findOnPath(commandName) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = childProcess.spawnSync(finder, [commandName], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function removeLauncherOutput(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (err) {
    throw new Error(
      `Cannot replace ${filePath}. Close any running MIMI OCR windows and try again. (${err.message})`
    );
  }
}

function buildNativeLauncher() {
  const gccPath = findOnPath('gcc');
  if (!gccPath) return false;

  const windresBesideGcc = path.join(path.dirname(gccPath), 'windres.exe');
  const windresPath = fs.existsSync(windresBesideGcc) ? windresBesideGcc : findOnPath('windres');
  if (!windresPath) return false;

  const resourceObjectPath = path.join(outputDir, 'mimi-ocr.res.o');
  const exePath = path.join(outputDir, 'mimi-ocr.exe');

  console.log(`[launcher] Native Windows build: ${gccPath}`);
  run(windresPath, ['-O', 'coff', resourceScriptPath, resourceObjectPath], {
    cwd: path.join(__dirname, 'launcher'),
  });
  run(gccPath, [
    '-municode',
    '-mwindows',
    '-Os',
    '-s',
    nativeSourcePath,
    resourceObjectPath,
    '-o',
    exePath,
  ]);

  fs.rmSync(resourceObjectPath, { force: true });
  return true;
}

function buildDotnetLauncher() {
  console.log('[launcher] MinGW gcc/windres not found; falling back to dotnet publish.');
  run('dotnet', ['publish', projectPath, '-c', 'Release', '-o', outputDir]);
}

fs.mkdirSync(outputDir, { recursive: true });
for (const fileName of launcherOutputs) {
  removeLauncherOutput(path.join(outputDir, fileName));
}

try {
  try {
    if (!buildNativeLauncher()) {
      buildDotnetLauncher();
    }
  } catch (nativeErr) {
    console.warn(`[launcher] Native build failed; falling back to dotnet publish. (${nativeErr.message})`);
    buildDotnetLauncher();
  }
} catch (err) {
  console.error(`[launcher] ${err.message}`);
  process.exit(1);
}

const exePath = path.join(outputDir, 'mimi-ocr.exe');
if (fs.existsSync(exePath)) {
  const exeSize = fs.statSync(exePath).size;
  const totalSize = launcherOutputs
    .map((fileName) => path.join(outputDir, fileName))
    .filter((filePath) => fs.existsSync(filePath))
    .reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0);

  console.log(`[launcher] mimi-ocr.exe: ${formatBytes(exeSize)}`);
  console.log(`[launcher] launcher output total: ${formatBytes(totalSize)}`);
}
