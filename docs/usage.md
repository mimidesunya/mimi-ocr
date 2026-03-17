# 使い方

## GUI の基本操作

### 利用できるツール

- `OCR（一般）`: 一般文書向けの Markdown を生成
- `OCR（法匪）`: 裁判文書向けスタイルで生成
- `ページ結合`: `*_paged.md` のページ境界を整理
- `文書分割`: JSON 定義に基づいて `_paged.md` と PDF を文書ごとに分割
- `白紙除去`: OCR 結果をもとに白紙ページを除去した PDF + MD ペアを生成

### 画面オプション

- `OCR`: `AIのみ` / `ndlocr+AI` / `ndlocr-only`
- `AI`: `Gemini` / `Claude` / `OpenAI`
- `Mode`: `バッチ` / `同期`
- `PDFテキスト`: 埋め込みテキスト優先のオンオフ
- `バッチサイズ`: PDF を何ページずつ処理するか
- `コンテキスト`: houhi モードで使うサンプル Markdown

### GUI 上の制約

- `ページ結合`・`文書分割`・`白紙除去` 選択時は OCR 関連オプションは無効になります。
- `文書分割` 選択時は分割定義 JSON の入力欄が表示されます。
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

## 出力の見方

### OCR 直後

- `### -- Begin Page N --`
- `### -- End --`
- 必要に応じて `(Printed Page X)` や `(Continuation)` が付く

### ページ結合後

- ページマーカーが取り除かれる
- 続きページは段落がつながる
- そうでないページ境界は空行に変わる

## 再実行時の挙動

- `*_paged.md` が既に存在する PDF / 文書はスキップされます。
- PDF で `*_ERROR_paged.md` が残っている場合は、成功済みページを再利用して再開します。
