# トラブルシューティング

## `node_modules` が見つからない

症状:

- ランチャー起動時にセットアップ不足のメッセージが出る

対処:

```powershell
npm install
```

## `config.json` がない、または読み込めない

症状:

- API キー未設定エラー
- モデル未設定エラー

対処:

```powershell
Copy-Item config.template.json config.json
```

その後、JSON 構文を壊していないか確認してください。

## `Gemini chat model is not configured`

原因:

- `gemini.chatModel` が設定されていない
- `GEMINI_CHAT_MODEL` も未設定

対処:

- `config.json` の `gemini.chatModel` を設定する
- もしくは環境変数 `GEMINI_CHAT_MODEL` を設定する

## `OpenAI API Key not found in config.json`

原因:

- `openai.apiKey` がない

対処:

- `config.json` の `openai.apiKey` を設定する

## `Claude API Key not found in config.json`

原因:

- `claude.apiKey` がない

対処:

- `config.json` の `claude.apiKey` を設定する

## `ndlocr-lite のリポジトリが見つかりません`

原因:

- `ndlocrLite.repoPath` が未設定
- 指定パスが存在しない
- `src/ocr.py` が見つからない

対処:

- `config.json` の `ndlocrLite.repoPath` を絶対パスで設定する
- `pythonPath` で起動できる Python を確認する

## 既存ファイルがあるためスキップされる

症状:

- `出力ファイルが既に存在します` と表示される

原因:

- 既に `*_paged.md` が生成済み

対処:

- 既存結果を残すならそのまま
- 再生成したい場合は対象の `*_paged.md` を退避または削除して再実行する

## `_ERROR_paged.md` が残る

意味:

- 一部ページのOCRに失敗しています

対処:

- 同じ入力で再実行すると、成功済みページを再利用して再開します
- API 制限、タイムアウト、モデル出力の不整合を疑ってください

## OpenAI の PDF 処理が重い

理由:

- OpenAI 利用時は PDF をページごとの PNG に変換してから送信するため

対処:

- ページ範囲を `--start_page` / `--end_page` で絞る
- `--batch_size` を調整する
- 埋め込みテキストがある PDF なら `--prefer_pdf_text` を使う

## Claude でバッチを選べない

理由:

- 現行GUIは Claude を同期モード固定として扱っています

対処:

- 仕様です。大量処理では Gemini または OpenAI のバッチ利用を検討してください

## `npm install` でネイティブ依存関係に失敗する

背景:

- `canvas` を含むため、環境によっては追加のビルド要件が必要です

対処:

- Node.js のバージョンとビルド環境を確認する
- まずは同じマシンで `npm run build` まで通るか確認する
