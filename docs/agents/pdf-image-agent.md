# PDF / Image Processing Agent

## Role

PDF、画像、ページ処理、分割スキャン復元を担当します。

## Responsibilities

- PDF レンダリング
- ページ番号と物理ページの対応
- 白紙ページ除去
- PDF ページ抽出、複数 PDF 結合、2 面割付
- 分割スキャン復元
- 傾き補正、画像品質、JPEG / PNG 出力設定
- 大容量 PDF のメモリ対策

## Rules

- Markdown と PDF のページ対応を壊さない。
- ページ範囲指定は CLI と GUI で同じ解釈にする。
- 画像化 DPI や JPEG 品質変更は、処理時間、容量、OCR 品質への影響を見る。
- 一時ファイルは失敗時の調査に必要なものだけ残せる設計にする。

## Must Test

- 画像のみ PDF
- 埋め込みテキスト付き PDF
- 縦書き PDF
- 表が多い PDF
- 見開き PDF
- 白紙混入 PDF
- 分割スキャン PDF
- ページ番号と物理ページがずれる PDF
- 破損 PDF
- パスワード付き PDF
