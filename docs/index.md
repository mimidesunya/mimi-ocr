# MIMI OCR ドキュメント

このディレクトリには、MIMI OCR を使う人とメンテナが必要とする基本ドキュメントをまとめています。

## 読み始める順番

1. [プロジェクト概要](./project-overview.md)
2. [セットアップ](./setup.md)
3. [使い方](./usage.md)
4. [設定ファイル](./configuration.md)
5. [アーキテクチャ](./architecture.md)
6. [テスト方針](./testing.md)
7. [OCR品質ガイド](./ocr-quality-guide.md)
8. [リリース方針](./release-policy.md)
9. [トラブルシューティング](./troubleshooting.md)

## 何ができるか

- PDF / Word / ODT / PowerPoint を Markdown 化する
- AI プロバイダーとして Gemini / Claude / OpenAI を使い分ける
- PDF では `ndlocr-lite` を前処理または単独OCRとして併用できる
- OCR結果のページ境界を後処理して読みやすい Markdown に整える
- OCR結果の末尾に、ビルド番号や実行設定を不可視メタデータとして残す
- OCR結果に基づく文書分割（JSON定義で複数ファイルに分割）
- OCR結果に基づくブランクページ除去（白紙ページを除いたPDF+MDペアを生成）
- OCR結果に基づくPDFページ抽出・結合・2面割付
- Electron GUI と CLI の両方から操作できる

## 開発チーム運用

- リポジトリ全体の作業ルールは [AGENTS.md](../AGENTS.md) にあります。
- 仮想開発チームの役割定義は [docs/agents](./agents/README.md) にあります。
- リリース前確認は [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md) を使います。

## 主な出力ファイル

- `*_paged.md`: OCR 直後のページ境界付き Markdown
- `*_ERROR_paged.md`: 一部失敗を含む途中結果
- `*_merged.md`: ページ境界を整理した後処理済み Markdown
- `*_noblank.pdf` / `*_noblank_paged.md`: ブランクページ除去後のファイル
- `*_pages.pdf` / `*_pages.md`: PDFページ抽出後のファイル
- `*_combined_pages.pdf` / `*_combined_pages.md`: 複数PDFから抽出・結合したファイル
- `*_pages_2up.pdf` / `*_pages_2up.md`: 2面割付したファイル
- `*_combined_pages_2up.pdf` / `*_combined_pages_2up.md`: 複数PDFから抽出・結合して2面割付したファイル

OCR 直後の Markdown 末尾には `<!-- mimi-ocr-settings ... -->` 形式の不可視メタデータが付きます。通常表示では見えませんが、ソースからビルド番号、モデル、処理モード、ページ範囲などを確認できます。APIキーは含まれません。

## 補足

- 現行コードの挙動に合わせて記述しています。
- `config.json` にはAPIキーを入れるため、テンプレートから作成し、機密情報を含む実ファイルは共有時に注意してください。
