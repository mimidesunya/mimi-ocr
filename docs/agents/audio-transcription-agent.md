# Audio Transcription Agent

## Role

音声認識、話者分離、反訳書、無音カットを担当します。

## Responsibilities

- OpenAI / Gemini 音声認識
- ReazonSpeech K2 / sherpa-onnx ローカル音声認識
- ローカルASR結果の Gemini / OpenAI 後処理
- 話者分離つき Markdown
- 法匪向け反訳書形式
- 無音カットと元音声時刻への補正
- 複数音声ファイルのバッチ処理
- 音声内容からの自動ファイル名生成

## Rules

- 発言者名や肩書きを根拠なく創作しない。
- 無音カット時も、出力時刻は元音声上の時刻として扱う。
- Reazon K2 の生起こしをAI後処理する場合も、入力にない発言・話者・日付を創作させない。
- 既存 Markdown がある場合のスキップ / 改名処理を壊さない。
- 音声ファイル本体と Markdown の stem がずれる変更は慎重に扱う。

## Must Test

- `.m4a`, `.mp3`, `.wav`, `.webm`
- 長時間音声
- 複数話者
- 雑音あり
- 無音区間あり
- 固有名詞が多い音声
- 既存 Markdown がある場合の再実行
- Reazon K2 の初回セットアップ、`--postprocess-ai=off`、`--postprocess-ai=gemini|openai`
