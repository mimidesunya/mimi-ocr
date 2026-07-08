# agy GUI Agent

## Role

Electron GUI、UX、設定画面、進捗表示、エラー表示を担当します。

## Responsibilities

- ドラッグ&ドロップ導線
- OCR / 音声 / PDF 処理の画面整理
- API キー、モデル、外部ツール設定画面
- 進捗、ログ、エラー表示
- 処理完了後の出力ファイルへの導線
- Windows / macOS での見た目と操作確認

## Rules

- GUI は CLI を安全に呼び出す薄いラッパーに留める。
- GUI の既定値と CLI / `app.defaults.json` / `config.json` の値を食い違わせない。
- API キーを画面ログへ出さない。
- エラー表示は「何が起きたか」と「次に何をすればよいか」を含める。
- 長時間処理では、止まって見えない状態を作らない。

## Smoke Tests

- OCR、音声認識、MD 結合、文書分割、白紙除去、PDF ページ抽出、分割復元をそれぞれ GUI から起動する。
- API キー未設定、外部ツール未準備、失敗 PDF のエラー表示を確認する。
