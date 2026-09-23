#!/usr/bin/env python3
"""
Bundle index.html + app.css + app.js + data/ into one self-contained file
(dist/sumods.html) that works offline and can be published anywhere.

  python build_standalone.py                 # every term in data/terms.json
  python build_standalone.py --terms 202601  # just one term
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--terms", nargs="*", help="limit the bundle to these term codes")
    ap.add_argument("--out", default=str(ROOT / "dist" / "sumods.html"))
    args = ap.parse_args()

    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "app.css").read_text(encoding="utf-8")
    js = (ROOT / "app.js").read_text(encoding="utf-8")
    index = json.loads((ROOT / "data" / "terms.json").read_text(encoding="utf-8"))

    terms = [t for t in index["terms"] if not args.terms or t["code"] in args.terms]
    index = {**index, "terms": terms}
    programs_path = ROOT / "data" / "programs.json"
    programs_dir = ROOT / "data" / "programs"
    program_index = json.loads((programs_dir / "index.json").read_text(encoding="utf-8")) \
        if (programs_dir / "index.json").exists() else None
    program_files = {p.stem: json.loads(p.read_text(encoding="utf-8"))
                     for p in programs_dir.glob("*.json") if p.stem != "index"} if programs_dir.exists() else {}
    catalog_path = ROOT / "data" / "catalog.json"
    bundle = {
        "programIndex": program_index,
        "programFiles": program_files,
        "catalog": json.loads(catalog_path.read_text(encoding="utf-8")) if catalog_path.exists() else None,
        "programs": json.loads(programs_path.read_text(encoding="utf-8")).get("programs", [])
        if programs_path.exists() else [],
        "index": index,
        "terms": {t["code"]: json.loads((ROOT / "data" / f'{t["code"]}.json').read_text(encoding="utf-8"))
                  for t in terms},
        **{kind: {t["code"]: json.loads(p.read_text(encoding="utf-8"))
                  for t in terms if (p := ROOT / "data" / f'{t["code"]}-{kind}.json').exists()}
           for kind in ("info", "calendar", "exams", "regdays", "seats")},
    }
    data_js = json.dumps(bundle, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

    html = html.replace('<link rel="stylesheet" href="app.css">', f"<style>\n{css}\n</style>")
    html = html.replace('<script src="config.js"></script>', "")   # the bundle can't call out to a live service
    for tag in ('<link rel="manifest" href="manifest.webmanifest">',
                '<link rel="apple-touch-icon" href="icons/icon-192.png">',
                '<link rel="icon" href="icons/icon-192.png">'):
        html = html.replace(tag, "")
    html = html.replace('<script src="app.js"></script>',
                        f"<script>window.SUMODS_DATA={data_js};</script>\n<script>\n{js}\n</script>")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    kb = out.stat().st_size / 1024
    print(f"{out} — {kb:.0f} KB, terms: {', '.join(t['code'] for t in terms)}")


if __name__ == "__main__":
    main()
