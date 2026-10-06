"""Offline check of the academic-calendar parser against a saved page layout.  Run: python3 scraper/tests/test_calendar.py"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import academic_calendar as ac  # noqa: E402

html = (HERE / "fixture_calendar.html").read_text(encoding="utf-8")
terms = {t["term"]: t for t in ac.terms_from(ac.parse_calendar(html), 2026)}
assert set(terms) == {"202601", "202602", "202603"}, terms.keys()
fall, spring, summer = terms["202601"], terms["202602"], terms["202603"]
assert [h["date"] for h in fall["holidays"]] == ["2026-10-29", "2027-01-01"], fall["holidays"]
days = [h["date"] for h in spring["holidays"]]
assert days[:5] == ["2027-03-08", "2027-03-09", "2027-03-10", "2027-03-11", "2027-03-12"], days
assert "2027-04-23" in days and "2027-05-19" in days and "2027-05-17" in days, days
assert len(days) == len(set(days)), "a date is listed twice"
assert "2027-03-06" not in days, "a make-up Saturday is a working day"
assert spring["holidays"][0]["name"] == "Ramazan Bayramı Tatili", spring["holidays"][0]
assert (fall["examsStart"], fall["examsEnd"]) == ("2027-01-04", "2027-01-13"), fall
assert (spring["examsStart"], spring["examsEnd"]) == ("2027-05-29", "2027-06-08"), spring
assert summer["holidays"] == [], summer
# make-up days and half-day holidays
assert fall["makeups"][0] == {"date": "2026-10-24", "source": [{"date": "2026-10-28", "from": "12:40"},
                                                              {"date": "2026-11-10", "from": "08:40", "to": "10:30"}]}, fall["makeups"]
assert [m["date"] for m in fall["makeups"]] == ["2026-10-24", "2026-10-31", "2026-12-26"], fall["makeups"]
assert fall["makeups"][2]["source"] == [{"date": "2027-01-01"}], "a make-up before the holiday names the date after it"
assert fall["partial"] == [{"date": "2026-10-28", "from": "12:40", "to": "23:59", "name": "Yarım gün tatil"},
                           {"date": "2026-11-10", "from": "08:40", "to": "10:30", "name": "Atatürk'ü Anma Töreni"}], fall["partial"]
assert [m["date"] for m in spring["makeups"]] == ["2027-03-20", "2027-03-06"], spring.get("makeups")
assert "makeups" not in summer
print("calendar parser: ok")
