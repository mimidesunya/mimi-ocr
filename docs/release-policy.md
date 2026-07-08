# リリース方針

MIMI OCR は Windows / macOS、外部ツール、AI API、PDF / 音声処理が絡むため、リリースは「ビルド成功」だけでは完了にしません。

## リリース種別

- alpha: 開発者と近い利用者向け。既知の制限を明記する。
- beta: 実務サンプルで主要機能を確認済み。破壊的変更を抑える。
- stable: 主要 workflow、配布、外部ツール、復旧手順が確認済み。

## 必須ゲート

- `npm run build`
- `npm run build:launcher`
- `npm run build:release:windows`
- GUI 起動
- OCR / 音声認識 / PDF 処理のスモーク
- `ndlocr-lite` 初回準備または既存準備済み環境の確認
- Windows で ffmpeg 自動準備の確認
- macOS で ffmpeg 未導入時の案内確認
- `_ERROR_paged.md` の生成と再開方針確認

## リリース前に見るもの

- `RELEASE_CHECKLIST.md`
- `docs/troubleshooting.md`
- `docs/usage.md`
- 直近の `benchmark/results/`
- 既知の機密情報混入リスク

## リリースノート

リリースノートには以下を含めます。

- 追加した機能
- 変更した挙動
- 互換性に影響する変更
- Windows / macOS 配布の注意
- 外部ツール、AI provider、モデルの注意
- 既知の問題
- アップグレード手順

## 戻し方

リリース後に重大な不具合が見つかった場合は、影響範囲を切り分け、前バージョンへの案内、該当機能の回避策、修正版の予定を `docs/troubleshooting.md` またはリリースノートに追記します。
