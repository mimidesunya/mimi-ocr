# 使い方

## GUI の基本操作

### 利用できるツール

- `OCR（一般）`: 一般文書向けの Markdown を生成
- `OCR（法匪）`: 裁判文書向けスタイルで生成
- `ページ結合`: `*_paged.md` のページ境界を整理
- `文書分割`: JSON 定義に基づいて `_paged.md` と PDF を文書ごとに分割
- `白紙除去`: OCR 結果をもとに白紙ページを除去した PDF + MD ペアを生成
- `PDF抽出`: OCR 結果をもとに PDF ページを抽出・結合・2面割付

### 画面オプション

- `OCR`: `AIのみ` / `ndlocr+AI` / `ndlocr-only`
- `AI`: `Gemini` / `Claude` / `OpenAI`
- `Mode`: `バッチ` / `同期`
- `PDFテキスト`: 埋め込みテキスト優先のオンオフ
- `バッチサイズ`: PDF を何ページずつ処理するか
- `コンテキスト`: houhi モードで使うサンプル Markdown
- `PDF抽出` 選択時は、ページ指定、PDFページ/印刷ページ、2面割付、ページ方向を指定できます。

### GUI 上の制約

- ツールカードへ直接ファイルをドロップすると、そのツールに切り替わって処理します。
- `ページ結合`・`文書分割`・`白紙除去` 選択時は OCR 関連オプションは無効になります。
- `文書分割` 選択時は分割定義 JSON の入力欄が表示されます。
- `PDF抽出` 選択時は、先にPDFファイルをドロップまたは選択して登録します。その後、ファイルごとのページ指定を入力して `実行` を押します。
- 登録されたPDFはファイル名順に並び、上下ボタン、削除ボタン、ドラッグで順番を変更できます。
- `ndlocr-only` 選択時は AI と処理モード選択は無効になります。
- `Claude` 選択時は同期モード固定です。

## CLI の基本

### OCR

```powershell
npm run ocr -- <入力パス...> [オプション]
```

対応入力:

- 単一ファイル
- 複数ファイル
- 対応ファイルが入ったディレクトリ

注意:

- ディレクトリ処理は直下の対応ファイルのみで、再帰走査はしません。

### ページ結合

```powershell
npm run merge -- <Markdownファイルまたはディレクトリ>
```

## OCR オプション一覧

| オプション | 説明 |
| --- | --- |
| `--target houhi\|general` | 出力スタイルを切り替える |
| `--context-file <path>` | houhi モード用のサンプル Markdown を指定する |
| `--batch_size <n>` | PDF の処理単位ページ数 |
| `--start_page <n>` | 開始ページ |
| `--end_page <n>` | 終了ページ |
| `--show_prompt` | OCRプロンプトを表示して終了する |
| `--ai gemini\|claude\|openai` | AI プロバイダーを選ぶ |
| `--mode batch\|sync` | バッチ処理か同期処理かを選ぶ |
| `--ndlocr` | `ndlocr-lite` を前処理として使う |
| `--ndlocr_only` | AI を使わず `ndlocr-lite` のみで処理する |
| `--prefer_pdf_text` | 埋め込みテキストがある PDF では OCR よりそちらを優先する |

## 実行例

### 一般文書をOCRする

```powershell
npm run ocr -- .\samples\report.pdf
```

### houhi 形式でOCRする

```powershell
npm run ocr -- .\samples\case.pdf --target houhi
```

### OpenAI を使ってバッチ処理する

```powershell
npm run ocr -- .\samples\book.pdf --ai openai --mode batch --batch_size 4
```

### `ndlocr-lite` を前処理として併用する

```powershell
npm run ocr -- .\samples\scan.pdf --ndlocr --ai gemini
```

### `ndlocr-lite` だけで処理する

```powershell
npm run ocr -- .\samples\scan.pdf --ndlocr_only
```

### PDF の埋め込みテキストを優先する

```powershell
npm run ocr -- .\samples\born-digital.pdf --prefer_pdf_text
```

### OCR 結果を結合する

```powershell
npm run merge -- .\samples\report_paged.md
```

### 文書分割

JSON 定義に基づいて OCR 済み `_paged.md` と PDF を文書ごとに分割します。

```powershell
npm run split -- .\samples\bundle.pdf --json-file .\split-def.json
```

JSON 形式:

```json
[
  {"filename": "2024-01-15_契約書.md", "start_page": 1, "end_page": 5},
  {"filename": "2024-02-20_報告書.md", "start_page": 6, "end_page": 10}
]
```

### ブランクページ除去

OCR 結果を解析し、白紙ページを除去した PDF + MD ペアを生成します。

```powershell
npm run deblank -- .\samples\scanned.pdf
npm run deblank -- .\samples\scanned.pdf --threshold 20
```

### PDFページ抽出・結合

PDF と同じ場所にある OCR 結果（`*_paged.md` または `*_ERROR_paged.md`）を使ってページを解決します。OCR結果がないPDFは処理できません。抽出後は PDF と同名の Markdown も出力し、Markdown 内の `### -- Begin Page N --` は抽出後の連番に振り直します。

ページ指定は `1-3,7,8` のように書きます。この例では 1 から 3 ページと 7、8 ページを抽出します。

```powershell
npm run pdf-pages -- --pages 1-3,7,8 .\samples\report.pdf
```

印刷ページで指定する場合:

```powershell
npm run pdf-pages -- --page-type printed --pages 10-12 .\samples\report.pdf
```

複数PDFを指定すると、抽出ページを指定順に1つのPDFへ結合し、対応するMarkdownも1つに結合します。

```powershell
npm run pdf-pages -- --pages 1-3 .\samples\a.pdf .\samples\b.pdf
```

PDFごとに別のページ範囲を指定する場合は、`PDF::ページ指定` 形式を使います。

```powershell
npm run pdf-pages -- ".\samples\a.pdf::1-3" ".\samples\b.pdf::7,8"
```

2面割付:

```powershell
npm run pdf-pages -- --pages 1-8 --two-up --direction ltr .\samples\report.pdf
npm run pdf-pages -- --pages 1-8 --two-up --direction rtl .\samples\report.pdf
```

`--direction ltr` は左から右、`--direction rtl` は右から左に配置します。

## 出力の見方

### OCR 直後

- `### -- Begin Page N --`
- `### -- End --`
- 必要に応じて `(Printed Page X)` や `(Continuation)` が付く
- ファイル末尾に `<!-- mimi-ocr-settings ... -->` 形式の不可視メタデータが付く

### ページ結合後

- ページマーカーが取り除かれる
- 続きページは段落がつながる
- そうでないページ境界は空行に変わる

### 末尾メタデータ

OCR 直後の Markdown には、末尾に HTMLコメント形式で実行設定が記録されます。Markdownビューでは通常表示されません。

```md
<!-- mimi-ocr-settings
{
  "tool": "mimi-ocr",
  "build": "260602-093804",
  "generatedAt": "2026-06-02T00:39:00.000Z",
  "source": "sample.pdf",
  "input": "pdf",
  "settings": {
    "target": "general",
    "ai": {
      "provider": "gemini",
      "model": "gemini-2.5-pro"
    },
    "processMode": "sync",
    "batchSize": 4,
    "pages": {
      "start": 1,
      "end": 12,
      "total": 12
    },
    "ndlocr": "off"
  }
}
-->
```

`preferPdfText`、`hasError`、`ndlocrSettings` は該当する場合だけ出力されます。APIキーは記録されません。

## 再実行時の挙動

- `*_paged.md` が既に存在する PDF / 文書はスキップされます。
- PDF で `*_ERROR_paged.md` が残っている場合は、成功済みページを再利用して再開します。
