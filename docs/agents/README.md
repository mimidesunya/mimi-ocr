# 仮想開発チーム

MIMI OCR の開発は Codex を入口にし、作業内容ごとに担当ロールを切り替えます。ここでいう担当は、実在する外部 CLI が使える場合の委任先でもあり、Codex が単独で作業するときの観点リストでもあります。

## 役割一覧

| ファイル | 担当領域 |
| --- | --- |
| `codex-orchestrator.md` | 作業入口、統合、最終判断 |
| `claude-code-architect.md` | 設計、リファクタ、型安全化 |
| `agy-gui-agent.md` | Electron GUI、UX、設定画面 |
| `grok-build-qa.md` | 破壊的 QA、配布、環境差分 |
| `ocr-provider-agent.md` | Gemini / Claude / OpenAI 連携 |
| `pdf-image-agent.md` | PDF、画像、ページ処理 |
| `audio-transcription-agent.md` | 音声認識、話者分離、反訳書 |
| `houhi-mode-agent.md` | 裁判資料、法匪テンプレート、証拠処理 |
| `documentation-agent.md` | README、チュートリアル、利用者向け文書 |
| `release-agent.md` | リリース可否、配布チェック |

## 使い方

1. Codex が関連ファイルを読む。
2. 変更範囲に合う担当ロールの観点を開く。
3. 実装または文書更新を行う。
4. 必要な fixture / golden / benchmark / release checklist を更新する。
5. Codex が統合差分と検証結果を確認する。
