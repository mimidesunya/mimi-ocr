# OCR 品質ガイド

MIMI OCR では、新機能の追加よりも、実務文書で出力品質が劣化していないことを検出できる仕組みを重視します。

## 評価軸

- ページ境界の正確性
- Markdown 構造
- 見出し抽出
- 表の再現性
- 日付、金額、人名、事件番号の正確性
- 縦書き、ルビ、脚注、旧字体への対応
- OCR 失敗ページの扱い
- 反訳書としての読みやすさ
- 処理時間
- API 費用
- 途中失敗からの再開可否

## 評価セット

```text
benchmark/datasets/
  municipal-documents/
  court-records/
  old-books/
  vertical-text/
  tables/
  handwritten/
  bad-scan/
  split-scan/
  audio/
```

## Provider 比較

同じ入力を Gemini / Claude / OpenAI で処理し、次を記録します。

- provider
- model
- process mode
- `ndlocr` 利用状態
- ページ数
- 処理時間
- エラー数
- 出力ファイル
- 目視評価メモ

## 判定

- ページ境界がずれる変更は原則として不合格。
- API キーや秘密情報が出力へ混入する変更は不合格。
- 表や縦書きなどの品質低下は、対象 workflow に影響する場合は修正または既知の制限として明記する。
- AI 出力の揺れは許容するが、日付、金額、人名、証拠番号の創作は許容しない。

## レポート

評価結果は `benchmark/results/` に保存します。大容量出力や機密を含む結果は Git 管理せず、要約だけを残します。
