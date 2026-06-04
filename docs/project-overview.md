# プロジェクト概要

## 目的

MIMI OCR は、日本語文書を Markdown に変換するためのOCR支援ツールです。単なる文字起こしではなく、ページ境界・見出し・段落構造を意識した Markdown を生成することを目的にしています。

## 対応入力

| 種別 | 拡張子 | 主な処理方式 |
| --- | --- | --- |
| PDF | `.pdf` | AI OCR、埋め込みテキスト抽出、`ndlocr-lite` 連携 |
| Word | `.docx` | XML と埋め込み画像をAIに渡してMarkdown化 |
| Word 97-2003 | `.doc` | 抽出テキストをAIで整形 |
| OpenDocument | `.odt` | XML と画像をAIに渡してMarkdown化 |
| PowerPoint | `.pptx` | スライドXML・ノート・画像をAIに渡してMarkdown化 |
| 音声 | `.mp3`, `.m4a`, `.wav`, `.webm` など | OpenAI / Gemini で発言者分離つきMarkdown化 |

## 主要機能

### 1. OCR

- 一般文書向け、または法匪書式の Markdown 形式で出力します。
- 見出し、段落、表、ページ区切りをできるだけ保ちながら Markdown 化します。

### 2. OCR 出力スタイル

- GUI では OCR ボタンを1つにし、オプションで `一般` / `法匪` を切り替えます。
- `法匪` 選択時は裁判文書向けの出力スタイルを使います。
- 内蔵テンプレート `src/templates/houhi_sample.md` を既定で使い、必要なら別のサンプル Markdown を指定できます。

### 3. 音声認識

- 音声ファイルを発言者分離つきで Markdown 化します。
- GUI では他ツールと同列の `音声認識` ボタンから実行できます。
- `一般` では音声認識結果、`法匪` では反訳書 Markdown として出力します。

### 4. ページ結合

- `*_paged.md` に含まれるページマーカーを除去または結合します。
- `(Continuation)` マーカーの有無を見て、段落をつなぐか空行を挿入するかを切り替えます。

### 5. 文書分割

- OCR 済みの `_paged.md` と PDF を、JSON 定義に基づいて文書ごとに分割します。
- 分割後のページ番号は 1 からリナンバリングされます。
- 分割定義がドキュメント全体を網羅していない場合は警告が表示されます。

### 6. ブランクページ除去

- OCR 結果を解析し、白紙ページを除いた PDF と MD のペアを生成します。
- 本文が閾値（デフォルト 10 文字）以下のページを白紙と判定します。

### 7. PDFページ抽出・結合

- PDF と同じ場所にある OCR 結果を使い、PDFページまたは印刷ページでページを指定できます。
- `1-3,7,8` のような範囲指定に対応します。
- 複数PDFから抽出したページを、指定順に1つのPDFと1つのMarkdownへ結合できます。
- 抽出後のMarkdownでは、`### -- Begin Page N --` を1から連番に振り直します。
- 1ページに2面割り付ける出力に対応し、左から右・右から左の両方向を選べます。

## 出力ルール

### PDF

- 成功時: `元ファイル名_paged.md`
- 一部失敗時: `元ファイル名_ERROR_paged.md`
- 既に `元ファイル名_paged.md` がある場合はスキップします
- Markdown 末尾に不可視な実行設定メタデータを付与します

### Word / ODT / PowerPoint

- 成功時: 対応する `元ファイル名_paged.md`
- Markdown 末尾に不可視な実行設定メタデータを付与します

### ページ結合後

- `*_paged.md` から `*_merged.md` を作成します

### PDFページ抽出・結合後

- 単一PDFの通常抽出: `元ファイル名_pages.pdf` / `元ファイル名_pages.md`
- 複数PDFの結合: `先頭PDF名_combined_pages.pdf` / `先頭PDF名_combined_pages.md`
- 2面割付時: `_2up` が付きます

### 実行設定メタデータ

OCR 直後の Markdown 末尾には、`<!-- mimi-ocr-settings ... -->` 形式の HTMLコメントが付きます。内容はビルド番号、生成日時、入力ファイル名、入力種別、ターゲット、AIプロバイダー、モデル、処理モード、ページ範囲、`ndlocr` 利用状態などです。APIキーは含めません。

## 利用インターフェース

- CLI: `npm run ocr`, `npm run merge`, `npm run split`, `npm run deblank`, `npm run pdf-pages`
- GUI: `npm run gui`
- Windowsランチャー: `platforms/windows/launcher/`。`npm run build:launcher` で `bin/mimi-ocr.exe` を生成

## 想定ワークフロー

1. `config.json` を用意する
2. GUI か CLI で OCR を実行する
3. `*_paged.md` を確認する
4. 必要なら `merge` を実行して `*_merged.md` を作る
5. 必要なら `split` で文書ごとに分割する
6. 必要なら `deblank` で白紙ページを除去する
7. 必要なら `pdf-pages` でPDFページを抽出・結合・2面割付する
8. 結果を手直しして最終原稿にする
