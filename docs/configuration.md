# 設定ファイル

## 設定ファイルの場所

このプロジェクトは `config.json` を上方向に探索して読み込みます。探索開始位置は次の通りです。

- 現在の作業ディレクトリ
- 実行中スクリプトのディレクトリ
- 実行ファイルのディレクトリ

そのため、通常はプロジェクトルートに `config.json` を置けば問題ありません。

## 推奨手順

```powershell
Copy-Item config.template.json config.json
```

その後、`config.json` にAPIキー、モデル名、OCR/音声認識の既定値を設定してください。

## 全体構造

```json
{
  "app": {
    "name": "MIMI OCR"
  },
  "providers": {
    "gemini": {
      "apiKey": "YOUR_GEMINI_API_KEY",
      "chatModel": "gemini-2.5-flash-preview",
      "transcriptionModel": "gemini-3.5-flash",
      "maxRetries": 3
    },
    "claude": {
      "apiKey": "YOUR_CLAUDE_API_KEY",
      "baseUrl": "https://api.anthropic.com/v1/messages",
      "chatModel": "claude-opus-4-6",
      "timeoutMs": 300000,
      "maxRetries": 3
    },
    "openai": {
      "apiKey": "YOUR_OPENAI_API_KEY",
      "baseUrl": "https://api.openai.com/v1/chat/completions",
      "chatModel": "gpt-4o",
      "transcriptionModel": "gpt-4o-transcribe-diarize",
      "timeoutMs": 300000,
      "maxRetries": 3
    }
  },
  "ocr": {
    "provider": "gemini",
    "target": "general",
    "mode": "sync",
    "batchSize": 4,
    "preferPdfText": false,
    "autoRename": false,
    "skipFormattedRename": false,
    "houhiTemplatePath": "",
    "contextText": "",
    "contextFilePath": ""
  },
  "transcription": {
    "provider": "gemini",
    "language": "ja",
    "target": "general",
    "mode": "sync",
    "batchSize": 4,
    "autoRename": false,
    "skipFormattedRename": false,
    "contextText": "",
    "contextFilePath": "",
    "silenceTrim": {
      "enabled": false,
      "thresholdDb": -35,
      "minSilenceSec": 1,
      "paddingSec": 0.2,
      "outputFormat": "m4a",
      "outputBitrate": "96k"
    }
  },
  "tools": {
    "ffmpeg": {
      "ffmpegPath": "F:\\usr\\ffmpeg-7.1.1-full_build\\bin\\ffmpeg.exe",
      "ffprobePath": "F:\\usr\\ffmpeg-7.1.1-full_build\\bin\\ffprobe.exe"
    },
    "ndlocrLite": {
      "pythonPath": "python",
      "repoPath": "PATH_TO_NDLOCR_LITE_REPO",
      "parallelJobs": "auto",
      "pageChunkSize": 8,
      "workerStartDelayMs": 1500,
      "imageDpi": 300
    }
  },
  "paths": {
    "houhiRoot": ""
  }
}
```

## セクション

### `app`

| キー | 必須 | 説明 |
| --- | --- | --- |
| `name` | 任意 | GUIタイトルなどで使うアプリ名 |

### `providers`

AIサービスごとのAPIキー、モデル、通信設定をまとめます。APIキーはOCR結果メタデータには記録しません。

#### `providers.gemini`

| キー | 必須 | 説明 |
| --- | --- | --- |
| `apiKey` | Gemini利用時に必要 | Gemini API キー。空欄なら `GEMINI_API_KEY` を使います |
| `chatModel` | OCR利用時に必要 | OCR/文書処理用モデル。空欄なら `GEMINI_CHAT_MODEL` を使います |
| `transcriptionModel` | 音声認識利用時に必要 | Gemini 音声認識用モデル |
| `maxRetries` | 任意 | SDK の再試行回数 |

#### `providers.claude`

| キー | 必須 | 説明 |
| --- | --- | --- |
| `apiKey` | Claude利用時に必要 | Anthropic API キー |
| `baseUrl` | 任意 | 既定は `https://api.anthropic.com/v1/messages` |
| `chatModel` | 任意 | OCR/文書処理用モデル |
| `timeoutMs` | 任意 | タイムアウトミリ秒 |
| `maxRetries` | 任意 | SDK の再試行回数 |

#### `providers.openai`

| キー | 必須 | 説明 |
| --- | --- | --- |
| `apiKey` | OpenAI利用時に必要 | OpenAI API キー。空欄なら `OPENAI_API_KEY` を使います |
| `baseUrl` | 任意 | 既定は `https://api.openai.com/v1/chat/completions` |
| `chatModel` | 任意 | OCR/文書処理用モデル |
| `transcriptionModel` | 音声認識利用時に必要 | OpenAI 音声認識用モデル |
| `timeoutMs` | 任意 | タイムアウトミリ秒 |
| `maxRetries` | 任意 | 同期呼び出しの再試行回数 |

### `ocr`

CLI OCR の既定値です。GUIでは画面上の選択が優先されます。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `provider` | 任意 | `gemini`、`claude`、`openai` |
| `target` | 任意 | `general` または `houhi` |
| `mode` | 任意 | `sync` または `batch` |
| `batchSize` | 任意 | PDF の処理ページ数 |
| `preferPdfText` | 任意 | 埋め込みテキストがあるPDFでOCRより抽出テキストを優先するか |
| `autoRename` | 任意 | OCR後に内容からファイル名を自動生成するか |
| `skipFormattedRename` | 任意 | 既に自動改名形式のファイルは再判定せずスキップするか。既定は `false` |
| `houhiTemplatePath` | 任意 | 法匪OCR用テンプレートを差し替える場合の Markdown パス |
| `contextText` | 任意 | OCR前に渡す登場人物、役職、固有名詞、専門用語などの補助テキスト |
| `contextFilePath` | 任意 | OCR補助テキストを外部ファイルから読む場合のパス |

### `transcription`

音声認識 CLI の既定値です。モデル名とAPIキーは `providers.openai` / `providers.gemini` から読みます。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `provider` | 任意 | `gemini` または `openai`。既定は `gemini` |
| `language` | 任意 | 音声認識の言語。既定は `ja` |
| `target` | 任意 | `general` または `houhi` |
| `mode` | 任意 | `sync` または `batch` |
| `batchSize` | 任意 | `batch` 時に同時処理する音声ファイル数 |
| `autoRename` | 任意 | 文字起こし内容から音声ファイル本体と出力Markdown名を自動生成するか |
| `skipFormattedRename` | 任意 | 既に自動改名形式の音声ファイルは再判定せずスキップするか。既定は `false` |
| `contextText` | 任意 | 登場人物、役職、固有名詞など音声認識前に渡す補助テキスト |
| `contextFilePath` | 任意 | 補助テキストを外部ファイルから読む場合のパス |
| `silenceTrim.enabled` | 任意 | AIへ渡す前に無音区間をカットするか |
| `silenceTrim.thresholdDb` | 任意 | 無音判定のしきい値 dB |
| `silenceTrim.minSilenceSec` | 任意 | 無音とみなす最短秒数 |
| `silenceTrim.paddingSec` | 任意 | 無音カット時に前後へ残す余白秒数 |
| `silenceTrim.outputFormat` | 任意 | 無音カット後の一時音声形式。既定は `m4a` |
| `silenceTrim.outputBitrate` | 任意 | `m4a` 出力時のAACビットレート。既定は `96k` |

### `tools.ffmpeg`

音声認識の無音カットで使う ffmpeg / ffprobe の場所です。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `ffmpegPath` | 無音カット利用時に必要 | `ffmpeg.exe` のパス |
| `ffprobePath` | 推奨 | `ffprobe.exe` のパス |

### `tools.ndlocrLite`

`--ndlocr` / `--ndlocr_only` で使う外部OCRツール設定です。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `pythonPath` | 任意 | `python` など実行コマンド |
| `repoPath` | ndlocr利用時に必要 | `ndlocr-lite` リポジトリの絶対パス |
| `parallelJobs` | 任意 | `auto` または数値 |
| `pageChunkSize` | 任意 | ndlocr 1回の起動で処理するページ数 |
| `workerStartDelayMs` | 任意 | 並列ワーカーの起動をずらす間隔（ミリ秒） |
| `imageDpi` | 任意 | PDF画像化の解像度（dpi） |

補足:

- `parallelJobs: "auto"` の場合、CPU数を元に `1` 以上 `4` 以下で自動調整されます。
- `pageChunkSize` は既定で `8` です。
- `imageDpi` は既定で `300` です。大容量PDFでメモリ不足が出る場合は `200` 前後まで下げると安定しやすくなります。
- `repoPath/src/ocr.py` が存在しないと失敗します。

### `paths`

プロジェクト外の関連パスを置く場所です。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `houhiRoot` | 任意 | 法匪関連リポジトリのルートパス |

## OCR結果メタデータに記録される設定

OCR 直後の Markdown 末尾には、`<!-- mimi-ocr-settings ... -->` 形式で実行設定が記録されます。`config.json` からは主に次の値だけを参照します。

- 使用AIプロバイダーのモデル名（例: `providers.gemini.chatModel`, `providers.claude.chatModel`, `providers.openai.chatModel`）
- `tools.ndlocrLite.parallelJobs`
- `tools.ndlocrLite.pageChunkSize`
- `tools.ndlocrLite.imageDpi`

APIキー、トークン、絶対パス全体は記録しません。`tools.ndlocrLite.repoPath` や `pythonPath` も OCR結果メタデータには含めません。
