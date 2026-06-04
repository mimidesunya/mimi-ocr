# セットアップ

## 前提環境

- Windows x64 推奨
- Node.js と npm
- `npm install` が通るローカルビルド環境
- `ndlocr-lite` を使う場合は Python 3.10 以上
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

GUI上部の「設定」からAPIキーやモデル名を設定できます。「APIキー」タブには、Gemini / OpenAI / Claude のキー取得手順もあります。CLI中心で使う場合は、`config.json` を直接編集してください。

### 3. 必要ツールについて

法匪モードは同梱テンプレートを使うため、追加設定は不要です。ffmpeg と ndlocr-lite は未設定なら初回使用時に `.mimi-tools/` へ自動準備します。既に手元のツールを使いたい場合だけ、`config.json` にパスを指定してください。

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

## Windows ランチャーを作る

```powershell
npm run build:launcher
```

生成物:

- `bin/mimi-ocr.exe`

補足:

- ランチャーは `npm run gui` を起動するだけなので、`node_modules` が存在する前提です。
- Windows 固有のランチャーソースは `platforms/windows/launcher/` にあります。
- MinGW-w64 の `gcc` / `windres` が見つかる場合は、小さい Win32 ネイティブランチャーを生成します。
- MinGW-w64 が見つからない場合は、`platforms/windows/launcher/Launcher.csproj` から .NET フレームワーク依存ランチャーを生成します。その場合は `bin/` に出る `mimi-ocr.dll` / `*.json` も同じ場所に置いたまま使ってください。
- ランチャー自体の生成は `dist/src/lib/build_info.json` を更新しません。OCR実行用のビルド番号を更新したい場合は `npm run build` または `npm run gui` / `npm run ocr` を実行してください。

## セキュリティ注意

- `config.json` にはAPIキーが入るため、共有やコミットの前に取り扱いを確認してください。
- 配布用やサンプル用途では、`config.template.json` を基準にしてください。
