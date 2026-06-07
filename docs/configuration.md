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
| `chatModel` | 任意 | OCR/文書処理用モデル。未指定なら `app.defaults.json` または `GEMINI_CHAT_MODEL` を使います |
| `transcriptionModel` | 任意 | Gemini 音声認識用モデル。未指定なら `app.defaults.json` を使います |

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
| `preferPdfText` | 任意 | 埋め込みテキストがあるPDFでOCRより抽出テキストを優先するか |
| `autoRename` | 任意 | OCR後に内容からファイル名を自動生成するか |
| `skipFormattedRename` | 任意 | 既に自動改名形式のファイルは再判定せずスキップするか。既定は `false` |

### `transcription`

音声認識 CLI の既定値です。通常は `app.defaults.json` 側に置き、ユーザーごとに変えたい場合だけ `config.json` で上書きします。モデル名とAPIキーは `providers.openai` / `providers.gemini` から読みます。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `provider` | 任意 | `gemini` または `openai`。既定は `gemini` |
| `language` | 任意 | 音声認識の言語。既定は `ja` |
| `target` | 任意 | `general` または `houhi` |
| `mode` | 任意 | `sync` または `batch` |
| `batchSize` | 任意 | `batch` 時に同時処理する音声ファイル数 |
| `autoRename` | 任意 | 文字起こし内容から音声ファイル本体と出力Markdown名を自動生成するか |
| `skipFormattedRename` | 任意 | 既に自動改名形式の音声ファイルは再判定せずスキップするか。既定は `false` |
| `silenceTrim.enabled` | 任意 | AIへ渡す前に無音区間をカットするか |
| `silenceTrim.thresholdDb` | 任意 | 無音判定のしきい値 dB |
| `silenceTrim.minSilenceSec` | 任意 | 無音とみなす最短秒数 |
| `silenceTrim.paddingSec` | 任意 | 無音カット時に前後へ残す余白秒数 |
| `silenceTrim.outputFormat` | 任意 | 無音カット後の一時音声形式。既定は `m4a` |
| `silenceTrim.outputBitrate` | 任意 | `m4a` 出力時のAACビットレート。既定は `96k` |

### ffmpeg

ffmpeg / ffprobe は通常 `config.json` には書きません。PATH上の `ffmpeg` を探し、Windowsでは見つからなければ `.mimi-tools/ffmpeg` に自動取得します。macOS では Homebrew などで入れた `ffmpeg` / `ffprobe` を使います。

### `tools.ndlocrLite`

`--ndlocr` / `--ndlocr_only` で使う外部OCRツールの調整値です。標準値は `app.defaults.json` にあります。プログラム本体は `.mimi-tools/ndlocr-lite` に自動取得し、専用Python環境も `.mimi-tools/ndlocr-lite-venv` に作ります。

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

### 法匪テンプレート

法匪モードは同梱テンプレート `src/templates/houhi_sample.md` を使うため、外部リポジトリ指定は不要です。

## OCR結果メタデータに記録される設定

OCR 直後の Markdown 末尾には、`<!-- mimi-ocr-settings ... -->` 形式で実行設定が記録されます。合成後の設定からは主に次の値だけを参照します。

- 使用AIプロバイダーのモデル名（例: `providers.gemini.chatModel`, `providers.claude.chatModel`, `providers.openai.chatModel`）
- `tools.ndlocrLite.parallelJobs`
- `tools.ndlocrLite.pageChunkSize`
- `tools.ndlocrLite.imageDpi`

APIキー、トークン、絶対パス全体は記録しません。
