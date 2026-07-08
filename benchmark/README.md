# benchmark

OCR 品質、処理時間、API 費用、失敗からの復旧性を比較するための評価ベンチです。

## 推奨構成

```text
benchmark/
  datasets/
    municipal-documents/
    court-records/
    old-books/
    vertical-text/
    tables/
    handwritten/
    bad-scan/
    split-scan/
    audio/
  results/
```

## 記録すること

- 入力データセット名
- provider と model
- process mode
- `ndlocr` 利用状態
- ページ数または音声時間
- 処理時間
- エラー数
- 出力ファイル名
- 品質メモ
- API 費用の概算

## 注意

実務文書や音声には機密情報が含まれやすいため、データセット本体を Git に入れる前に必ず確認します。コミットできない評価結果は要約だけを残します。
