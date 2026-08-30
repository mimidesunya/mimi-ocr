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

- `providers.gemini.chatModels` と旧形式の`chatModel`が設定されていない
- `GEMINI_CHAT_MODELS` と旧形式の`GEMINI_CHAT_MODEL`も未設定

対処:

- モデル名を標準値から変えたい場合は、GUIの設定で優先順3件を指定するか、`config.json`の`providers.gemini.chatModels`を配列で上書きする
- もしくは環境変数`GEMINI_CHAT_MODELS`へカンマ区切りで指定する
- 旧`chatModel`/`GEMINI_CHAT_MODEL`も第1順位として引き続き利用できる

## Gemini APIキーが未設定

症状:

- GUIで Gemini を使う処理を開始すると、APIキー設定の案内が出る
- `API Key not found` と表示される

対処:

- GUI上部の「APIキー」を開き、Google AI Studio の APIキー作成ページへ進む
- 作成したキーを「設定」→「config.json」→「Gemini APIキー」に貼り付けて保存する

## `OpenAI API Key not found in config.json`

原因:

- `providers.openai.apiKey` がない

対処:

- `config.json` の `providers.openai.apiKey` を設定する

## 音声認識の2段階補正が OpenAI エラーで停止する

症状:

- `401`、`invalid_api_key`、`Incorrect API key provided` と表示される
- `400`、`Unsupported parameter: 'temperature'` と表示される

対処:

- GUIの「設定」で OpenAI APIキーを貼り直し、保存してから再実行する
- 音声認識画面の「補正AIモデル」が、利用中のAPIキーで使用できるモデルか確認する
- `0.1.0-alpha.3` 以前で `temperature` のエラーが出る場合は、新しい版へ更新する

APIエラーが発生した処理は成功扱いにせず、文字起こし結果を確定しません。エラー解消後に同じ音声を再実行してください。

## APIキーの「貼り付け」ボタンでエラーになる

対処:

- `0.1.0-alpha.3` 以前を使用している場合は、新しい版へ更新する
- OSのクリップボードにAPIキーをコピーしたうえで、設定画面の「貼り付け」を押す
- 反映後は必ず設定を保存する

## `Claude API Key not found in config.json`

原因:

- `providers.claude.apiKey` がない

対処:

- `config.json` の `providers.claude.apiKey` を設定する

## `ndlocr-lite のリポジトリが見つかりません`

原因:

- 自動取得がネットワークエラーで失敗した
- Python 3.10 以上を起動できない
- `src/ocr.py` が見つからない

対処:

- `python --version` で Python 3.10 以上を起動できることを確認する
- インターネット接続を確認して再実行する
- GUIでは初回利用時にアプリ標準の保存先へ自動準備する。壊れている場合は、その保存先の `ndlocr-lite` フォルダを削除して再実行する

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

## PDFページ抽出でOCR結果が見つからない

症状:

- `対応するOCR結果が見つかりません` と表示される
- PDFページ抽出・結合ツールが実行できない

原因:

- PDFと同じ場所に `*_paged.md` または `*_ERROR_paged.md` がない
- PDF名とOCR結果ファイル名の stem が一致していない

対処:

- 先に対象PDFをOCRして `元ファイル名_paged.md` を作成する
- OCR結果ファイルがPDFと同じフォルダにあるか確認する
- PDF名を変更した場合は、OCR結果ファイル名も同じ stem に合わせる

## OpenAI の PDF 処理が重い

理由:

- OpenAI 利用時は PDF をページごとの PNG に変換してから送信するため

対処:

- ページ範囲を `--start_page` / `--end_page` で絞る
- `--batch_size` を調整する
- 埋め込みテキストがある PDF なら `--prefer_pdf_text` を使う

## `FATAL ERROR: Reached heap limit`（Node.js のメモリ不足）

症状:

- `Reached heap limit Allocation failed - JavaScript heap out of memory`
- 大きい PDF を `ndlocr` 付きで処理すると途中で停止する

対処:

- `config.json` の `tools.ndlocrLite.parallelJobs` を `1` か `2` に下げる
- `config.json` の `tools.ndlocrLite.pageChunkSize` を `4` か `6` に下げる
- `config.json` の `tools.ndlocrLite.imageDpi` を `200` 前後に下げる
- まずは `--start_page` / `--end_page` で区間を分けて実行する

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
