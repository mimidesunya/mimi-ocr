# mimi-ocr ドキュメント

このディレクトリには、`mimi-ocr` を使う人とメンテナが必要とする基本ドキュメントをまとめています。

## 読み始める順番

1. [プロジェクト概要](./project-overview.md)
2. [セットアップ](./setup.md)
3. [使い方](./usage.md)
4. [設定ファイル](./configuration.md)
5. [アーキテクチャ](./architecture.md)
6. [トラブルシューティング](./troubleshooting.md)

## 何ができるか

- PDF / Word / ODT / PowerPoint を Markdown 化する
- AI プロバイダーとして Gemini / Claude / OpenAI を使い分ける
- PDF では `ndlocr-lite` を前処理または単独OCRとして併用できる
- OCR結果のページ境界を後処理して読みやすい Markdown に整える
- OCR結果に基づく文書分割（JSON定義で複数ファイルに分割）
- OCR結果に基づくブランクページ除去（白紙ページを除いたPDF+MDペアを生成）
- Electron GUI と CLI の両方から操作できる

## 主な出力ファイル

- `*_paged.md`: OCR 直後のページ境界付き Markdown
- `*_ERROR_paged.md`: 一部失敗を含む途中結果
- `*_merged.md`: ページ境界を整理した後処理済み Markdown
- `*_noblank.pdf` / `*_noblank_paged.md`: ブランクページ除去後のファイル

## 補足

- 現行コードの挙動に合わせて記述しています。
- `config.json` にはAPIキーを入れるため、テンプレートから作成し、機密情報を含む実ファイルは共有時に注意してください。
