"""Run with: python scraper/tests/test_details.py"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import details  # noqa: E402

CATALOG = (HERE / "fixture_catalog.html").read_text(encoding="utf-8")
SYLLABUS = (HERE / "fixture_syllabus.html").read_text(encoding="utf-8")


def test_catalog_page():
    got = details.parse_catalog(CATALOG)
    assert got["desc"].startswith("Fixture description line one")
    assert "line two" in got["desc"]
    assert "SU Credits" not in got["desc"] and "2026 Fall" not in got["desc"]
    assert details.number_or_none(got["credits"]) == 3
    assert details.number_or_none(got["ects"]) == 6
    assert got["prereq"].startswith("CS 300")
    assert got.get("coreq") is None  # "-" is dropped


def test_syllabus_page():
    got = details.parse_labelled(SYLLABUS)
    assert got["desc"].startswith("Fixture syllabus description")
    assert got["objectives"].startswith("First objective")
    assert got["outcomes"].startswith("Outcome one")
    assert got["textbook"].startswith("Author")
    assert got["assessment"].startswith("Midterm")
    assert got["language"] == "English"


def test_urls():
    assert details.syllabus_url("202601", "CS", "412", "B") == (
        "https://apps.sabanciuniv.edu/courses/syllabus/view.php"
        "?term=202601&sc=CS&cn=412&section=B&view=su")
    assert details.catalog_url("CS", "412", False).endswith("/lisans/ders-katalogu/course/CS-412")
    assert details.catalog_url("IT", "580", True).endswith("/lisansustu/ders-katalogu/course/IT-580")
    assert details.is_graduate("580") and not details.is_graduate("412")


def test_degree_page():
    import programs
    got = programs.parse_page((HERE / "fixture_degree.html").read_text(encoding="utf-8"))
    kinds = [g["kind"] for g in got["groups"]]
    assert kinds == ["university", "required", "core", "area", "free"], kinds
    core = got["groups"][2]
    assert core["credits"] == 18 and core["ects"] == 36 and core["minCourses"] == 6
    assert core["courses"] == ["EE 311", "EE 313"]
    assert got["groups"][3]["courses"] == ["EE 401", "CS 412"]
    assert got["groups"][4].get("any") is True
    assert got["credits"]["EE 202"] == [4, 7]
    assert got["totalCredits"] == 125 and got["totalEcts"] == 240
    assert "BSEE" in got["title"]


def test_seats_page():
    import seats
    got = seats.parse_detail((HERE / "fixture_detail.html").read_text(encoding="utf-8"))
    assert got == {"seats": [120, 117, 3], "waitlist": [10, 0, 10]}, got
    assert seats.parse_detail("<html><body>no table</body></html>") is None


def test_area_courses_parser():
    import programs
    codes = programs.parse_area_courses((HERE / "fixture_area_courses.html").read_text(encoding="utf-8"))
    assert codes == ["EE 311", "EE 313", "EE 401", "CS 412"], codes


def test_fill_area_courses():
    import programs

    calls = []

    class FakeResp:
        def __init__(self, text):
            self.text = text

        def raise_for_status(self):
            pass

    class FakeSession:
        def get(self, url, timeout=None):
            calls.append(url)
            if "FAC=E" in url:
                return FakeResp("<table><tr><td>MATH 305</td></tr></table>")
            if "FAC=S" in url:
                return FakeResp("<table><tr><td>HUM 207</td></tr></table>")
            if "FC_SOM" in url:
                return FakeResp("")
            if "FC_SBS" in url:
                return FakeResp("<table><tr><td>ECON 301</td></tr></table>")
            if "BSEE_CEL" in url:
                return FakeResp("<table><tr><td>EE 311</td></tr><tr><td>EE 313</td></tr></table>")
            if "BSEE_ARE" in url:
                return FakeResp("<table><tr><td>EE 401</td></tr></table>")
            return FakeResp("")

    groups = [
        {"name": "Core Electives", "kind": "core", "courses": []},
        {"name": "Area Electives", "kind": "area", "courses": []},
        {"name": "Free Electives", "kind": "free", "courses": []},
        {"name": "Faculty Courses", "kind": "faculty", "courses": []},
        {"name": "Required Courses", "kind": "required", "courses": ["EE 202"]},  # already filled -> must be left alone
    ]
    programs.fill_area_courses(FakeSession(), "202401", "BSEE", groups, delay=0)
    by_kind = {g["kind"]: g["courses"] for g in groups}
    assert by_kind["core"] == ["EE 311", "EE 313"]
    assert by_kind["area"] == ["EE 401"]
    assert by_kind["free"] == []                                    # genuinely empty area: no crash, stays empty
    assert set(by_kind["faculty"]) == {"MATH 305", "HUM 207", "ECON 301"}   # FC_SOM empty -> FC_SBS fallback used
    assert by_kind["required"] == ["EE 202"]                         # never re-fetched once already populated
    assert not any("BSEE_REQ" in c for c in calls)                   # confirms it really was skipped, not just coincidence


def test_kind_of_basic_science_engineering():
    import programs
    assert programs.kind_of("Basic Science Courses") == "basicscience"
    assert programs.kind_of("Engineering") == "engineering"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
