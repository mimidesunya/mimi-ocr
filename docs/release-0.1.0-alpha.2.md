# MIMI OCR 0.1.0-alpha.2

Windows alpha の第2版です。音声認識の選択肢、AIモデル設定の可視性、配布環境での復旧性を改善しました。

## 配布物

- `mimi-ocr-win-x64-0.1.0-alpha.2-<timestamp>.zip`

## 主な変更

- ReazonSpeech K2 / sherpa-onnx によるローカル音声認識を追加
- Reazon K2 の結果を Gemini または OpenAI で話者・句読点・反訳書形式へ整えるAI後処理を追加
- 音声の長さとファイルサイズに応じた分割、無音カット、話者別Markdown、反訳書出力を改善
- OCRと音声認識の実行時に、使用するAIプロバイダーと実効モデル名をCLI・GUIへ表示
- `ndlocr-only` などAIを使わない処理では「AI: 使用しない」と表示
- 自動改名で変更前のファイル名を日付・件名候補として考慮
- `ndlocr-lite` が利用できない場合に、利用者の指定なくAI OCRへ切り替わらないよう変更
- `ndlocr-only` のページ境界を文書分割、白紙除去、PDFページ抽出、Markdown結合で利用可能に修正
- 配布環境からGemini OCRを実行するための案内を追加
- Windows 配布物の同梱 Node.js を v24.18.0 LTS に更新
- ZIP処理などの本番依存パッケージを更新し、既知の監査警告を解消

## 標準AIモデル

- Gemini OCR / 文書処理: `gemini-3.5-flash-lite`
- Gemini 音声認識: `gemini-3.6-flash`
- OpenAI OCR / 文書処理: `gpt-5.6`
- OpenAI 音声認識: `gpt-4o-transcribe-diarize`
- Claude OCR / 文書処理: `claude-opus-4-8`

既存の `config.json` にモデル名の上書きがある場合は、その設定が引き続き優先されます。

## 互換性とアップグレード

- `*_paged.md`、`*_ERROR_paged.md`、`*_merged.md` のファイル名とページ境界形式は維持しています。
- 旧版のZIPへ上書きせず、新しいフォルダへ展開して `mimi-ocr.exe` を起動してください。
- APIキーやモデル上書きはGUIの「設定」から確認してください。
- Reazon K2 を初めて使う場合は、Python環境とモデルの準備でネットワーク通信と時間が必要です。

## 既知の制限

- この配布物は Windows x64 用です。macOS向け配布物は含みません。
- Gemini / Claude / OpenAI を使う処理には各サービスのAPIキーが必要です。
- `ndlocr-lite` と Reazon K2 の初回準備には外部ネットワーク接続が必要です。
- 裁判資料など重要文書では、証拠番号、日付、固有名詞、ページ境界を原本と照合してください。
