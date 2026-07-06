# MIMI OCR 0.1.0-alpha.1

初回の Windows alpha リリースです。

## 配布物

- `mimi-ocr-win-x64-0.1.0-alpha.1-<timestamp>.zip`

## 主な内容

- Node.js / npm が入っていない Windows でも起動できるリリースパッケージを追加
- 同梱 Electron と同梱 Node ランタイムを使った GUI / OCR 子プロセス起動に対応
- `canvas` native module をリリースビルド時に rebuild し、PDF 画像化と `ndlocr-lite` 実行前処理を安定化
- `ndlocr-lite` を初回利用時にアプリ標準の保存先へ自動取得
- 壊れた Python venv の検出と作り直しに対応
- Gemini API キー未設定時に GUI からセットアップ案内を表示
- 配布版の既定 OCR を `ndlocr+AI` に変更
- ファイル名の自動変更は既定 Off

## 利用時の注意

- Gemini / Claude / OpenAI を使う処理には、それぞれの API キー設定が必要です。
- `ndlocr-lite` を使う場合は Python 3.10 以上が必要です。Node.js / npm は不要です。
- 初回の `ndlocr-lite` セットアップでは GitHub と pip への通信が発生します。
