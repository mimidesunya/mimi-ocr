# アーキテクチャ

## 全体像

このプロジェクトは、TypeScript で実装された OCR / 文書変換ロジックを中心に、Electron GUI と .NET ランチャーを組み合わせた構成です。

## 主要コンポーネント

| ファイル | 役割 |
| --- | --- |
| `src/ocr.ts` | OCR CLI の入口。引数解釈、対象分類、各形式の処理開始 |
| `src/merge_pages.ts` | `*_paged.md` を `*_merged.md` に整形 |
| `src/split_pages.ts` | JSON 定義に基づいて `_paged.md` + PDF を文書ごとに分割 |
| `src/remove_blank_pages.ts` | OCR 結果を解析し白紙ページを除去した PDF + MD を生成 |
| `src/pdf_pages.ts` | OCR 結果に基づく PDF ページ抽出・結合・2面割付 |
| `src/lib/ai_ocr.ts` | 文書形式ごとの本体ロジック。再開、検証、保存を管理 |
| `src/lib/gemini_batch.ts` | Gemini の同期・インラインバッチ・ファイルバッチ処理 |
| `src/lib/openai_client.ts` | OpenAI の同期処理と Batch API 連携 |
| `src/lib/claude_client.ts` | Claude SDK 連携 |
| `src/lib/pdf_to_image.ts` | PDF を PNG にレンダリング |
| `src/lib/ndlocr_runner.ts` | `ndlocr-lite` を子プロセス実行 |
| `scripts/write_build_info.js` | ビルド時に `dist/src/lib/build_info.json` を生成 |
| `src/gui/main.ts` | Electron メインプロセス。GUI からCLIを起動 |
| `src/gui/renderer.ts` | フロントエンドの状態管理とイベント処理 |
| `src/launcher/Launcher.cs` | Windows 用ランチャー。`npm run gui` を起動 |

## PDF 処理フロー

1. `src/ocr.ts` が PDF を検出して `pdfToText()` を呼ぶ
2. `src/lib/ai_ocr.ts` がページ範囲、既存 `_ERROR_paged.md`、既存 `_paged.md` を確認する
3. 必要に応じて以下を組み合わせる
   - 埋め込みテキスト抽出
   - `ndlocr-lite` による前処理
   - AI OCR
4. AI の返却Markdownに対してページマーカー数を検証する
5. 成功ページを `pageMap` に蓄積する
6. Markdown 末尾に実行設定メタデータを付与する
7. 全成功なら `*_paged.md`、失敗が残れば `*_ERROR_paged.md` を出力する

## 非PDF処理フロー

### `.docx`

- `word/document.xml` と `word/media/*` を取り出して1リクエストで送信します。

### `.doc`

- `word-extractor` で本文テキストを抽出し、Markdown 整形をAIに依頼します。

### `.odt`

- `content.xml`、`styles.xml`、`Pictures/*` をまとめて送信します。

### `.pptx`

- スライドXML、ノートXML、画像を番号順に集めて送信します。

## AI プロバイダー差分

| プロバイダー | 同期 | バッチ | PDF の扱い |
| --- | --- | --- | --- |
| Gemini | 対応 | インライン / ファイルバッチ対応 | PDF をそのまま送る経路あり |
| Claude | 対応 | 専用バッチなし | PDF を base64 document として送る |
| OpenAI | 対応 | Files API + Batches API | 内部で PDF を PNG 群に変換して送る |

## GUI 実行モデル

1. Electron GUI でユーザーがオプションを選ぶ
2. `src/gui/main.ts` が CLI 引数を組み立てる
3. `node <script>` を子プロセスとして起動する
4. 標準出力・標準エラーを専用コンソールウィンドウへ転送する

GUI は OCR ロジックを直接持たず、CLI を安全に包む薄いラッパーです。

## ビルド情報

`npm run build` は `tsc` 実行後に `scripts/write_build_info.js` を呼び、`dist/src/lib/build_info.json` を生成します。`number` は `YYMMDD-HHmmss` 形式の短いビルド番号です。OCR結果 Markdown の末尾メタデータでは、この値を `build` として記録します。

ビルド情報ファイルがない開発中の直接実行では、`build` は `dev` になります。

## OCRメタデータ

`src/lib/ai_ocr.ts` は OCR 結果を書き出す直前に、Markdown 末尾へ `<!-- mimi-ocr-settings ... -->` を追加します。記録対象はビルド番号、生成日時、入力ファイル名、入力種別、ターゲット、AIプロバイダー、モデル、処理モード、ページ範囲、`ndlocr` 利用状態などです。

APIキー、トークン、絶対パス全体は記録しません。入力ファイルやコンテキストファイルはベース名だけを残します。

GUI のツール一覧:

| ツール | スクリプト | 説明 |
| --- | --- | --- |
| OCR（一般） | `src/ocr.js` | 一般文書の OCR 処理 |
| OCR（法匪） | `src/ocr.js` | 裁判文書を法匪書式で OCR 処理 |
| ページ結合 | `src/merge_pages.js` | ページマーカーの除去・結合 |
| 文書分割 | `src/split_pages.js` | JSON 定義に基づく文書分割 |
| 白紙除去 | `src/remove_blank_pages.js` | 白紙ページ除去した PDF + MD 生成 |
| PDF抽出 | `src/pdf_pages.js` | PDFページ抽出・結合・2面割付 |

## リトライ

すべての AI プロバイダーの同期モードにリトライ機能があります。

| プロバイダー | 同期リトライ | バッチリトライ |
| --- | --- | --- |
| Gemini | 最大 3 回 + 指数バックオフ | `MAX_RETRIES` による未完了バッチ再送 |
| Claude | 最大 3 回 + 指数バックオフ（SDK 内部リトライとは別） | ― |
| OpenAI | 最大 `maxRetries` 回 + 指数バックオフ | ― |

## 再開と永続化

- PDF の途中結果は `*_ERROR_paged.md` から再開できます。
- Gemini / OpenAI のバッチジョブは `*.batch_state.txt` を使ってレジュームを試みます。
- 正常完了時はバッチ状態ファイルを削除します。

## マージ処理

`src/merge_pages.ts` は `### -- Begin Page ... --` と `### -- End ... --` を解釈し、`(Continuation)` があれば段落連結、なければ空行に変換します。加えて、印字ページ番号と物理ページ番号の整合性チェックも行います。

## PDFページ抽出・結合

`src/pdf_pages.ts` は PDF と同じ場所にある `*_paged.md` または `*_ERROR_paged.md` を必須入力として使います。OCR結果から `### -- Begin Page N --` と `(Printed Page X)` を読み、PDFページ指定または印刷ページ指定をPDFページ番号へ解決します。

抽出対象は `1-3,7,8` のような範囲指定で受け取ります。複数PDFを渡した場合は、各PDFから解決したページを指定順に1つのPDFへコピーし、OCR結果の該当Markdownブロックも同じ順番で1つのMDへ結合します。結合後のMDでは `### -- Begin Page N --` を1から連番に振り直します。

`--two-up` 指定時は `pdf-lib` の `embedPage()` を使い、1ページ上に2ページ分を左右に縮小配置します。対応MDは抽出対象の論理ページ単位で保持し、同じく連番に振り直します。
