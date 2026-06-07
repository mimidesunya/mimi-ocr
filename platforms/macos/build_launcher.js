const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { createCanvas } = require('canvas');

const repoRoot = path.resolve(__dirname, '..', '..');
const outputDir = path.resolve(process.env.MIMI_LAUNCHER_OUTPUT_DIR || path.join(repoRoot, 'bin'));
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

const appName = 'MIMI OCR.app';
const appDir = path.join(outputDir, appName);
const contentsDir = path.join(appDir, 'Contents');
const macosDir = path.join(contentsDir, 'MacOS');
const resourcesDir = path.join(contentsDir, 'Resources');
const executablePath = path.join(macosDir, 'mimi-ocr');
const plistPath = path.join(contentsDir, 'Info.plist');
const iconPath = path.join(resourcesDir, 'app.icns');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function escapePlist(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawIconPng(outputPath, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const scale = size / 1024;

  ctx.clearRect(0, 0, size, size);

  const bg = ctx.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, '#2f6fed');
  bg.addColorStop(0.55, '#0f9f9a');
  bg.addColorStop(1, '#f2b84b');
  roundRect(ctx, 72 * scale, 72 * scale, 880 * scale, 880 * scale, 190 * scale);
  ctx.fillStyle = bg;
  ctx.fill();

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
  ctx.shadowBlur = 34 * scale;
  ctx.shadowOffsetY = 22 * scale;
  roundRect(ctx, 236 * scale, 160 * scale, 488 * scale, 656 * scale, 44 * scale);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();

  roundRect(ctx, 292 * scale, 250 * scale, 376 * scale, 38 * scale, 19 * scale);
  ctx.fillStyle = '#d7e4f4';
  ctx.fill();
  roundRect(ctx, 292 * scale, 340 * scale, 376 * scale, 34 * scale, 17 * scale);
  ctx.fillStyle = '#e4edf7';
  ctx.fill();
  roundRect(ctx, 292 * scale, 428 * scale, 272 * scale, 34 * scale, 17 * scale);
  ctx.fill();

  ctx.font = `700 ${250 * scale}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#172033';
  ctx.fillText('M', 512 * scale, 622 * scale);

  ctx.font = `700 ${86 * scale}px Arial, Helvetica, sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('OCR', 512 * scale, 874 * scale);

  fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

function createMacIcon() {
  const tempDir = fs.mkdtempSync(path.join(resourcesDir, 'app-icon-'));
  const pngPath = path.join(tempDir, 'app.png');
  const tiffPath = path.join(tempDir, 'app.tiff');

  drawIconPng(pngPath, 1024);

  const sipsResult = childProcess.spawnSync('/usr/bin/sips', ['-s', 'format', 'tiff', pngPath, '--out', tiffPath], {
    cwd: resourcesDir,
    encoding: 'utf8',
  });

  if (sipsResult.error) {
    throw sipsResult.error;
  }
  if (sipsResult.status !== 0) {
    throw new Error(sipsResult.stderr || sipsResult.stdout || 'sips failed');
  }

  const icnsResult = childProcess.spawnSync('/usr/bin/tiff2icns', [tiffPath, iconPath], {
    cwd: resourcesDir,
    encoding: 'utf8',
  });

  if (icnsResult.error) {
    throw icnsResult.error;
  }
  if (icnsResult.status !== 0) {
    throw new Error(icnsResult.stderr || icnsResult.stdout || 'tiff2icns failed');
  }

  fs.rmSync(tempDir, { recursive: true, force: true });

}

const launcherScript = `#!/bin/sh
set -eu

show_dialog() {
  /usr/bin/osascript \\
    -e 'on run argv' \\
    -e 'display dialog item 2 of argv buttons {"OK"} default button "OK" with title item 1 of argv' \\
    -e 'end run' \\
    -- "$1" "$2" >/dev/null 2>&1 || true
}

node_env_script='
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [ -z "\${NVM_DIR:-}" ]; then
  export NVM_DIR="$HOME/.nvm"
fi

for nvm_script in "$NVM_DIR/nvm.sh" "$HOME/.nvm/nvm.sh" "/opt/homebrew/opt/nvm/nvm.sh" "/usr/local/opt/nvm/nvm.sh"; do
  if [ -s "$nvm_script" ]; then
    . "$nvm_script"
    break
  fi
done

if command -v nvm >/dev/null 2>&1 && [ -n "\${MIMI_OCR_PROJECT_ROOT:-}" ] && [ -f "$MIMI_OCR_PROJECT_ROOT/.nvmrc" ]; then
  nvm use --silent "$(cat "$MIMI_OCR_PROJECT_ROOT/.nvmrc")" >/dev/null 2>&1 || true
fi
'

launcher_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(CDPATH= cd -- "$launcher_dir/../../../.." && pwd)"

if [ ! -d "$project_root/node_modules" ]; then
  show_dialog "MIMI OCR - セットアップが必要です" "node_modules が見つかりません。
初回起動前にプロジェクトフォルダで以下を実行してください:

    npm install

プロジェクトフォルダ:
$project_root"
  exit 1
fi

cd "$project_root" || {
  show_dialog "MIMI OCR エラー" "プロジェクトフォルダを開けませんでした:
$project_root"
  exit 1
}

if ! MIMI_OCR_PROJECT_ROOT="$project_root" /bin/zsh -lc "$node_env_script command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1"; then
  show_dialog "MIMI OCR エラー" "起動に失敗しました。

npm と node がインストールされているか確認してください。"
  exit 1
fi

MIMI_OCR_PROJECT_ROOT="$project_root" exec /bin/zsh -lc "$node_env_script cd \\"\\$MIMI_OCR_PROJECT_ROOT\\" && npm run gui"
`;

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>ja</string>
  <key>CFBundleDisplayName</key>
  <string>MIMI OCR</string>
  <key>CFBundleExecutable</key>
  <string>mimi-ocr</string>
  <key>CFBundleIconFile</key>
  <string>app</string>
  <key>CFBundleIdentifier</key>
  <string>jp.mimi-ocr.launcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>MIMI OCR</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapePlist(packageJson.version || '1.0.0')}</string>
  <key>CFBundleVersion</key>
  <string>${escapePlist(packageJson.version || '1.0.0')}</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;

fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(macosDir, { recursive: true });
fs.mkdirSync(resourcesDir, { recursive: true });
fs.writeFileSync(executablePath, launcherScript, { encoding: 'utf8', mode: 0o755 });
fs.chmodSync(executablePath, 0o755);
fs.writeFileSync(plistPath, infoPlist, 'utf8');
createMacIcon();

const totalSize = [executablePath, plistPath, iconPath]
  .map((filePath) => fs.statSync(filePath).size)
  .reduce((sum, size) => sum + size, 0);

console.log(`[launcher] macOS app: ${path.relative(repoRoot, appDir)}`);
console.log(`[launcher] launcher output total: ${formatBytes(totalSize)}`);
