# 設定ファイル

## ファイルの役割

設定は2段階で読み込みます。

| ファイル | 役割 | 配布 |
| --- | --- | --- |
| `app.defaults.json` | アプリ標準値。モデル名、CLI既定値、外部ツールの初期値を入れます | コミット・配布する |
| `config.json` | ユーザー固有の設定。APIキーや標準値から変えたい項目だけ入れます | コミットしない |

実行時は `app.defaults.json` を先に読み、同じキーが `config.json` にあれば `config.json` 側で上書きします。

## 設定ファイルの場所

このプロジェクトは `config.json` と `app.defaults.json` を上方向に探索して読み込みます。探索開始位置は次の通りです。

- 現在の作業ディレクトリ
- 実行中スクリプトのディレクトリ
- 実行ファイルのディレクトリ

そのため、通常はプロジェクトルートに `config.json` を置けば問題ありません。

## 推奨手順

```powershell
Copy-Item config.template.json config.json
```

その後、GUI上部の「設定」からAPIキー、モデル名、外部ツールの調整値を設定できます。「APIキー」タブには取得手順も表示されます。GUIのOCR/音声認識の選択は、最後に使った状態を自動保存します。CLI中心で使う場合は、従来どおり `config.json` を直接編集しても構いません。

## `config.json` の最小形

```json
{
  "providers": {
    "gemini": {
      "apiKey": "YOUR_GEMINI_API_KEY"
    },
    "openai": {
      "apiKey": "YOUR_OPENAI_API_KEY"
    },
    "claude": {
      "apiKey": "YOUR_CLAUDE_API_KEY"
    }
  }
}
```

モデル名、OCR/音声認識のCLI既定値、外部ツールの初期値は `app.defaults.json` に入っています。変えたい項目だけ `config.json` に追加してください。

## セクション

### `providers`

AIサービスごとのAPIキーとモデル上書きをまとめます。APIキーはOCR結果メタデータには記録しません。

#### `providers.gemini`

| キー | 必須 | 説明 |
| --- | --- | --- |
| `apiKey` | Gemini利用時に必要 | Gemini API キー。空欄なら `GEMINI_API_KEY` を使います |
| `chatModels` | 任意 | OCR/文書処理用モデルを優先順に最大3件指定する配列。未指定なら`app.defaults.json`または`GEMINI_CHAT_MODELS`を使います |
| `chatModel` | 任意 | 旧版互換の単一モデル指定。`chatModels`がなければ第1順位として保持し、第2・第3順位を標準候補で補います |
| `transcriptionModel` | 任意 | Gemini 音声認識用モデル。未指定なら `app.defaults.json` を使います |

標準の優先順は`gemini-3.1-flash-lite`、`gemini-3.5-flash-lite`、`gemini-3.6-flash`です。通信エラー、空応答、ページマーカー欠落などで同一モデルの再試行を使い切った場合、成功済みページを保持し、未解決ページだけを次順位モデルへ送ります。`SAFETY`など明示的な安全停止は別モデルへ自動送信しません。環境変数`GEMINI_CHAT_MODELS`はカンマ区切りで指定できます。

#### `providers.claude`

| キー | 必須 | 説明 |
| --- | --- | --- |
| `apiKey` | Claude利用時に必要 | Anthropic API キー |
| `chatModel` | 任意 | OCR/文書処理用モデル。未指定なら `app.defaults.json` を使います |

#### `providers.openai`

| キー | 必須 | 説明 |
| --- | --- | --- |
| `apiKey` | OpenAI利用時に必要 | OpenAI API キー。空欄なら `OPENAI_API_KEY` を使います |
| `chatModel` | 任意 | OCR/文書処理用モデル。未指定なら `app.defaults.json` を使います |
| `transcriptionModel` | 任意 | OpenAI 音声認識用モデル。未指定なら `app.defaults.json` を使います |

### `ocr`

CLI OCR の既定値です。通常は `app.defaults.json` 側に置き、ユーザーごとに変えたい場合だけ `config.json` で上書きします。GUIでは画面上の最後の選択が優先されます。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `provider` | 任意 | `gemini`、`claude`、`openai` |
| `target` | 任意 | `general` または `houhi` |
| `mode` | 任意 | `sync` または `batch` |
| `batchSize` | 任意 | PDF の処理ページ数 |
| `ndlocr` | 任意 | PDF OCR で `ndlocr-lite` を併用するか。`pre` / `only` / `off`。既定は `pre` |
| `preferPdfText` | 任意 | 埋め込みテキストがあるPDFでOCRより抽出テキストを優先するか |
| `autoRename` | 任意 | OCR後に変更前のファイル名と内容からファイル名を自動生成するか |
| `skipFormattedRename` | 任意 | 既に自動改名形式のファイルは再判定せずスキップするか。既定は `false` |

### `transcription`

音声認識 CLI の既定値です。通常は `app.defaults.json` 側に置き、ユーザーごとに変えたい場合だけ `config.json` で上書きします。Gemini / OpenAI のモデル名とAPIキーは `providers.openai` / `providers.gemini` から読みます。ReazonSpeech K2 は `tools.reazonK2` のPython環境、VibeVoice ASR は `tools.vibeVoiceAsr` のCPU専用ランタイムを使います。

GUIの「Gemini」「OpenAI」はプロバイダーだけを選択し、実行モデルにはそれぞれ`providers.gemini.transcriptionModel`、`providers.openai.transcriptionModel`を使います。設定画面で音声モデルを保存すると、次の実行から反映されます。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `provider` | 任意 | `gemini`、`openai`、`reazon-k2`、`vibevoice-asr`。既定は `gemini` |
| `language` | 任意 | 音声認識の言語。既定は `ja` |
| `target` | 任意 | `general` または `houhi` |
| `mode` | 任意 | `sync` または `batch` |
| `batchSize` | 任意 | `batch` 時に同時処理する音声ファイル数 |
| `autoRename` | 任意 | 変更前のファイル名と文字起こし内容から音声ファイル本体と出力Markdown名を自動生成するか |
| `skipFormattedRename` | 任意 | 既に自動改名形式の音声ファイルは再判定せずスキップするか。既定は `false` |
| `postprocessAi` | 任意 | Gemini 3.5 Transcribe / Reazon K2 / VibeVoice ASR の生起こしをAIで整え、内容から具体的な話者名・役職を推定するか。`auto` / `gemini` / `openai` / `off` |
| `reazonLanguage` | 任意 | Reazon K2 の言語。`ja` / `ja-en` / `ja-en-mls-5k` |
| `reazonDevice` | 任意 | Reazon K2 の実行デバイス。`cpu` / `cuda` / `coreml` |
| `reazonPrecision` | 任意 | Reazon K2 の精度。`fp32` / `int8` / `int8-fp32` |
| `reazonChunkSec` | 任意 | Reazon K2 に渡す音声チャンク秒数。既定は `25` |
| `vibeVoiceThreads` | 任意 | VibeVoice ASR が使うCPUスレッド数。既定は `4` |
| `vibeVoiceChunkSec` | 任意 | VibeVoice ASR に渡す音声チャンク秒数。既定は `1200`（20分） |
| `silenceTrim.enabled` | 任意 | AIへ渡す前に無音区間をカットするか |
| `silenceTrim.thresholdDb` | 任意 | 無音判定のしきい値 dB |
| `silenceTrim.minSilenceSec` | 任意 | 無音とみなす最短秒数 |
| `silenceTrim.paddingSec` | 任意 | 無音カット時に前後へ残す余白秒数 |
| `silenceTrim.outputFormat` | 任意 | 無音カット後の一時音声形式。既定は `m4a` |
| `silenceTrim.outputBitrate` | 任意 | `m4a` 出力時のAACビットレート。既定は `96k` |

### ffmpeg

ffmpeg / ffprobe は通常 `config.json` には書きません。PATH上の `ffmpeg` を探し、Windowsでは見つからなければ外部ツール保存先の `ffmpeg` フォルダに自動取得します。macOS では Homebrew などで入れた `ffmpeg` / `ffprobe` を使います。

### `tools.rootDir`

`ndlocr-lite` や Windows 版 ffmpeg など、自動準備する外部ツールの保存先です。空欄なら開発環境では `.mimi-tools/`、Windows リリース版ではユーザーデータ配下の `tools/` を使います。GUI では初回の `ndlocr-lite` 利用時に既定の保存先へ自動準備します。保存先を固定したい場合だけ、この値を指定します。

### `tools.ndlocrLite`

`--ndlocr` / `--ndlocr_only` で使う外部OCRツールの調整値です。標準値は `app.defaults.json` にあります。プログラム本体は外部ツール保存先の `ndlocr-lite` に自動取得し、専用Python環境も同じ保存先の `ndlocr-lite-venv` に作ります。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `parallelJobs` | 任意 | `auto` または数値 |
| `pageChunkSize` | 任意 | ndlocr 1回の起動で処理するページ数 |
| `imageDpi` | 任意 | PDF画像化の解像度（dpi） |

補足:

- `parallelJobs: "auto"` の場合、CPU数を元に `1` 以上 `4` 以下で自動調整されます。
- `pageChunkSize` は既定で `8` です。
- `imageDpi` は既定で `300` です。大容量PDFでメモリ不足が出る場合は `200` 前後まで下げると安定しやすくなります。
- 自動取得にはインターネット接続と Python 3.10 以上が必要です。

### `tools.reazonK2`

`--provider=reazon-k2` で使う ReazonSpeech K2 / sherpa-onnx の設定です。標準値は `app.defaults.json` にあります。未指定の場合は外部ツール保存先に `reazon-k2-venv` を作り、`reazonspeech.k2.asr` と `sherpa-onnx` を自動インストールします。モデル本体は ReazonSpeech 側の Hugging Face 設定に従って取得され、既定では外部ツール保存先の `huggingface/` をキャッシュとして使います。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `pythonPath` | 任意 | 準備済みPythonを使う場合のパス。指定時は自動インストールしません |
| `basePythonPath` | 任意 | 自動 venv 作成に使うベースPython |
| `language` | 任意 | `ja` / `ja-en` / `ja-en-mls-5k` |
| `device` | 任意 | `cpu` / `cuda` / `coreml` |
| `precision` | 任意 | `fp32` / `int8` / `int8-fp32` |
| `chunkSeconds` | 任意 | Reazon K2 へ渡すチャンク秒数。既定は `25` |
| `autoInstall` | 任意 | 未準備時に venv とパッケージを自動準備するか。既定は `true` |
| `cacheDir` | 任意 | Hugging Face キャッシュの保存先 |

Reazon K2 はローカルASRなので、`--postprocess-ai=off` なら音声内容をAI APIへ送りません。`auto` / `gemini` / `openai` を選ぶと、ローカルASR結果のテキストだけをAIへ渡し、話者、句読点、反訳書用JSONへ整えます。GUIの「補正モデル」またはCLIの `--postprocess-model` で、音声認識モデルとは別のChatモデルを選択できます。長い結果では全体の話者対応・固有名詞を先に解析し、補正文の出力だけを複数リクエストへ自動分割します。

### `tools.vibeVoiceAsr`

`--provider=vibevoice-asr` で使う [Microsoft VibeASR.cpp](https://github.com/microsoft/VibeASR.cpp) と [VibeVoice-ASR-BitNet](https://huggingface.co/microsoft/VibeVoice-ASR-BitNet) の設定です。7B Transformers版ではなく、量子化した1.5BモデルをCPUだけで動かします。GPU、CUDA、PyTorchは使いません。標準値は `app.defaults.json` にあります。

未指定の場合、初回実行時に外部ツール保存先へ公式リポジトリを取得して `asr_stream_server` をビルドし、GGUFモデル2個（合計約1.7GB）を取得します。WindowsではCMakeとMinGW-w64（`gcc` / `g++` / `mingw32-make`）、macOS/LinuxではCMakeとGCCまたはClangが必要です。一度準備したランタイムとモデルは以後再利用します。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `binaryPath` | 任意 | ビルド済み `asr_stream_server` のパス。空なら自動準備 |
| `vaeModelPath` | 任意 | `vibeasr-vae-encoder-i8_s.gguf` のパス。空なら自動取得 |
| `lmModelPath` | 任意 | `vibeasr-lm-i2_s-embed-q6_k.gguf` のパス。空なら自動取得 |
| `sourceDir` | 任意 | VibeASR.cppソース/ビルド先。空なら外部ツール保存先の `vibeasr-cpp` |
| `modelDir` | 任意 | GGUFモデル保存先。空なら外部ツール保存先の `vibeasr-models/vibeasr` |
| `modelId` | 任意 | GGUF取得元のHugging Faceモデルid。既定は `microsoft/VibeVoice-ASR-BitNet` |
| `threads` | 任意 | 推論に使うCPUスレッド数。既定は `4` |
| `chunkSeconds` | 任意 | 1回に渡す音声の長さ。既定は `1200`（20分）、範囲は60〜1200秒 |
| `autoInstall` | 任意 | 未準備時にランタイムのビルドとモデル取得を行うか。既定は `true` |
| `cCompiler` / `cxxCompiler` / `makePath` | 任意 | Windows自動ビルドで使うMinGWツールの明示パス |

CPU版はチャンク単位のプレーンテキストを返し、音響的な話者分離や発言単位の正確なタイムスタンプは付けません。`postprocessAi=off` では話者を「話者不明」、時刻を各チャンクの開始時刻として保存します。`auto` / `gemini` / `openai` を選ぶとテキストをAIで発言単位に整形できますが、音声自体に基づく話者分離ではありません。

Microsoftが公開しているBitNet版の評価表には英語・フランス語・イタリア語・韓国語・ポルトガル語・ベトナム語・中国語の結果が掲載されていますが、日本語評価は掲載されていません。日本語音声では出力を確認して利用してください。日本語を主対象にする場合は、既存のReazon K2もCPUローカルの選択肢です。

### `tools.stitchEngine`

分割スキャンPDFのページ復元と傾き補正の設定です。位置合わせは内蔵エンジンで処理するため、外部ツールの設定は不要です。標準値は `app.defaults.json` にあります。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `imageDpi` | 任意 | `auto` または PDF 画像化の解像度（dpi）。`auto` は現在300dpiです |
| `deskew` | 任意 | `auto` または `off`。`auto` では合成前後に水平/垂直特徴から小角度の傾きを補正します |
| `pdfImageFormat` | 任意 | `jpeg` または `png`。復元PDF内に埋め込む画像形式です。既定は `jpeg` |
| `jpegQuality` | 任意 | `0.1` から `0.98` のJPEG品質。既定は `0.86` |

`deskew: "auto"` は数度以内の傾きを対象にします。ページ組の自動判定では180度回転（縦横が違う場合は90度回転）も検出するため、読み方向が逆向きのスキャンも復元できますが、完成ページ自体の向き補正は行いません。`pdfImageFormat: "jpeg"` はスキャン画像PDFの肥大化を避けるための既定です。無劣化で残したい場合は `png` に変更できます。

### 法匪テンプレート

法匪モードは同梱テンプレート `src/templates/houhi_sample.md` を使うため、外部リポジトリ指定は不要です。

## OCR結果メタデータに記録される設定

OCR 直後の Markdown 末尾には、`<!-- mimi-ocr-settings ... -->` 形式で実行設定が記録されます。合成後の設定からは主に次の値だけを参照します。

- 使用AIプロバイダーのモデル名とGeminiの優先順（例: `providers.gemini.chatModels`, `providers.claude.chatModel`, `providers.openai.chatModel`）
- `tools.ndlocrLite.parallelJobs`
- `tools.ndlocrLite.pageChunkSize`
- `tools.ndlocrLite.imageDpi`

APIキー、トークン、絶対パス全体は記録しません。
