# -*- coding: utf-8 -*-
"""mimi-ocr の設定を、文字の層が正確な PDF を正解にして比べる。

正解: houhi（Copper・Chrome）で作った書面、裁判所サイトの判決 PDF など、文字の層が原本どおりの PDF。
スキャナの OCR の文字の層は正解にならない（ScanSnap などの PDF は使わない）。

  0) 公開の正解 PDF を取る（benchmark/corpus/corpus.json の URL と、手元で作った PDF）
     python benchmark/bench.py fetch <作業フォルダ>
  1) 画像だけの PDF と正解を作る
     python benchmark/bench.py prepare <作業フォルダ> [<名前=PDF> ...]   （省略すると 作業フォルダ/src/*.pdf を全部）
       作業フォルダ/truth/<名前>.json   … 頁ごとの正解（get_text）
       作業フォルダ/scan/<名前>.pdf     … 300dpi グレー、わずかに傾け、JPEG（スキャン相当）
       作業フォルダ/fax/<名前>.pdf      … 横200×縦100dpi 白黒二値、点状の雑音、わずかに傾ける（標準モードの FAX 相当）
  2) 設定ごとに mimi-ocr にかける（作業フォルダ/runs/<設定>/<条件>/<名前>_paged.md）
     python benchmark/bench.py run <作業フォルダ> <設定> [--cond scan,fax] [--jobs 2] -- <ocr.js の引数...>
       例: run work hint-lite -- --ndlocr_hint --model gemini-3.1-flash-lite --batch_size 1 --mode sync --target houhi
  3) 採点する
     python benchmark/bench.py score <作業フォルダ> [<設定> ...]
  4) 食い違いの中身を見る（数字と、4字以上の抜け・足し）
     python benchmark/bench.py detail <作業フォルダ> <設定> <scan|fax> <名前>

物差し（どれも NFKC にして、空白・記号・句読点を除いた字で数える）
  欠落%  正解の3文字組のうち、出力に無い割合（並び順に左右されない）
  余分%  出力の3文字組のうち、正解に無い割合（作文・重複・頁のずれ込み）
  長い欠落/長い余分  並びを突き合わせて、10字以上続けて抜けた所／足された所の数（表の書類では数えない）
  数字   正解の数字の並び（3桁以上の連続や日付の数）のうち、出力に無いもの
  失敗頁 [ERROR: OCR Failed] の頁、補正なし採用（mimi-ocr-fallback）の頁
  費用   末尾の metadata の usage（入出力トークンと概算ドル）。mimi-ocr 0.2 以降
"""
import collections
import concurrent.futures
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.request
from io import BytesIO
from pathlib import Path

import fitz
import numpy as np
from PIL import Image

LONG_RUN = 10
CONDITIONS = {"scan": (300, 0.35), "fax": (200, -0.55)}
REPO = Path(__file__).resolve().parent.parent
CORPUS = Path(__file__).resolve().parent / "corpus"


def render(src_pdf, out_pdf, cond):
    dpi, angle = CONDITIONS[cond]
    src = fitz.open(src_pdf)
    dst = fitz.open()
    for index, page in enumerate(src):
        pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
        img = Image.frombytes("L", (pix.width, pix.height), pix.samples)
        img = img.rotate(angle if index % 2 == 0 else -angle, resample=Image.BICUBIC, fillcolor=255)
        buf = BytesIO()
        if cond == "fax":
            # 標準モードの FAX（縦 100dpi）に寄せ、二値にして点状の雑音を少し入れる
            w, h = img.size
            img = img.resize((w, h // 2), Image.BILINEAR).resize((w, h), Image.NEAREST)
            bw = np.array(img) > 150
            rng = np.random.default_rng(index + 1)
            flip = rng.random(bw.shape) < 0.002
            bw[flip] = ~bw[flip]
            Image.fromarray((bw * 255).astype(np.uint8)).convert("1").save(buf, format="PNG")
        else:
            img.save(buf, format="JPEG", quality=80)
        new_page = dst.new_page(width=page.rect.width, height=page.rect.height)
        new_page.insert_image(new_page.rect, stream=buf.getvalue())
    dst.save(out_pdf, garbage=3, deflate=True)


def fetch(work):
    """corpus.json の公開 PDF を 作業フォルダ/src に取る。リポジトリには入れない。"""
    work = Path(work)
    (work / "src").mkdir(parents=True, exist_ok=True)
    corpus = json.loads((CORPUS / "corpus.json").read_text(encoding="utf-8"))
    for item in corpus["documents"]:
        dest = work / "src" / f"{item['name']}.pdf"
        if item.get("url"):
            if dest.exists():
                print(f"{item['name']}: 取得済み")
                continue
            req = urllib.request.Request(item["url"], headers={"User-Agent": "mimi-ocr-benchmark"})
            with urllib.request.urlopen(req, timeout=60) as res, open(dest, "wb") as out:
                shutil.copyfileobj(res, out)
            print(f"{item['name']}: {dest.stat().st_size:,} bytes ← {item['url']}")
        else:
            print(f"{item['name']}: {item.get('make', '手元で作る')} → {dest}")


def prepare(work, specs):
    work = Path(work)
    for sub in ("truth", *CONDITIONS):
        (work / sub).mkdir(parents=True, exist_ok=True)
    if not specs:
        specs = [f"{p.stem}={p}" for p in sorted((work / "src").glob("*.pdf"))]
    for spec in specs:
        name, pdf = spec.split("=", 1)
        doc = fitz.open(pdf)
        pages = [page.get_text() for page in doc]
        (work / "truth" / f"{name}.json").write_text(
            json.dumps({"source": str(pdf), "pages": pages}, ensure_ascii=False, indent=1), encoding="utf-8")
        for cond in CONDITIONS:
            render(pdf, work / cond / f"{name}.pdf", cond)
        print(f"{name}: {len(pages)} 頁")


def run(work, setting, argv):
    """設定ごとに dist/src/ocr.js を回す。出来ている出力は飛ばす（途中から再開できる）。"""
    work = Path(work)
    conds = list(CONDITIONS)
    jobs = 2
    ocr_args = []
    i = 0
    while i < len(argv):
        if argv[i] == "--cond":
            conds = argv[i + 1].split(",")
            i += 2
        elif argv[i] == "--jobs":
            jobs = int(argv[i + 1])
            i += 2
        elif argv[i] == "--":
            ocr_args = argv[i + 1:]
            break
        else:
            raise SystemExit(f"知らない引数: {argv[i]}")
    names = [p.stem for p in sorted((work / "truth").glob("*.json"))]
    # 測定中にソースを作り直しても影響しないよう、MIMI_BENCH_DIST で dist の写しを指せる（リポジトリの中に置く）
    ocr_js = Path(os.environ.get("MIMI_BENCH_DIST") or (REPO / "dist")) / "src" / "ocr.js"
    if not ocr_js.exists():
        raise SystemExit("dist/src/ocr.js がありません。先に npm run build")
    tasks = []
    for cond in conds:
        folder = work / "runs" / setting / cond
        folder.mkdir(parents=True, exist_ok=True)
        for name in names:
            if (folder / f"{name}_paged.md").exists():
                continue
            pdf = folder / f"{name}.pdf"
            shutil.copyfile(work / cond / f"{name}.pdf", pdf)
            tasks.append((cond, name, pdf, folder / f"{name}.log"))

    def one(task):
        cond, name, pdf, log = task
        started = time.time()
        with open(log, "w", encoding="utf-8") as out:
            code = subprocess.call(["node", str(ocr_js), str(pdf), *ocr_args], stdout=out, stderr=subprocess.STDOUT,
                                   cwd=str(REPO))
        return cond, name, code, time.time() - started

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        for cond, name, code, secs in pool.map(one, tasks):
            print(f"{setting}/{cond}/{name}: exit={code} {secs:.0f}秒", flush=True)


def norm(text):
    text = unicodedata.normalize("NFKC", text)
    return "".join(ch for ch in text if unicodedata.category(ch)[0] not in "PSZC")


def read_metadata(text):
    matches = re.findall(r"<!-- mimi-ocr-settings\n([\s\S]*?)\n-->", text)
    if not matches:
        return {}
    try:
        return json.loads(matches[-1].replace("\\u002d", "-"))
    except json.JSONDecodeError:
        return {}


def read_output(path):
    raw = path.read_text(encoding="utf-8")
    meta = read_metadata(raw)
    text = re.sub(r"<!--[\s\S]*?-->", "", raw)
    pages = {}
    errors = len(re.findall(r"\[ERROR: OCR Failed", text))
    fallback = len(re.findall(r"mimi-ocr-fallback", raw))
    # モデルは「### -- Begin Page 2 (Continuation) --」「### -- End (Printed Page 1) --」のように
    # 区切りを崩して書くことがある。mimi-ocr の読み込み（/### -- Begin Page (\d+)/）と同じく緩く拾う。
    parts = re.split(r"^### -- Begin Page (\d+)\b.*$", text, flags=re.M)
    if len(parts) == 1:
        # ndlocr のみの出力は「----- Page N -----」で区切る
        parts = re.split(r"^----- Page (\d+) -----\s*$", text, flags=re.M)
    for i in range(1, len(parts), 2):
        body = re.sub(r"^### -- End\b.*$", "", parts[i + 1], flags=re.M)
        pages[int(parts[i])] = pages.get(int(parts[i]), "") + body
    return pages, errors, fallback, meta


def trigrams(text):
    return collections.Counter(text[i:i + 3] for i in range(len(text) - 2))


def numbers(text):
    text = unicodedata.normalize("NFKC", text)
    return collections.Counter(re.findall(r"\d{3,}|\d+年\d+月\d+日|\d+月\d+日", re.sub(r"\s", "", text)))


def long_runs(truth, out):
    missing = extra = 0
    sm = difflib.SequenceMatcher(None, truth, out, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag in ("delete", "replace") and i2 - i1 >= LONG_RUN:
            missing += 1
        if tag in ("insert", "replace") and j2 - j1 >= LONG_RUN:
            extra += 1
    return missing, extra


def score_doc(truth_pages, out_path, table):
    out_pages, errors, fallback, meta = read_output(out_path)
    truth = norm("".join(truth_pages))
    out = norm("".join(out_pages[k] for k in sorted(out_pages)))
    t3, o3 = trigrams(truth), trigrams(out)
    common = sum((t3 & o3).values())
    miss = 1 - common / max(1, sum(t3.values()))
    extra = 1 - common / max(1, sum(o3.values()))
    tn, on = numbers("".join(truth_pages)), numbers("".join(out_pages.values()))
    num_missing = sum((tn - on).values())
    runs = (None, None) if table else long_runs(truth, out)
    usage = meta.get("usage") or {}
    return {"miss": miss, "extra": extra, "runs": runs, "num": (num_missing, sum(tn.values())),
            "errors": errors, "fallback": fallback, "chars": len(truth),
            "cost": float(usage.get("estimatedUsd") or 0)}


def score(work, settings):
    work = Path(work)
    truths = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted((work / "truth").glob("*.json"))}
    run_root = work / "runs"
    settings = settings or sorted(p.name for p in run_root.iterdir() if p.is_dir())
    summary = []
    for setting in settings:
        print(f"\n## {setting}")
        print("| 条件 | 書類 | 欠落% | 余分% | 長い欠落 | 長い余分 | 数字の誤り | 失敗頁 | 補正なし |")
        print("|---|---|---:|---:|---:|---:|---:|---:|---:|")
        tot = collections.defaultdict(float)
        for cond in CONDITIONS:
            for name, truth in truths.items():
                folder = run_root / setting / cond
                out = next((p for p in (folder / f"{name}_paged.md", folder / f"{name}_ERROR_paged.md") if p.exists()), None)
                if out is None:
                    print(f"| {cond} | {name} | (出力なし) | | | | | | |")
                    continue
                table = "表" in name or "証拠説明書" in name
                r = score_doc(truth["pages"], out, table)
                runs = "-" if table else f"{r['runs'][0]}"
                runs_x = "-" if table else f"{r['runs'][1]}"
                print(f"| {cond} | {name} | {r['miss'] * 100:.2f} | {r['extra'] * 100:.2f} | {runs} | {runs_x} | "
                      f"{r['num'][0]}/{r['num'][1]} | {r['errors']} | {r['fallback']} |")
                w = r["chars"]
                tot["w"] += w
                tot["miss"] += r["miss"] * w
                tot["extra"] += r["extra"] * w
                tot["runs_m"] += 0 if table else r["runs"][0]
                tot["runs_x"] += 0 if table else r["runs"][1]
                tot["num_m"] += r["num"][0]
                tot["num_t"] += r["num"][1]
                tot["errors"] += r["errors"]
                tot["fallback"] += r["fallback"]
                tot["cost"] += r["cost"]
        if tot["w"]:
            summary.append((setting, tot))
    print("\n## まとめ（字数で重み付け）")
    print("| 設定 | 欠落% | 余分% | 長い欠落 | 長い余分 | 数字の誤り | 失敗頁 | 補正なし | 概算費用(USD) |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for setting, t in summary:
        print(f"| {setting} | {t['miss'] / t['w'] * 100:.2f} | {t['extra'] / t['w'] * 100:.2f} | {int(t['runs_m'])} | "
              f"{int(t['runs_x'])} | {int(t['num_m'])}/{int(t['num_t'])} | {int(t['errors'])} | {int(t['fallback'])} | "
              f"{t['cost']:.4f} |")


def detail(work, setting, cond, name, limit=12):
    """食い違いの中身: 出力に無い数字と、長く抜けた所・足された所（前後の文脈つき）。"""
    work = Path(work)
    truth_pages = json.loads((work / "truth" / f"{name}.json").read_text(encoding="utf-8"))["pages"]
    folder = work / "runs" / setting / cond
    out_path = next(p for p in (folder / f"{name}_paged.md", folder / f"{name}_ERROR_paged.md") if p.exists())
    out_pages, _, _, _ = read_output(out_path)
    tn, on = numbers("".join(truth_pages)), numbers("".join(out_pages.values()))
    print("出力に無い数字:", dict(tn - on))
    print("正解に無い数字:", dict(on - tn))
    truth = norm("".join(truth_pages))
    out = norm("".join(out_pages[k] for k in sorted(out_pages)))
    sm = difflib.SequenceMatcher(None, truth, out, autojunk=False)
    shown = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal" or max(i2 - i1, j2 - j1) < 4:
            continue
        print(f"[{tag}] …{truth[max(0, i1 - 8):i1]}［正解: {truth[i1:i2][:80]}］［出力: {out[j1:j2][:80]}］{truth[i2:i2 + 8]}…")
        shown += 1
        if shown >= int(limit):
            break


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 3 or sys.argv[1] not in ("fetch", "prepare", "run", "score", "detail"):
        print(__doc__)
        return
    cmd = sys.argv[1]
    if cmd == "fetch":
        fetch(sys.argv[2])
    elif cmd == "prepare":
        prepare(sys.argv[2], sys.argv[3:])
    elif cmd == "run":
        run(sys.argv[2], sys.argv[3], sys.argv[4:])
    elif cmd == "detail":
        detail(*sys.argv[2:7])
    else:
        score(sys.argv[2], sys.argv[3:])


if __name__ == "__main__":
    main()
