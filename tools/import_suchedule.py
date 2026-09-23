#!/usr/bin/env python3
"""
Convert a SUchedule data file (github.com/aburakayaz/suchedule, data-vNN.min.json)
into the SUMods schema. Used to seed data/ before the BannerWeb scraper has run,
or as a fallback source.

SUchedule stores times as slot indices (0 = 08:40, one slot = 60 min, classes end
at :30), so converted data has standard SU slot times and no credit values.

Usage:
  python tools/import_suchedule.py data-v85.min.json 202601 --updated 2026-09-22T03:56:44Z
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scraper"))
from scrape import (  # noqa: E402
    TYPE_LABELS, finalize_term, term_name, write_term,
)


REPAIRS = {"Atat\ufffdrk": "Atatürk"}


def repair(text: str) -> str:
    """Older snapshots carry a few mis-decoded characters; fix the known ones, drop the rest."""
    for broken, fixed in REPAIRS.items():
        text = text.replace(broken, fixed)
    return text.replace("\ufffd", "")


def convert(src: dict, term: str, updated: str) -> dict:
    places = src.get("places", [])        # the earliest snapshots have no rooms
    instructors = src["instructors"]
    raw_sections = []  # same shape the scraper produces before finalize_term()

    for course in src["courses"]:
        base = course["code"].strip()
        subj, num = base.split(" ", 1)
        for cls in course["classes"]:
            ctype = cls["type"]
            for sec in cls["sections"]:
                meetings = []
                for m in sec["schedule"]:
                    start_slot, dur = m["start"], m["duration"]
                    place_index = m.get("place", -1)
                    place = repair(places[place_index]) if 0 <= place_index < len(places) else ""
                    if start_slot < 0 or dur < 0:
                        meetings.append({"days": [], "start": None, "end": None, "place": place})
                        continue
                    start = (8 + start_slot) * 60 + 40
                    end = start + dur * 60 - 10
                    meetings.append({"days": [m["day"]], "start": start, "end": end, "place": place})
                names = [repair(n).replace("(P)", "").strip() for n in instructors[sec["instructors"]].split(",")]
                raw_sections.append({
                    "title": repair(course["name"]),
                    "crn": sec["crn"],
                    "subj": subj,
                    "num": num + ctype,
                    "group": sec["group"],
                    "credits": None,
                    "levels": None,
                    "schedule_type": TYPE_LABELS.get(ctype),
                    "instructors": [n for n in names if n and n != "TBA"],
                    "meetings": meetings,
                })

    return finalize_term(term, term_name(term), raw_sections, updated=updated,
                         source="BannerWeb schedule via SUchedule's public snapshot")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("term")
    ap.add_argument("--updated", required=True, help="ISO timestamp of the snapshot")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data"))
    args = ap.parse_args()
    src = json.loads(Path(args.file).read_text(encoding="utf-8"))
    data = convert(src, args.term, args.updated)
    write_term(Path(args.out), data, keep_updated=False)
    print(f"{args.term}: {len(data['courses'])} courses written")


if __name__ == "__main__":
    main()
