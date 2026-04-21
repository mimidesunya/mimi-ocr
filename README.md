# mimi-ocr

日本語文書を Markdown に変換する OCR ツールです。Electron GUI と CLI の両方に対応し、AI プロバイダーとして Gemini / Claude / OpenAI を利用できます。

PDF だけでなく、Word (`.docx` / `.doc`)、ODT、PowerPoint (`.pptx`) も処理できます。

## 主な機能

- PDF / Word / ODT / PowerPoint の Markdown 化
- Gemini / Claude / OpenAI の切り替え
- PDF での `ndlocr-lite` 併用
- OCR 後のページ結合 (`*_paged.md` -> `*_merged.md`)
- 先頭4ページと末尾4ページを使った AI 自動ファイル名変更
- OCR 結果に基づく文書分割（JSON 定義で複数ファイルに分割）
- OCR 結果に基づくブランクページ除去（白紙ページを除いた PDF + MD ペアを生成）
- Windows 用ランチャー EXE の生成

## 動作環境

- Windows x64 推奨
- Node.js / npm
- `npm install` が通るローカル環境
- `ndlocr-lite` を使う場合は Python と別途 `ndlocr-lite` リポジトリ
- EXE ビルドを行う場合は .NET 10 SDK

## クイックスタート

### 1. 依存関係を入れる

```powershell
npm install
```

### 2. 設定ファイルを作る

```powershell
Copy-Item config.template.json config.json
```

`config.json` に API キーとモデル名を設定してください。

### 3. GUI を起動する

```powershell
npm run gui
```

ファイルをドラッグアンドドロップして OCR を実行できます。

## CLI の使い方

### OCR

```powershell
npm run ocr -- <入力パス...> [オプション]
```

例:

```powershell
npm run ocr -- .\sample.pdf
npm run ocr -- .\sample.pdf --ai openai --mode batch
npm run ocr -- .\sample.pdf --target houhi
npm run ocr -- .\sample.pdf --ndlocr
```

### ページ結合

```powershell
npm run merge -- <Markdownファイルまたはディレクトリ>
```

### 文書分割

OCR 済みの `_paged.md` と PDF を、JSON 定義に基づいて文書ごとに分割します。

```powershell
npm run split -- <PDFまたはMDファイル> --json-file <JSONファイル>
```

JSON ファイルの形式:

```json
[
  {"filename": "2024-01-15_契約書.md", "start_page": 1, "end_page": 5},
  {"filename": "2024-02-20_報告書.md", "start_page": 6, "end_page": 10}
]
```

分割定義がドキュメント全体を網羅していない場合は警告が表示されます。

### ブランクページ除去

OCR 結果を解析し、白紙ページを除いた PDF と MD のペアを生成します。

```powershell
npm run deblank -- <PDFファイル> [--threshold <文字数>]
```

デフォルトでは本文が 10 文字以下のページを白紙と判定します。`--threshold` で変更可能です。

## よく使うオプション

| オプション | 説明 |
| --- | --- |
| `--target houhi\|general` | 出力スタイルを切り替える |
| `--context-file <path>` | houhi 用のサンプル Markdown を指定する |
| `--ai gemini\|claude\|openai` | AI プロバイダーを選ぶ |
| `--mode batch\|sync` | バッチ処理か同期処理かを選ぶ |
| `--batch_size <n>` | PDF の処理ページ数を指定する |
| `--start_page <n>` | 開始ページを指定する |
| `--end_page <n>` | 終了ページを指定する |
| `--ndlocr` | `ndlocr-lite` を前処理として使う |
| `--ndlocr_only` | `ndlocr-lite` のみで処理する |
| `--prefer_pdf_text` | 埋め込みテキストを優先する |
| `--auto_rename` | AI による自動ファイル名変更を有効にする |

## 出力ファイル

| ファイル | 説明 |
| --- | --- |
| `*_paged.md` | OCR 直後のページ境界付き Markdown |
| `*_ERROR_paged.md` | 一部失敗を含む途中結果 |
| `*_merged.md` | ページ結合後の Markdown |
| `*_noblank.pdf` / `*_noblank_paged.md` | ブランクページ除去後の PDF / MD |

## 自動ファイル名変更

デフォルトでは Off です。必要な場合だけ `--auto_rename` を付けると、OCR結果の先頭4ページと末尾4ページから内容を判定し、元文書を次の形式に自動変更します。

```text
YYYY-MM-DD_文書種類_タイトル
```

## リトライ

すべての AI プロバイダーの同期モードにリトライ機能があります（デフォルト最大 3 回、指数バックオフ）。バッチモード（Gemini）も失敗バッチを自動リトライします。

- 既にこの形式のファイル名なら変更しません
- OCR 結果ファイルが既に存在する場合でも動作します
- 文書種類は固定候補から選びます
- 日付がまったく不明な場合は実行日を使います
- 同名ファイルが既にある場合は ` (2)`, ` (3)` ... の連番を末尾に付けて回避します
- GUI でも初期設定は Off です
- `--no_auto_rename` も後方互換のため引き続き受け付けます

## EXE の生成

```powershell
npm run build:launcher
```

生成物:

- `bin/mimi-ocr.exe`

ランチャー EXE にはアイコンを設定済みです。

## ドキュメント

詳細は `docs/` を参照してください。

- [docs/index.md](./docs/index.md)
- [docs/setup.md](./docs/setup.md)
- [docs/usage.md](./docs/usage.md)
- [docs/configuration.md](./docs/configuration.md)
- [docs/architecture.md](./docs/architecture.md)
- [docs/troubleshooting.md](./docs/troubleshooting.md)

## 注意

- `config.json` には API キーを含むため、共有やコミット時は注意してください。
- 初回セットアップや環境依存の問題がある場合は `docs/troubleshooting.md` を確認してください。
