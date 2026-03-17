# プロジェクト概要

## 目的

`mimi-ocr` は、日本語文書を Markdown に変換するためのOCR支援ツールです。単なる文字起こしではなく、ページ境界・見出し・段落構造を意識した Markdown を生成することを目的にしています。

## 対応入力

| 種別 | 拡張子 | 主な処理方式 |
| --- | --- | --- |
| PDF | `.pdf` | AI OCR、埋め込みテキスト抽出、`ndlocr-lite` 連携 |
| Word | `.docx` | XML と埋め込み画像をAIに渡してMarkdown化 |
| Word 97-2003 | `.doc` | 抽出テキストをAIで整形 |
| OpenDocument | `.odt` | XML と画像をAIに渡してMarkdown化 |
| PowerPoint | `.pptx` | スライドXML・ノート・画像をAIに渡してMarkdown化 |

## 主要機能

### 1. OCR（一般）

- 一般文書向けの Markdown 形式で出力します。
- 見出し、段落、表、ページ区切りをできるだけ保ちながら Markdown 化します。

### 2. OCR（法匪）

- 裁判文書向けの出力スタイルを想定しています。
- 内蔵テンプレート `src/templates/houhi_sample.md` を既定で使い、必要なら別のサンプル Markdown を指定できます。

### 3. ページ結合

- `*_paged.md` に含まれるページマーカーを除去または結合します。
- `(Continuation)` マーカーの有無を見て、段落をつなぐか空行を挿入するかを切り替えます。

### 4. 文書分割

- OCR 済みの `_paged.md` と PDF を、JSON 定義に基づいて文書ごとに分割します。
- 分割後のページ番号は 1 からリナンバリングされます。
- 分割定義がドキュメント全体を網羅していない場合は警告が表示されます。

### 5. ブランクページ除去

- OCR 結果を解析し、白紙ページを除いた PDF と MD のペアを生成します。
- 本文が閾値（デフォルト 10 文字）以下のページを白紙と判定します。

## 出力ルール

### PDF

- 成功時: `元ファイル名_paged.md`
- 一部失敗時: `元ファイル名_ERROR_paged.md`
- 既に `元ファイル名_paged.md` がある場合はスキップします

### Word / ODT / PowerPoint

- 成功時: 対応する `元ファイル名_paged.md`

### ページ結合後

- `*_paged.md` から `*_merged.md` を作成します

## 利用インターフェース

- CLI: `npm run ocr`, `npm run merge`, `npm run split`, `npm run deblank`
- GUI: `npm run gui`
- Windowsランチャー: `npm run build:launcher` で `bin/mimi-ocr.exe` を生成

## 想定ワークフロー

1. `config.json` を用意する
2. GUI か CLI で OCR を実行する
3. `*_paged.md` を確認する
4. 必要なら `merge` を実行して `*_merged.md` を作る
5. 必要なら `split` で文書ごとに分割する
6. 必要なら `deblank` で白紙ページを除去する
7. 結果を手直しして最終原稿にする
