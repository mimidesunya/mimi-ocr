const childProcess = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const platformScripts = {
  win32: path.join(repoRoot, 'platforms', 'windows', 'build_launcher.js'),
  darwin: path.join(repoRoot, 'platforms', 'macos', 'build_launcher.js'),
};

const scriptPath = platformScripts[process.platform];

if (!scriptPath) {
  console.error(`[launcher] Unsupported platform: ${process.platform}`);
  process.exit(1);
}

const result = childProcess.spawnSync(process.execPath, [scriptPath], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[launcher] ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status || 0);
