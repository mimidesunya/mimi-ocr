# MIMI OCR

日本語文書を Markdown に変換する OCR ツールです。Electron GUI と CLI の両方に対応し、AI プロバイダーとして Gemini / Claude / OpenAI を利用できます。

PDF だけでなく、Word (`.docx` / `.doc`)、ODT、PowerPoint (`.pptx`) も処理できます。

## 主な機能

- PDF / Word / ODT / PowerPoint の Markdown 化
- 音声ファイルの発言者分離つき Markdown / 反訳書化
- Gemini / Claude / OpenAI の切り替え
- PDF での `ndlocr-lite` 併用
- OCR 後のページ結合 (`*_paged.md` -> `*_merged.md`)
- OCR 結果を使った PDF ページ抽出・結合・2面割付
- GUI / CLI での分割スキャンPDFページ復元
- OCR 結果末尾への不可視な実行設定メタデータ付与
- 先頭4ページと末尾4ページを使った AI 自動ファイル名変更
- OCR 結果に基づく文書分割（JSON 定義で複数ファイルに分割）
- OCR 結果に基づくブランクページ除去（白紙ページを除いた PDF + MD ペアを生成）
- 分割スキャンPDFのページ復元（重なり検出で複数スキャンを1ページへ結合）
- Windows / Mac 用ランチャーの生成

## 動作環境

- Windows x64 / macOS 推奨
- 開発環境: Node.js / npm と `npm install` が通るローカル環境
- Windows リリースパッケージ利用時: Node.js / npm は不要
- `ndlocr-lite` を使う場合は Python 3.10 以上（初回利用時にアプリ標準の保存先へ GitHub から自動取得）
- macOS で無音カットや音声変換を使う場合は ffmpeg（例: `brew install ffmpeg`）
- Windowsランチャーを小さく作る場合は MinGW-w64 の `gcc` / `windres`
- MinGW-w64 がない環境で Windows EXE ビルドを行う場合は .NET 10 SDK

## クイックスタート

### 1. 依存関係を入れる

```powershell
npm install
```

### 2. 設定ファイルを作る

```powershell
Copy-Item config.template.json config.json
```

GUI上部の「設定」から API キーとモデル名の上書きを設定できます。「APIキー」タブには、Gemini / OpenAI / Claude のキー取得手順もあります。アプリ標準値は `app.defaults.json` に入っています。

### 3. GUI を起動する

```powershell
npm run gui
```

ファイルをドラッグアンドドロップして OCR や音声認識を実行できます。

法匪モードは同梱テンプレートを使います。ndlocr-lite は未設定なら初回使用時にアプリ標準の保存先へ GitHub から自動準備します。ffmpeg は Windows では自動準備し、macOS では Homebrew などで入れたものを使います。

## Windows リリースパッケージ

開発環境で次を実行すると、Node.js / npm が入っていない Windows でも起動できるフォルダを `release/mimi-ocr-win-x64/` に作ります。

```powershell
npm run build:release:windows
```

配布時は `release/mimi-ocr-win-x64/` フォルダごと渡します。利用者は `mimi-ocr.exe` を起動します。

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

### 音声認識

```powershell
npm run transcribe -- .\meeting.m4a --target=houhi --provider=openai --model=gpt-4o-transcribe-diarize
npm run transcribe -- .\meeting.wav --target=general --provider=gemini --model=gemini-3.5-flash
npm run transcribe -- .\a.m4a .\b.m4a --mode=batch --batch_size=2 --auto_rename
npm run transcribe -- .\meeting.m4a --context-text "登場人物: 田中、佐藤。専門用語: 反訳書。"
npm run transcribe -- .\meeting.m4a --trim_silence
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

### 分割スキャンPDFのページ復元

A4スキャナで分割スキャンしたB4/A3、A3スキャナで分割スキャンしたA2などのページを、内蔵の位置合わせエンジンで1ページへ復元します。外部ツールのインストールは不要です。位相相関による重なり検出で、どの入力ページが同じ実ページに属するか（および180度回転の有無）を自動判定し、重なり領域のパッチマッチングで平行移動と微小回転を推定します。合成は両画像の差が最小になる縫い目で片方の画像へ切り替える方式のため、二重像（ゴースト）が出ません。必要な場合は `--group-size` で固定枚数を指定できます。

```powershell
npm run stitch -- .\sample.pdf
npm run stitch -- .\sample.pdf --group-size 2 --dpi 300
npm run stitch -- .\sample.pdf --group-size 3
npm run stitch -- .\sample.pdf --group-size 2 --output .\sample_b4.pdf
npm run stitch -- .\sample.pdf --deskew off
npm run stitch -- .\sample.pdf --jpeg-quality 0.9
```

既定では `--group-size auto --dpi auto --deskew auto --pdf-image-format jpeg --jpeg-quality 0.86` として、重なり検出でページ組を自動判定し、出力用DPIは300dpiを使います。合成前後に水平線・垂直線・文字列などの特徴から小角度の傾きを補正します。不要な場合は `--deskew off` で無効化できます。スキャン間の明るさの差も重なり領域から自動補正します。重なりがほとんどない隣接画像は自動判定できないため、分割スキャン時は数センチ重ねて読み取ってください。出力は `*_stitched.pdf` と `*_stitch_report.json` です。

### PDFページ抽出・結合

PDF と同じ場所にある OCR 結果（`*_paged.md` または `*_ERROR_paged.md`）を使って、PDFページまたは印刷ページを指定して抽出します。OCR結果がないPDFは処理できません。抽出後は PDF と同名の Markdown も出力し、Markdown 内の `### -- Begin Page N --` は抽出後の連番に振り直します。

```powershell
npm run pdf-pages -- --pages 1-3,7,8 .\sample.pdf
npm run pdf-pages -- --page-type printed --pages 10-12 .\sample.pdf
npm run pdf-pages -- --pages 1-3 .\a.pdf .\b.pdf
npm run pdf-pages -- ".\a.pdf::1-3" ".\b.pdf::7,8"
npm run pdf-pages -- --pages 1-8 --two-up --direction rtl .\sample.pdf
```

複数PDFを指定すると、抽出したページを指定順に1つのPDFへ結合し、対応するMarkdownも1つに結合します。`--two-up` を付けると1ページに2面割り付けます。`--direction ltr` は左から右、`--direction rtl` は右から左に配置します。

## よく使うオプション

| オプション | 説明 |
| --- | --- |
| `--target houhi\|general` | 出力スタイルを切り替える |
| `--context-file <path>` | houhi 用のサンプル Markdown を指定する |
| `--context-text <text>` | OCR用の補助コンテキストを指定する |
| `--ai gemini\|claude\|openai` | AI プロバイダーを選ぶ |
| `--mode batch\|sync` | バッチ処理か同期処理かを選ぶ |
| `--batch_size <n>` | PDF の処理ページ数を指定する |
| `--start_page <n>` | 開始ページを指定する |
| `--end_page <n>` | 終了ページを指定する |
| `--ndlocr` | `ndlocr-lite` を前処理として使う |
| `--ndlocr_only` | `ndlocr-lite` のみで処理する |
| `--prefer_pdf_text` | 埋め込みテキストを優先する |
| `--auto_rename` | AI による自動ファイル名変更を有効にする |

音声認識でも `--mode=batch` / `--batch_size` / `--auto_rename` を使えます。音声のバッチは複数ファイルの並列処理、自動改名は文字起こし内容から音声ファイル本体と出力Markdown名を同じ stem で作る機能です。
`--context-text` または `--context-file` で、登場人物や固有名詞などの事前コンテキストも渡せます。
既存の音声認識 Markdown がある場合はAPI処理をスキップし、`--auto_rename` 指定時は既存 Markdown を使って音声ファイル本体と Markdown の改名だけを行います。
この既存出力スキップと改名のみ実行は、OCRの既存 `_paged.md` スキップと同じ考え方です。
`--trim_silence` を付けると、クライアント側で ffmpeg により無音区間をカットしてからAIへ渡します。出力時刻は元音声上の時刻へ補正され、Markdown末尾の不可視コメントに無音カット設定と削除区間の要約を残します。

## 出力ファイル

| ファイル | 説明 |
| --- | --- |
| `*_paged.md` | OCR 直後のページ境界付き Markdown |
| `*_ERROR_paged.md` | 一部失敗を含む途中結果 |
| `*_merged.md` | ページ結合後の Markdown |
| `*_noblank.pdf` / `*_noblank_paged.md` | ブランクページ除去後の PDF / MD |
| `*_stitched.pdf` / `*_stitch_report.json` | 分割スキャン復元後の PDF / 位置合わせレポート |
| `*_pages.pdf` / `*_pages.md` | PDFページ抽出後の PDF / MD |
| `*_combined_pages.pdf` / `*_combined_pages.md` | 複数PDFから抽出・結合した PDF / MD |
| `*_pages_2up.pdf` / `*_pages_2up.md` | 2面割付した PDF / 対応MD |
| `*_combined_pages_2up.pdf` / `*_combined_pages_2up.md` | 複数PDFから抽出・結合して2面割付した PDF / 対応MD |

OCR 直後の Markdown 末尾には、HTMLコメントとして設定メタデータが付与されます。通常の Markdown 表示では見えませんが、ソースを開くとビルド番号、入力ファイル名、AIプロバイダー、モデル、ページ範囲などを確認できます。APIキーは含めません。

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

## 自動ファイル名変更

デフォルトでは Off です。必要な場合だけ `--auto_rename` を付けると、OCR結果の先頭4ページと末尾4ページから内容を判定し、元文書を次の形式に自動変更します。

```text
一般: YYYY-MM-DD_文書種類_タイトル
法匪: YYYY-MM-DD_表題
法匪の証拠: 甲1 YYYY-MM-DD_表題
```

## リトライ

すべての AI プロバイダーの同期モードにリトライ機能があります（デフォルト最大 3 回、指数バックオフ）。バッチモード（Gemini）も失敗バッチを自動リトライします。

- 既にこの形式のファイル名なら変更しません
- OCR 結果ファイルが既に存在する場合でも動作します
- 文書種類は固定候補から選びます
- 法匪モードでは文書種類をファイル名に入れません
- 日付がまったく不明な場合は実行日を使います
- 同名ファイルが既にある場合は ` (2)`, ` (3)` ... の連番を末尾に付けて回避します
- GUI でも初期設定は Off です
- `--no_auto_rename` も後方互換のため引き続き受け付けます

## ビルド番号

通常の `npm run build` では、実行用の `dist/src/lib/build_info.json` も生成されます。このファイルの短いタイムスタンプ形式の `number` が、OCR結果末尾の `build` に記録されます。

## ランチャーの生成

```powershell
npm run build:launcher
```

実行した OS に応じて生成します。

生成物:

- `bin/mimi-ocr.exe`
- `bin/MIMI OCR.app`

Windows だけを明示的に作る場合は `npm run build:launcher:windows`、Mac だけを作る場合は `npm run build:launcher:mac` を使います。

ランチャーは `npm run gui` を起動する小型の起動用ファイルです。Windows ランチャー EXE にはアイコンを設定済みです。Windows固有のランチャーソースは `platforms/windows/launcher/` にあります。MinGW-w64 がある場合は小さい Win32 ネイティブ版を生成し、ない場合は .NET 版にフォールバックします。Mac 用は `platforms/macos/build_launcher.js` から `.app` バンドルを生成します。

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
