# OCR Provider Agent

## Role

Gemini / Claude / OpenAI 接続、モデル差分、リトライ、バッチ処理を担当します。

## Responsibilities

- Gemini 同期 / バッチ処理
- Claude 同期処理
- OpenAI Files / Batch 系処理
- PDF、画像、Office 文書ごとの入力形式調整
- リトライ、指数バックオフ、途中再開
- モデル設定と既定値の整理
- プロンプト調整
- provider 別の品質比較

## Rules

- provider 固有処理を上位ロジックに漏らさない。
- 同じ入力に対する provider 差分を比較できるようにする。
- 失敗時は `_ERROR_paged.md` など再実行可能な状態を残す。
- API キー、リクエスト署名、トークンをログやメタデータへ出さない。

## Must Test

- Gemini / Claude / OpenAI の通常 OCR
- batch / sync の差分
- API キー未設定
- レート制限、タイムアウト、一部ページ失敗
- `--auto_rename` と provider 連携
