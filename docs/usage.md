# 使い方

## GUI の基本操作

### 利用できるツール

- `OCR`: 一般文書向け、またはオプションで法匪書式の Markdown を生成
- `音声認識`: 音声ファイルを発言者分離つき Markdown または法匪向け反訳書に変換
- `MD結合`: `*_paged.md` のページ境界を整理
- `文書分割`: JSON 定義に基づいて `_paged.md` と PDF を文書ごとに分割
- `白紙除去`: OCR 結果をもとに白紙ページを除去した PDF + MD ペアを生成
- `分割復元`: 分割スキャンPDFを重なり検出で結合
- `PDF抽出`: OCR 結果をもとに PDF ページを抽出・結合・2面割付

### 画面オプション

- `OCR`: `AIのみ` / `ndlocr+AI` / `ndlocr-only`
- `出力`: OCRまたは音声認識の `一般` / `法匪`
- `音声AI`: `OpenAI diarize` / `Gemini 3.5` / `Reazon K2+AI`
- `AI`: `Gemini` / `Claude` / `OpenAI`
- `Mode`: `バッチ` / `同期`
- `PDFテキスト`: 埋め込みテキスト優先のオンオフ
- `バッチサイズ`: OCRではPDFを何ページずつ処理するか、音声認識では何ファイルずつ並列処理するか
- `自動改名`: 変更前のファイル名と内容を併せて判断し、OCRでは入力ファイル名、音声認識では音声ファイル本体と出力Markdown名を自動生成します
- `コンテキスト`: OCRまたは音声認識前に登場人物、役職、固有名詞、専門用語などを補助情報として渡します
- `PDF抽出` 選択時は、ページ指定、PDFページ/印刷ページ、2面割付、ページ方向を指定できます。

### GUI 上の制約

- ツールカードへ直接ファイルをドロップすると、そのツールに切り替わって処理します。
- `MD結合`・`文書分割`・`白紙除去` 選択時は OCR / 音声認識 関連オプションは無効になります。
- `文書分割` 選択時は分割定義 JSON の入力欄が表示されます。
- `分割復元` 選択時は、既定の自動判定のまま実行できます。必要な場合だけ分割枚数とDPIを指定できます。
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

### 音声認識

```powershell
npm run transcribe -- .\samples\meeting.m4a --target=houhi --provider=openai --model=gpt-4o-transcribe-diarize
npm run transcribe -- .\samples\meeting.wav --target=general --provider=gemini --model=gemini-3.5-flash
npm run transcribe -- .\samples\meeting.wav --provider=reazon-k2 --postprocess-ai=gemini
npm run transcribe -- .\samples\meeting.wav --provider=reazon-k2 --postprocess-ai=off
npm run transcribe -- .\samples\a.m4a .\samples\b.m4a --mode=batch --batch_size=2 --auto_rename
npm run transcribe -- .\samples\meeting.m4a --context-text "登場人物: 田中、佐藤。会社名: ミミデスニャ株式会社。"
npm run transcribe -- .\samples\meeting.m4a --trim_silence
```

`--mode=batch` は複数の音声ファイルを `--batch_size` ごとに並列処理します。`--auto_rename` を付けると、変更前のファイル名と文字起こし内容を併せて `YYYY-MM-DD_反訳書_表題` または `YYYY-MM-DD_音声認識_表題` の stem を作り、音声ファイル本体とMarkdownを同名に揃えます。元ファイル名の日付や件名は候補として扱い、内容と矛盾する場合は内容を優先します。付けない場合は元音声ファイル名ベースです。
`--provider=reazon-k2` は ReazonSpeech K2 / sherpa-onnx をローカル実行します。既定では ffmpeg で短い 16kHz mono WAV チャンクへ分割してから認識し、`--postprocess-ai=auto|gemini|openai|off` でAI後処理の有無を選びます。AI後処理ではローカルASR結果を発言単位JSONへ整え、既存の Markdown / 反訳書生成へ渡します。

AIを使用する処理では、実行開始時またはAI呼び出し時にプロバイダー名と実効モデル名をコンソールへ表示します。`ndlocr-only` などAIを使わない処理では「AI: 使用しない」と表示します。
音声認識は既存の Markdown がある場合、OCRと同様にAPI処理をスキップします。`--auto_rename` を付けた場合は、既存 Markdown の内容を使って音声ファイル本体と Markdown の改名だけを行います。
このため、文字起こし済みの音声は再度APIへ送らず、必要な場合だけファイル名整理を後から実行できます。
`--trim_silence` を付けると、ffmpeg で無音区間をカットしてからAIへ渡します。カット後の時刻は元音声上の時刻へ補正し、Markdown末尾の設定コメントに無音カット設定と削除区間の要約を記録します。
法匪の音声認識では、事前コンテキストで具体名を指定しない場合でも、発言内容から推定できる範囲で `原告`、`被告`、`控訴人`、`被控訴人`、`裁判官`、`証人`、各代理人などの訴訟上の立場を話者ラベルに使います。

## OCR オプション一覧

| オプション | 説明 |
| --- | --- |
| `--target houhi\|general` | 出力スタイルを切り替える |
| `--context-file <path>` | houhi モード用のサンプル Markdown を指定する |
| `--context-text <text>` | 登場人物、役職、固有名詞などをOCR補助テキストとして渡す |
| `--context-file-text <path>` | OCR補助テキストをファイルから読み込む |
| `--batch_size <n>` | PDF の処理単位ページ数 |
| `--start_page <n>` | 開始ページ |
| `--end_page <n>` | 終了ページ |
| `--show_prompt` | OCRプロンプトを表示して終了する |
| `--ai gemini\|claude\|openai` | AI プロバイダーを選ぶ |
| `--mode batch\|sync` | バッチ処理か同期処理かを選ぶ |
| `--ndlocr` | `ndlocr-lite` を前処理として使う |
| `--ndlocr_only` | AI を使わず `ndlocr-lite` のみで処理する |
| `--prefer_pdf_text` | 埋め込みテキストがある PDF では OCR よりそちらを優先する |

## 音声認識 オプション一覧

| オプション | 説明 |
| --- | --- |
| `--target houhi\|general` | 反訳書形式か一般形式を切り替える |
| `--provider openai\|gemini\|reazon-k2` | 音声認識プロバイダーを選ぶ |
| `--model <model>` | `gpt-4o-transcribe-diarize`、`gemini-3.5-flash`、Reazonの `ja` など |
| `--mode sync\|batch` | 逐次処理か、複数ファイルのバッチ並列処理かを選ぶ |
| `--batch_size <n>` | バッチ並列処理時に同時処理する音声ファイル数 |
| `--auto_rename` | 内容から音声ファイル本体と出力Markdown名を自動生成する |
| `--no_auto_rename` | 元音声ファイル名ベースで出力する |
| `--skip_formatted_rename` | 既に自動改名形式の音声ファイルは再判定せずスキップする |
| `--no_skip_formatted_rename` | 既に自動改名形式でも再判定する |
| `--context-text <text>` | 登場人物、役職、固有名詞などを補助テキストとして渡す |
| `--context-file <path>` | 補助テキストをファイルから読み込む |
| `--trim_silence` | 無音区間をカットしてからAIへ渡す |
| `--no_trim_silence` | 無音カットを無効にする |
| `--silence_threshold_db <n>` | 無音判定のしきい値 dB |
| `--min_silence_sec <n>` | 無音とみなす最短秒数 |
| `--silence_padding_sec <n>` | カット時に前後へ残す余白秒数 |
| `--postprocess-ai auto\|gemini\|openai\|off` | Reazon K2 の生起こしをAIで整形するか |
| `--reazon-language ja\|ja-en\|ja-en-mls-5k` | Reazon K2 のモデル言語 |
| `--reazon-device cpu\|cuda\|coreml` | Reazon K2 / sherpa-onnx の実行デバイス |
| `--reazon-precision fp32\|int8\|int8-fp32` | Reazon K2 のモデル精度 |
| `--reazon-chunk-sec <n>` | Reazon K2 に渡す音声チャンク秒数。既定は `25` |

GUIの選択状態は自動保存され、次回起動時に前回のツール、AI、モード、コンテキスト、無音カットなどの状態を復元します。

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

### 分割スキャンPDFのページ復元

A4スキャナで分割スキャンしたB4/A3、A3スキャナで分割スキャンしたA2などのページを、内蔵の位置合わせエンジンで1ページへ復元します。外部ツールのインストールは不要です。位相相関による重なり検出で、どの入力ページが同じ実ページに属するか（および180度回転の有無）を自動判定し、重なり領域のパッチマッチングで平行移動と微小回転を推定します。合成は両画像の差が最小になる縫い目で片方の画像へ切り替える方式のため、二重像（ゴースト）が出ません。必要な場合は `--group-size` で固定枚数を指定できます。

```powershell
npm run stitch -- .\samples\b4_split_scan.pdf
npm run stitch -- .\samples\b4_split_scan.pdf --group-size 2 --dpi 300
npm run stitch -- .\samples\b4_split_scan.pdf --group-size 3
npm run stitch -- .\samples\b4_split_scan.pdf --group-size 2 --keep-temp
npm run stitch -- .\samples\b4_split_scan.pdf --deskew off
npm run stitch -- .\samples\b4_split_scan.pdf --jpeg-quality 0.9
```

主なオプション:

| オプション | 説明 |
| --- | --- |
| `--group-size auto\|<n>` | 何ページを1ページへ復元するか。既定は `auto`、重なり検出でページ組を自動判定します |
| `--dpi auto\|<n>` | PDFを画像化するDPI。既定は `auto`、現在は出力用に300dpiを使います |
| `--deskew auto\|off` | 合成前後に水平/垂直特徴から小角度の傾きを補正します。既定は `auto` |
| `--pdf-image-format jpeg\|png` | 復元PDF内の画像形式。既定は `jpeg` |
| `--jpeg-quality <0.1-1.0>` | JPEG品質。既定は `0.86` |
| `--keep-temp` | 中間PNGを残す |

位置合わせでは、スキャン間の明るさの差も重なり領域の輝度から自動補正します。各画像に共通して写っている重なり領域が必要です。重なりがほとんどない隣接画像は自動判定できないため、分割スキャン時は数センチ重ねて読み取ってください。完成ページの向き補正は行いません。出力PDFは既定でJPEG画像を埋め込み、肥大化を抑えます。出力は `*_stitched.pdf` と `*_stitch_report.json` です。

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
    "ndlocr": "pre"
  }
}
-->
```

`preferPdfText`、`hasError`、`ndlocrSettings` は該当する場合だけ出力されます。APIキーは記録されません。

## 再実行時の挙動

- `*_paged.md` が既に存在する PDF / 文書はスキップされます。
- PDF で `*_ERROR_paged.md` が残っている場合は、成功済みページを再利用して再開します。
