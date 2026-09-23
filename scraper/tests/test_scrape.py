"""Run with: python -m pytest scraper/tests  (or: python scraper/tests/test_scrape.py)"""
import datetime as dt
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import scrape  # noqa: E402

HTML = (HERE / "fixture_sections.html").read_text(encoding="utf-8")


def test_parse_sections():
    raw = scrape.parse_schedule(HTML)
    assert [r["crn"] for r in raw] == ["10190", "10195", "10350", "12001", "10322"]

    lec = raw[0]
    assert (lec["subj"], lec["num"], lec["group"]) == ("CS", "201", "A")
    assert lec["credits"] == 4.0 and lec["schedule_type"] == "Lecture"
    assert lec["levels"] == "Undergraduate"
    assert lec["instructors"] == ["Saima Gül"]
    assert lec["meetings"][0] == {"days": [1], "start": 520, "end": 570, "place": "FENS G077"}
    assert lec["meetings"][1] == {"days": [2], "start": 700, "end": 810, "place": "FENS G077"}

    rec = raw[1]
    assert rec["num"] == "201R" and rec["instructors"] == ["Saima Gül", "Ali Veli"]
    assert rec["meetings"][0]["place"] == "FMAN G060"
    assert (rec["meetings"][0]["start"], rec["meetings"][0]["end"]) == (1060, 1170)

    ee = raw[2]
    assert ee["title"] == "Signals - Systems & Control"   # hyphen inside the title
    assert ee["meetings"][0]["days"] == [0, 2]

    project = raw[3]
    assert project["group"] == "107" and project["instructors"] == []
    assert project["meetings"] == [{"days": [], "start": None, "end": None, "place": ""}]


def test_finalize_groups_components():
    data = scrape.finalize_term("202601", "Fall 2026-2027", scrape.parse_schedule(HTML), updated="x")
    by = {c["code"]: c for c in data["courses"]}
    cs = by["CS 201"]
    assert cs["title"] == "Programming Fundamentals" and cs["credits"] == 4 and cs["level"] == "UG"
    assert [c["type"] for c in cs["components"]] == ["", "R"]
    assert cs["components"][1]["label"] == "Recitation"

    ee = by["EE 311"]
    assert ee["level"] == "UG+GR"
    # Monday meets in two rooms at the same time -> merged into one meeting
    mon = [m for m in ee["components"][0]["sections"][0]["meetings"] if m[0] == 0]
    assert len(mon) == 1 and data["places"][mon[0][3]] == "FENS L030 / FENS L055"

    assert by["ENS 491"]["components"][0]["sections"][0]["tba"] == 1
    assert by["CIP 101"]["components"][0]["type"] == "N"


def test_helpers():
    assert scrape.term_name("202601") == "Fall 2026-2027"
    assert scrape.term_name("202503") == "Summer 2025-2026"
    # one term ahead first: in the autumn, spring is what people are about to register for
    assert scrape.current_terms(3, dt.date(2026, 9, 22)) == ["202602", "202601", "202503"]
    assert scrape.current_terms(2, dt.date(2027, 2, 1)) == ["202603", "202602"]
    assert scrape.current_terms(2, dt.date(2027, 6, 15)) == ["202701", "202603"]
    assert scrape.parse_days("TBA") == [] and scrape.parse_days("MWF") == [0, 2, 4]
    assert scrape.parse_minutes("12:40 pm") == 760 and scrape.parse_minutes("12:10 am") == 10


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
