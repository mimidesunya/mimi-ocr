# RELEASE_CHECKLIST.md

## Build

- [ ] npm install
- [ ] npm run build
- [ ] npm run gui
- [ ] npm run build:launcher
- [ ] npm run build:release:windows

## CLI Smoke Test

- [ ] npm run ocr -- .\tests\fixtures\pdf\sample.pdf
- [ ] npm run ocr -- .\tests\fixtures\pdf\sample.pdf --ndlocr
- [ ] npm run ocr -- .\tests\fixtures\pdf\sample.pdf --ndlocr_only
- [ ] npm run ocr -- .\tests\fixtures\pdf\sample.pdf --ai gemini
- [ ] npm run ocr -- .\tests\fixtures\pdf\sample.pdf --ai claude
- [ ] npm run ocr -- .\tests\fixtures\pdf\sample.pdf --ai openai
- [ ] npm run merge -- .\tests\golden\ocr\sample_paged.md
- [ ] npm run split -- .\tests\fixtures\pdf\sample.pdf --json-file .\tests\fixtures\split\sample_split.json
- [ ] npm run deblank -- .\tests\fixtures\pdf\sample.pdf
- [ ] npm run stitch -- .\tests\fixtures\scanned\split_scan.pdf
- [ ] npm run pdf-pages -- --pages 1-2 .\tests\fixtures\pdf\sample.pdf
- [ ] npm run transcribe -- .\tests\fixtures\audio\meeting.m4a
- [ ] npm run transcribe -- .\tests\fixtures\audio\meeting.wav --provider=reazon-k2 --postprocess-ai=off
- [ ] npm run transcribe -- .\tests\fixtures\audio\meeting.wav --provider=reazon-k2 --postprocess-ai=gemini

## GUI Smoke Test

- [ ] GUI から OCR を実行
- [ ] GUI から音声認識を実行
- [ ] GUI から MD 結合を実行
- [ ] GUI から文書分割を実行
- [ ] GUI から白紙除去を実行
- [ ] GUI から PDF ページ抽出を実行
- [ ] GUI から分割スキャン復元を実行
- [ ] API キー未設定時の表示を確認
- [ ] 外部ツール未準備時の表示を確認

## External Tools

- [ ] Windows で ffmpeg 自動取得
- [ ] macOS で ffmpeg 未導入時の案内
- [ ] `ndlocr-lite` 初回準備（空の外部ツール保存先で既定の 1.4.0 が GitHub から `ndlocr-lite-venv` に入り、モデルを `%LOCALAPPDATA%\ndlocr-lite\models\v1.2` へ取り、`--ndlocr_only` で読める）
- [ ] `tools.ndlocrLite.version` を `2` にすると PyPI の 2.x へ入れ替わり（モデルは `models\v2`）、戻すと 1.4.0 に入れ替わる
- [ ] Python 3.11 以上が無い PC での `ndlocr-lite` 初回準備（uv が `uv`、Python 3.12 が `uv-python` に入る。`MIMI_TOOLS_IGNORE_SYSTEM_PYTHON=1` で PC の Python を探さずに試せる）
- [ ] 前の版で GitHub 版の `ndlocr-lite` を取った外部ツール保存先から pip 版へ移る（依存パッケージを取り直さず、モデルは写す）
- [ ] uv の版を上げたときは、`tool_resolver.ts` の `UV_RELEASE_ASSETS` の sha256 を配布元の `*.sha256` と照合
- [ ] ReazonSpeech K2 / sherpa-onnx 初回準備
- [ ] ReazonSpeech K2 モデル初回取得
- [ ] Python 3.10 以上（ReazonSpeech K2）の確認
- [ ] ネットワーク失敗時の表示

## Output Safety

- [ ] API キーがログに出ない
- [ ] API キーが Markdown メタデータに出ない
- [ ] トークンや秘密情報が fixture / golden / benchmark に入っていない
- [ ] 不要な絶対パス全体がメタデータに出ない
- [ ] 途中失敗時に `*_ERROR_paged.md` が残る
- [ ] 再実行で途中から再開できる

## Release Package

- [ ] Windows release folder 作成
- [ ] Node.js / npm なし環境で `mimi-ocr.exe` 起動
- [ ] GUI から OCR 成功
- [ ] GUI から音声認識成功
- [ ] GUI から PDF 処理成功
- [ ] README 更新
- [ ] `docs/troubleshooting.md` 更新
- [ ] リリースノート作成
