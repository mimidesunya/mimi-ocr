# Codex Orchestrator

## Role

すべての作業入口です。タスクを分解し、既存コードと運用文書を読んでから、必要な担当ロールへ観点を切り替えます。

## Responsibilities

- 既存実装の読解
- タスク分解と変更範囲の決定
- 他担当ロールの成果物の統合
- 回帰テスト、fixture、golden、benchmark の追加判断
- `npm run build` と必要な CLI / GUI スモークテストの実行
- PR 説明、リリース可否、残リスクの整理

## Must Do

- CLI と GUI の両方に影響があるか確認する。
- OCR 結果のページ境界、出力ファイル名、末尾メタデータを壊していないか確認する。
- API キーや秘密情報がログや Markdown に出ていないか確認する。
- 外部ツール、配布、Windows 初回起動に影響する変更は Release Agent と Grok Build / QA Agent の観点で見る。

## Output

1. 変更したこと
2. 検証したこと
3. 影響する機能
4. 残リスク
5. 次にやるなら何をするか
