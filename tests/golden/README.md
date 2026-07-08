# tests/golden

期待出力、回帰確認用 Markdown、比較メモの置き場です。

## 推奨構成

```text
golden/
  ocr/
  merge/
  split/
  deblank/
  pdf-pages/
  stitch/
  transcribe/
  auto-rename/
```

## ルール

- ページ境界、出力ファイル名、不可視メタデータ、安全性を重点的に確認する。
- AI 生成本文は完全一致にこだわりすぎず、構造、重要語、日付、金額、人名、証拠番号を見る。
- provider や model が変わる場合は、比較元を明記する。
- 機密情報を含む出力を golden としてコミットしない。
