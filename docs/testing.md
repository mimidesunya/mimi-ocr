# テスト方針

MIMI OCR のテストは、単体テストだけではなく、実務文書で壊れないことを確認する fixture / golden / benchmark を中心に組み立てます。

## ディレクトリ

```text
tests/
  fixtures/
    pdf/
    docx/
    odt/
    pptx/
    audio/
    scanned/
    broken/
  golden/
    ocr/
    merge/
    split/
    deblank/
    pdf-pages/
    stitch/
    transcribe/
    auto-rename/
  reports/
```

現時点では `tests/fixtures/README.md` と `tests/golden/README.md` を入口にし、実 fixture は機密性を確認してから追加します。

## Fixture ルール

- 原則として合成データ、公開データ、または十分に墨消ししたデータを使う。
- 裁判資料や行政文書の実データを入れる場合は、権利、個人情報、事件番号、住所、氏名、連絡先を確認する。
- API キー、トークン、ローカル絶対パス、作業者名が含まれていないか確認する。
- 大容量 fixture は Git 管理せず、取得方法または生成スクリプトを置く。

## Golden ルール

- golden は「完全一致すべき構造」と「目視確認する品質」を分ける。
- ページ境界、ファイル名、不可視メタデータ、エラー時の `_ERROR_paged.md` は回帰対象にする。
- AI 出力は揺れるため、本文の完全一致だけに依存しない。見出し、ページ境界、表、日付、金額、人名などのチェック観点を併用する。

## 標準スモーク

```powershell
npm run build
npm run ocr -- .\tests\fixtures\pdf\sample.pdf
npm run merge -- .\tests\fixtures\golden-source\sample_paged.md
npm run pdf-pages -- --pages 1-2 .\tests\fixtures\pdf\sample.pdf
npm run deblank -- .\tests\fixtures\pdf\sample.pdf
npm run stitch -- .\tests\fixtures\scanned\split_scan.pdf
npm run transcribe -- .\tests\fixtures\audio\meeting.m4a
```

fixture が未配置の環境では、該当コマンドを「未実行」として理由を残します。

## 重点回帰

- `*_paged.md` と PDF のページ対応
- `*_ERROR_paged.md` の生成と再開
- `*_merged.md` の整形
- 文書分割 JSON のページ範囲
- 白紙除去後の PDF / MD ペア
- PDF ページ抽出、複数 PDF 結合、2 面割付
- 分割スキャン復元レポート
- 音声認識の話者ラベル、時刻、無音カット補正
- API キーや秘密情報の非混入
