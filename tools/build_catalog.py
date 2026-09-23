#!/usr/bin/env python3
"""
Build data/catalog.json: every course seen in any term in data/, with its latest title and
credits and the terms it ran in. The planner and the course panel read this one small file
instead of opening every term, so the archive can grow without slowing the app down.

  python tools/build_catalog.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def main():
    index = json.loads((DATA / "terms.json").read_text(encoding="utf-8"))
    catalog: dict[str, dict] = {}
    for term in sorted(index["terms"], key=lambda t: t["code"]):          # oldest first, newest wins
        path = DATA / f'{term["code"]}.json'
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        for course in data["courses"]:
            entry = catalog.setdefault(course["code"], {"terms": []})
            entry["title"] = course["title"]
            if course.get("credits") is not None:
                entry["credits"] = course["credits"]
            entry["terms"].append(term["code"])
    out = {"schema": 1, "terms": [t["code"] for t in index["terms"]], "courses": catalog}
    (DATA / "catalog.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(catalog)} courses across {len(out['terms'])} terms -> data/catalog.json")


if __name__ == "__main__":
    main()
