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

`config.json` を開き、使いたいプロバイダーのAPIキーやモデル名を設定してください。

### 3. 必要なら `ndlocr-lite` を設定する

`config.json` の `ndlocrLite.repoPath` に、`ndlocr-lite` リポジトリの絶対パスを設定します。

### 4. ビルドする

```powershell
npm run build
```

## GUI 起動

```powershell
npm run gui
```

Electron GUI が起動し、ドラッグアンドドロップで文書を処理できます。

## CLI 利用

```powershell
npm run ocr -- <入力パス>
npm run merge -- <入力パス>
```

`npm run ocr` と `npm run merge` は、先に TypeScript をビルドしてから `dist/src/*.js` を実行します。

## Windows ランチャーを作る

```powershell
npm run build:launcher
```

生成物:

- `bin/mimi-ocr.exe`

補足:

- ランチャーは `npm run gui` を起動するだけなので、`node_modules` が存在する前提です。
- `src/launcher/Launcher.csproj` は `net10.0-windows` / `win-x64` を対象にしています。

## セキュリティ注意

- `config.json` にはAPIキーが入るため、共有やコミットの前に取り扱いを確認してください。
- 配布用やサンプル用途では、`config.template.json` を基準にしてください。
