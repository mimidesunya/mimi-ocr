# セットアップ

## 前提環境

- Windows x64 推奨
- Node.js と npm
- `npm install` が通るローカルビルド環境
- `ndlocr-lite` を使う場合は Python と `ndlocr-lite` の別リポジトリ
- `bin/mimi-ocr.exe` を作る場合は .NET 10 SDK

## 初回セットアップ

### 1. 依存関係を入れる

```powershell
npm install
```

### 2. 設定ファイルを作る

```powershell
Copy-Item config.template.json config.json
```

`config.json` を開き、`providers` に使いたいプロバイダーのAPIキーやモデル名を設定してください。OCRと音声認識の既定値は、それぞれ `ocr` / `transcription` にまとめます。

### 3. 必要なら `ndlocr-lite` を設定する

`config.json` の `tools.ndlocrLite.repoPath` に、`ndlocr-lite` リポジトリの絶対パスを設定します。

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
- `src/launcher/Launcher.csproj` は `net10.0-windows` / `win-x64` を対象にしています。
- ランチャー自体の生成は `dist/src/lib/build_info.json` を更新しません。OCR実行用のビルド番号を更新したい場合は `npm run build` または `npm run gui` / `npm run ocr` を実行してください。

## セキュリティ注意

- `config.json` にはAPIキーが入るため、共有やコミットの前に取り扱いを確認してください。
- 配布用やサンプル用途では、`config.template.json` を基準にしてください。
