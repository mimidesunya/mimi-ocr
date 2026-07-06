# セットアップ

## 前提環境

- Windows x64 / macOS 推奨
- 開発環境では Node.js と npm
- Windows リリースパッケージ利用時は Node.js / npm 不要
- `npm install` が通るローカルビルド環境（開発・リリース作成時）
- `ndlocr-lite` を使う場合は Python 3.10 以上
- macOS で無音カットや音声変換を使う場合は ffmpeg（例: `brew install ffmpeg`）
- `bin/mimi-ocr.exe` を小さく作る場合は MinGW-w64 の `gcc` / `windres`
- MinGW-w64 がない環境で `bin/mimi-ocr.exe` を作る場合は .NET 10 SDK

## 初回セットアップ

### 1. 依存関係を入れる

```powershell
npm install
```

### 2. 設定ファイルを作る

```powershell
Copy-Item config.template.json config.json
```

GUI上部の「設定」からAPIキーやモデル名の上書きを設定できます。「APIキー」タブには、Gemini / OpenAI / Claude のキー取得手順もあります。アプリ標準値は `app.defaults.json` に入っています。CLI中心で使う場合は、`config.json` を直接編集してください。

### 3. 必要ツールについて

法匪モードは同梱テンプレートを使うため、追加設定は不要です。ndlocr-lite は初回使用時にアプリ標準の保存先へ GitHub から自動準備します。ffmpeg は Windows では外部ツール保存先へ自動準備し、macOS では PATH 上の `ffmpeg` / `ffprobe` を使います。

### 4. ビルドする

```powershell
npm run build
```

`npm run build` は TypeScript を `dist/` に出力したあと、`dist/src/lib/build_info.json` を生成します。ここに入る短いタイムスタンプ形式の `number` が、OCR結果 Markdown 末尾の `build` として記録されます。

## GUI 起動

```powershell
npm run gui
```

Electron GUI が起動し、ドラッグアンドドロップで文書を処理できます。

## CLI 利用

```powershell
npm run ocr -- <入力パス>
npm run merge -- <入力パス>
npm run pdf-pages -- --pages 1-3,7,8 <PDFファイル>
```

各 `npm run ...` コマンドは、先に TypeScript をビルドしてから `dist/src/*.js` を実行します。

## ランチャーを作る

```powershell
npm run build:launcher
```

実行した OS に応じて Windows 用または Mac 用のランチャーを生成します。

生成物:

- `bin/mimi-ocr.exe`
- `bin/MIMI OCR.app`

補足:

- ランチャーは `npm run gui` を起動するだけなので、`node_modules` が存在する前提です。
- Windows だけを明示的に作る場合は `npm run build:launcher:windows` を使います。
- Mac だけを明示的に作る場合は `npm run build:launcher:mac` を使います。
- Windows 固有のランチャーソースは `platforms/windows/launcher/` にあります。
- MinGW-w64 の `gcc` / `windres` が見つかる場合は、小さい Win32 ネイティブランチャーを生成します。
- MinGW-w64 が見つからない場合は、`platforms/windows/launcher/Launcher.csproj` から self-contained single-file の .NET ランチャーを生成します。
- Mac 用は `platforms/macos/build_launcher.js` から `.app` バンドルを生成します。Finder から `bin/MIMI OCR.app` を開くと起動できます。

## Windows リリースパッケージを作る

```powershell
npm run build:release:windows
```

`release/mimi-ocr-win-x64/` に、同梱 Electron ランタイム、アプリ本体、`mimi-ocr.exe` をまとめます。配布時はこのフォルダごと渡します。利用者側に Node.js / npm / .NET ランタイムは不要です。
- ランチャー自体の生成は `dist/src/lib/build_info.json` を更新しません。OCR実行用のビルド番号を更新したい場合は `npm run build` または `npm run gui` / `npm run ocr` を実行してください。

## セキュリティ注意

- `config.json` にはAPIキーが入るため、共有やコミットの前に取り扱いを確認してください。
- 配布用の標準値は `app.defaults.json`、ユーザー向けサンプルは `config.template.json` を基準にしてください。
