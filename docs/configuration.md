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

その後、`config.json` にAPIキーやモデル名を設定してください。

## サンプル

```json
{
  "gemini": {
    "apiKey": "YOUR_GEMINI_API_KEY",
    "chatModel": "YOUR_GEMINI_MODEL",
    "maxRetries": 3
  },
  "claude": {
    "apiKey": "YOUR_CLAUDE_API_KEY",
    "baseUrl": "https://api.anthropic.com/v1/messages",
    "chatModel": "YOUR_CLAUDE_MODEL",
    "timeoutMs": 300000,
    "maxRetries": 3
  },
  "openai": {
    "apiKey": "YOUR_OPENAI_API_KEY",
    "baseUrl": "https://api.openai.com/v1/chat/completions",
    "chatModel": "YOUR_OPENAI_MODEL",
    "timeoutMs": 300000,
    "maxRetries": 3
  },
  "ndlocrLite": {
    "pythonPath": "python",
    "repoPath": "PATH_TO_NDLOCR_LITE_REPO",
    "parallelJobs": "auto"
  }
}
```

## セクションごとの意味

### `gemini`

| キー | 必須 | 説明 |
| --- | --- | --- |
| `apiKey` | 実質必須 | Gemini API キー |
| `chatModel` | 必須 | 使用するモデルID |
| `maxRetries` | 任意 | SDK の再試行回数 |

補足:

- Gemini は `GEMINI_API_KEY` と `GEMINI_CHAT_MODEL` の環境変数フォールバックがあります。
- `chatModel` がなければ実行時エラーになります。

### `claude`

| キー | 必須 | 説明 |
| --- | --- | --- |
| `apiKey` | 必須 | Anthropic API キー |
| `baseUrl` | 任意 | 既定は `https://api.anthropic.com/v1/messages` |
| `chatModel` | 任意 | 既定は `claude-opus-4-6` |
| `timeoutMs` | 任意 | タイムアウトミリ秒 |
| `maxRetries` | 任意 | SDK の再試行回数 |

補足:

- コード内部では `baseUrl` から `/v1/messages` を除いて SDK に渡します。
- Claude は現状、同期モードの並列HTTP実行として扱われます。

### `openai`

| キー | 必須 | 説明 |
| --- | --- | --- |
| `apiKey` | 必須 | OpenAI API キー |
| `baseUrl` | 任意 | 既定は `https://api.openai.com/v1/chat/completions` |
| `chatModel` | 任意 | 既定は `gpt-4o` |
| `timeoutMs` | 任意 | タイムアウトミリ秒 |
| `maxRetries` | 任意 | 同期呼び出しの再試行回数 |

補足:

- 同期モードでは Chat Completions API を使います。
- バッチモードでは `baseUrl` を元に Files API / Batches API のベースURLを導出します。
- OpenAI 利用時の PDF は、内部でページ画像に変換して送信されます。

### `ndlocrLite`

| キー | 必須 | 説明 |
| --- | --- | --- |
| `pythonPath` | 任意 | `python` など実行コマンド |
| `repoPath` | `ndlocr` 利用時に必須 | `ndlocr-lite` リポジトリの絶対パス |
| `parallelJobs` | 任意 | `auto` または数値 |

補足:

- `parallelJobs: "auto"` の場合、CPU数を元に `1` 以上 `8` 以下で自動調整されます。
- `repoPath/src/ocr.py` が存在しないと失敗します。

## 現行コードで参照される設定

現時点でアプリ本体が参照しているのは次のセクションです。

- `gemini`
- `claude`
- `openai`
- `ndlocrLite`

`houhi` のような追加セクションを `config.json` に置いても、現行の `src` 配下コードからは使われません。houhi 用のサンプル Markdown は `--context-file` または GUI のコンテキスト入力で指定します。
