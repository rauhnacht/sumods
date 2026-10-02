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
        def get(self, url, timeout=None, headers=None):
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


def test_area_codes_come_from_the_degree_page():
    """Programmes don't all name areas <PROGRAM>_ARE/_FRE — BSCS 500'd on those. The degree
    page links each area's list itself, so those real codes must be used, never the guesses."""
    import programs

    parsed = programs.parse_page((HERE / "fixture_degree_links.html").read_text(encoding="utf-8"))
    assert [l["area"] for l in parsed["links"]] == ["BSCS_CEL", "BSCS_AEL", "BSCS_FEL", "FC_FENS", "FC_FASS", "FC_SBS"]
    calls = []

    class R:
        def __init__(self, text, code=200):
            self.text, self.code = text, code

        def raise_for_status(self):
            if self.code >= 500:
                raise Exception("500 Server Error")

    class S:
        def get(self, url, timeout=None, headers=None):
            area = url.split("P_AREA=")[1].split("&")[0]
            calls.append(area)
            lists = {"BSCS_CEL": "CS 301", "BSCS_AEL": "CS 412", "BSCS_FEL": "HUM 207",
                     "FC_FENS": "MATH 306", "FC_FASS": "ECON 201", "FC_SBS": "MGMT 201"}
            if area in lists:
                return R(f"<table><tr><td>{lists[area]}</td></tr></table>")
            return R("", 500)

    programs.fill_area_courses(S(), "202401", "BSCS", parsed["groups"], 0, parsed["links"])
    by = {g["kind"]: g["courses"] for g in parsed["groups"]}
    assert by["area"] == ["CS 412"] and by["free"] == ["HUM 207"]
    assert set(by["faculty"]) == {"MATH 306", "ECON 201", "MGMT 201"}
    assert "BSCS_ARE" not in calls and "BSCS_FRE" not in calls


def test_syllabus_engineering_basic_science():
    import details
    column = """<table><tr><th>SU Credit</th><th>ECTS Credit</th><th>Basic Science</th><th>Engineering</th></tr>
      <tr><td>4</td><td>7</td><td>1</td><td>6</td></tr></table>"""
    got = details.parse_labelled(column)
    assert [details.number_or_none(got.get(k)) for k in ("credits", "ects", "basicscience", "engineering")] == [4, 7, 1, 6]
    labelled = "<p>ECTS: 6</p><p>Engineering: 4</p><p>Basic Science: 2</p>"
    got = details.parse_labelled(labelled)
    assert details.number_or_none(got.get("engineering")) == 4 and details.number_or_none(got.get("basicscience")) == 2


def test_details_covers_next_term_and_merges(tmp_path=None):
    import json, tempfile
    import details
    data = Path(tempfile.mkdtemp())
    course = lambda code: {"code": code, "components": [{"type": "", "sections": [{"crn": "1", "group": "A", "meetings": []}]}]}
    (data / "terms.json").write_text(json.dumps({"terms": [{"code": "202602"}, {"code": "202601"}, {"code": "202503"}]}))
    (data / "202601.json").write_text(json.dumps({"courses": [course("EE 202"), course("EE 311")]}))
    (data / "202602.json").write_text(json.dumps({"courses": [course("EE 202"), course("EE 412")]}))
    (data / "202503.json").write_text(json.dumps({"courses": [course("OLD 101")]}))
    fetched = []
    details.course_details = lambda session, term, c, dump=None, source="both": (
        fetched.append((term, c["code"])) or {"desc": "d", "ects": 6, "eng": 4, "bs": 2, "v": details.INFO_VERSION,
                                               "prereqCodes": [["EE 201"]] if c["code"] == "EE 412" else []})
    details.default_term = lambda index, data_dir: "202601"
    details.make_session = lambda: None
    details.time.sleep = lambda s: None
    try:
        details.main(["--data", str(data)])
    finally:
        import importlib
        importlib.reload(details)        # undo the stubs so later tests see the real module
    assert ("202602", "EE 412") in fetched, fetched                 # the next term is covered now
    assert ("202602", "EE 202") not in fetched                      # shared course reused, not re-fetched
    assert not any(t == "202503" for t, _ in fetched)                # finished terms are left alone
    merged = json.loads((data / "info-all.json").read_text())["courses"]
    assert set(merged) == {"EE 202", "EE 311", "EE 412"} and merged["EE 412"]["eng"] == 4
    spring = json.loads((data / "202602-info.json").read_text())["courses"]
    assert "202602" in spring["EE 202"]["syllabus"]["A"]            # reused entry gets this term's syllabus link


def test_banner_catalog_engineering_basic_science():
    import details
    number_first = ("<td>Diodes.<br>3.000 Credit hours<br>6.000 ECTS<br>6.000 Engineering ECTS<br>"
                    "0.000 Basic Science ECTS<br>Faculty of Engineering and Natural Sciences 2019</td>")
    got = details.parse_banner_catalog(number_first)
    assert {k: got.get(k) for k in ("ects", "engineering", "basicscience")} == {"ects": 6, "engineering": 6, "basicscience": 0}
    label_first = "<p>ECTS Credits: 7</p><p>Engineering Credits (ECTS): 6</p><p>Basic Science Credits (ECTS): 1</p>"
    got = details.parse_banner_catalog(label_first)
    assert {k: got.get(k) for k in ("ects", "engineering", "basicscience")} == {"ects": 7, "engineering": 6, "basicscience": 1}
    assert details.parse_banner_catalog("<title>Sign in to your account</title>") == {}


def test_real_banner_catalog_page():
    """A real bwckctlg page (EE 303, Fall 2026-2027): ECTS with its ENGINEERING:x / BASIC:y split in
    Course Attributes, plus description, credits and pre/corequisites."""
    import details
    got = details.parse_banner_catalog((HERE / "fixture_banner_catalog.html").read_text(encoding="utf-8"))
    assert (got["credits"], got["ects"], got["engineering"], got["basicscience"]) == (3, 6, 6, 0), got
    assert got["desc"].startswith("DC, Small-signal") and "Fark-Yükselteci" not in got["desc"]
    assert details.parse_requirements(got["prereq"]) == [["EL 202", "EE 202"]]
    assert details.parse_requirements(got["coreq"]) == [["EE 303R"]]
    assert "Return to Previous" not in got["prereq"]

    class S:
        def get(self, url, timeout=None, headers=None):
            class R:
                status_code = 200
                text = (HERE / "fixture_banner_catalog.html").read_text(encoding="utf-8")
            assert "bwckctlg" in url, "the Banner catalog should answer before any other source"
            return R()
    course = {"code": "EE 303", "components": [{"type": "", "sections": [{"crn": "1", "group": "0", "meetings": []}]}]}
    info = details.course_details(S(), "202601", course)
    assert (info["eng"], info["bs"], info["ects"], info["credits"]) == (6, 0, 6, 3), info
    assert info["prereqCodes"] == [["EL 202", "EE 202"]] and info["source"] == "bannerweb"


class _Resp:
    status_code = 200

    def __init__(self, text="", code=200):
        self.text, self.code = text, code

    def raise_for_status(self):
        if self.code >= 500:
            raise Exception("500 Server Error")


def _list(*codes):
    return _Resp("<table>" + "".join(f"<tr><td>{c}</td></tr>" for c in codes) + "</table>")


def test_area_spellings_and_memory():
    """BSCS names its areas CEL/AEL/FEL; BSEE's were CEL/ARE/FRE. Both must work, the wrong one
    must cost one quick request (a 500 is how Banner says "no such area"), and the spelling that
    worked is tried first for the next entry term."""
    import programs
    programs.WORKING.clear()
    programs.HARD_FAIL.clear()
    calls = []

    class S:
        def get(self, url, timeout=None, headers=None):
            area = url.split("P_AREA=")[1].split("&")[0]
            calls.append(area)
            known = {"BSCS_CEL": ["CS 301"], "BSCS_AEL": ["CS 412", "CS 408"], "BSCS_FEL": ["HUM 207"],
                     "BSEE_CEL": ["EE 311"], "BSEE_ARE": ["EE 401"], "BSEE_FRE": ["MATH 306"]}
            return _list(*known[area]) if area in known else _Resp("", 500)

    def groups():
        return [{"name": "Core Electives", "kind": "core", "courses": []},
                {"name": "Area Electives", "kind": "area", "courses": []},
                {"name": "Free Electives", "kind": "free", "courses": []}]

    g = groups()
    programs.fill_area_courses(S(), "202601", "BSCS", g, 0)
    assert [x["courses"] for x in g] == [["CS 301"], ["CS 412", "CS 408"], ["HUM 207"]]
    assert "BSCS_ARE" not in calls and "BSCS_FRE" not in calls          # the standard spelling answered first

    calls.clear()
    g = groups()
    programs.fill_area_courses(S(), "202601", "BSEE", g, 0)
    assert [x["courses"] for x in g] == [["EE 311"], ["EE 401"], ["MATH 306"]]
    assert calls.count("BSEE_AEL") == 1 and calls.count("BSEE_FEL") == 1   # one failed try each, then the fallback

    calls.clear()
    programs.fill_area_courses(S(), "202501", "BSEE", groups(), 0)         # next entry term
    assert "BSEE_AEL" not in calls and "BSEE_FEL" not in calls              # remembered: ARE/FRE go first
    assert calls == ["BSEE_CEL", "BSEE_ARE", "BSEE_FRE"], calls


def test_double_major_programmes():
    import programs
    assert "BSCS-DM" in programs.all_programmes() and programs.all_programmes()[:12] == list(programs.PROGRAMS)
    assert programs.base_of("BSCS-DM") == "BSCS" and programs.base_of("BSCS") == "BSCS"
    assert programs.programme_name("BSCS-DM") == "Computer Science and Engineering (Double Major)"
    assert "P_PROGRAM=BSCS-DM&" in programs.URL.format(term="202601", program="BSCS-DM")
    assert programs.area_candidates("BSCS", "area") == ["BSCS_AEL", "BSCS_ARE"]
    assert programs.area_candidates("BSCS-DM", "core") == ["BSCS-DM_CEL", "BSCS_CEL"]

    programs.WORKING.clear()
    programs.HARD_FAIL.clear()
    urls = []

    class S:
        def get(self, url, timeout=None, headers=None):
            urls.append(url)
            return _list("CS 301") if "P_AREA=BSCS_CEL" in url else _Resp("", 500)

    g = [{"name": "Core Electives", "kind": "core", "courses": []}]
    programs.fill_area_courses(S(), "202601", "BSCS-DM", g, 0)
    assert g[0]["courses"] == ["CS 301"]
    assert all("P_PROGRAM=BSCS-DM" in u for u in urls), urls              # always asks as the double major
    assert "P_AREA=BSCS-DM_CEL" in urls[0] and "P_AREA=BSCS_CEL" in urls[1]


def test_double_major_that_does_not_exist_is_dropped_quickly():
    import json
    import tempfile
    import programs
    data = Path(tempfile.mkdtemp())
    (data / "terms.json").write_text(json.dumps({"terms": [{"code": "202601"}]}))
    page = (HERE / "fixture_degree.html").read_text(encoding="utf-8")
    seen = []

    class S:
        def get(self, url, timeout=None, headers=None):
            seen.append(url)
            if "p_degree_detail" in url:
                return _Resp(page) if "P_PROGRAM=BSCS&" in url else _Resp("", 500)
            return _list("CS 301")

    real = (programs.make_session, programs.make_probe_session)
    programs.make_session = programs.make_probe_session = lambda: S()
    try:
        programs.main(["--data", str(data), "--delay", "0", "--programs", "BSCS", "BSCS-DM",
                       "--entries", "202601", "202501", "202401", "202301", "202201", "202101"])
    finally:
        programs.make_session, programs.make_probe_session = real
    dm_pages = [u for u in seen if "p_degree_detail" in u and "BSCS-DM" in u]
    assert len(dm_pages) == 3, len(dm_pages)                                # gave up after three misses
    assert (data / "programs" / "BSCS.json").exists() and not (data / "programs" / "BSCS-DM.json").exists()
    codes = [p["code"] for p in json.loads((data / "programs" / "index.json").read_text())["programs"]]
    assert codes == ["BSCS"], codes                                         # no empty "BSCS-DM" in the list


def test_area_links_found_in_scripts_and_with_new_suffixes():
    """Links that aren't plain <a href>s (an onclick, an inline script) are still found, a link's own
    P_PROGRAM is kept, and AEL / FEL are recognised as area / free."""
    import programs
    page = """<html><body><table>
      <tr><td colspan=4><b>SUMMARY OF DEGREE REQUIREMENTS</b></td></tr>
      <tr><th></th><th>Minimum SU Credits</th></tr>
      <tr><td>Core Electives</td><td>18</td></tr>
      <tr><td>Area Electives</td><td>9</td></tr>
      <tr><td>Free Electives</td><td>12</td></tr>
      <tr><td>Quantum Credit</td><td>4</td></tr>
      </table>
      <button onclick="go('SU_DEGREE.p_list_courses?P_TERM=202601&amp;P_AREA=BSMAT_CEL&amp;P_PROGRAM=BSMAT-DM&amp;P_LANG=EN')">x</button>
      <script>var u = "SU_DEGREE.p_list_courses?P_TERM=202601&P_AREA=BSMAT_AEL&P_PROGRAM=BSMAT&P_LANG=EN";
              var f = "SU_DEGREE.p_list_courses?P_TERM=202601&P_AREA=BSMAT_FEL&P_PROGRAM=BSMAT&P_LANG=EN";
              var s = "SU_DEGREE.p_list_courses?P_TERM=202601&P_AREA=FC_FENS&P_PROGRAM=BSMAT&P_FAC=E&P_LANG=EN";</script>
      </body></html>"""
    parsed = programs.parse_page(page)
    found = {(l["area"], l["kind"], l["fac"], l["program"]) for l in parsed["links"]}
    assert ("BSMAT_CEL", "core", "", "BSMAT-DM") in found, found
    assert ("BSMAT_AEL", "area", "", "BSMAT") in found and ("BSMAT_FEL", "free", "", "BSMAT") in found
    assert ("FC_FENS", "faculty", "E", "BSMAT") in found
    assert parsed["unrecognised"] == ["Quantum Credit"], parsed["unrecognised"]

    asked = []

    class S:
        def get(self, url, timeout=None, headers=None):
            asked.append(url)
            return _list("MAT 301")

    g = [{"name": "Core Electives", "kind": "core", "courses": []}]
    programs.fill_area_courses(S(), "202601", "BSMAT-DM", g, 0, parsed["links"])
    assert g[0]["courses"] == ["MAT 301"] and "P_AREA=BSMAT_CEL" in asked[0] and "P_PROGRAM=BSMAT-DM" in asked[0], asked


def test_summary_and_probe():
    import json
    import tempfile
    import programs
    data = Path(tempfile.mkdtemp())
    (data / "programs").mkdir()
    full = {"groups": [{"kind": k, "name": k, "courses": ["X 101"]} for k in programs.EXPECTED_KINDS]}
    thin = {"groups": [{"kind": "university", "name": "u", "courses": ["X 101"]},
                       {"kind": "required", "name": "r", "courses": ["X 102"]},
                       {"kind": "core", "name": "c", "courses": []}, {"kind": "free", "name": "f", "any": True, "courses": []}]}
    (data / "programs" / "BSCS.json").write_text(json.dumps({"entries": {"202501": full, "202601": {"sameAs": "202501"}}}))
    (data / "programs" / "BSMAT.json").write_text(json.dumps({"entries": {"202601": thin}}))
    (data / "programs" / "overrides.json").write_text("{}")
    lines = programs.summarise(data)
    assert len(lines) == 2 and "core=1" in lines[0] and "MISSING" not in lines[0], lines
    assert "core=0 EMPTY" in lines[1] and "area=MISSING" in lines[1] and "free=0" in lines[1] and "free=0 EMPTY" not in lines[1], lines

    class R:
        def __init__(self, code, text=""):
            self.status_code, self.text = code, text

    class S:
        def get(self, url, timeout=None, headers=None):
            if "p_degree_detail" in url:
                return R(200, (HERE / "fixture_degree.html").read_text(encoding="utf-8"))
            return R(200, "<table><tr><td>CS 301</td></tr></table>") if "P_AREA=BSCS_CEL" in url else R(500)

    real = programs.make_probe_session
    programs.make_probe_session = lambda: S()
    time_sleep, programs.time.sleep = programs.time.sleep, lambda x: None
    try:
        out = "\n".join(programs.probe("BSCS", "202601"))
    finally:
        programs.make_probe_session, programs.time.sleep = real, time_sleep
    assert "HTTP 200" in out and "group  core" in out and "-> HTTP 200, 1 course rows" in out and "-> HTTP 500" in out, out


def test_unknown_area_names_are_asked_once_per_run():
    import programs
    programs.WORKING.clear()
    programs.HARD_FAIL.clear()
    asked = []

    class S:
        def get(self, url, timeout=None, headers=None):
            asked.append(url.split("P_AREA=")[1].split("&")[0])
            return _Resp("", 500) if "BSCS-DM_" in url else _Resp("<table></table>")   # DM names unknown, base names answer empty

    def groups():
        return [{"name": "Core Electives", "kind": "core", "courses": []}]

    programs.fill_area_courses(S(), "202601", "BSCS-DM", groups(), 0)
    first = list(asked)
    asked.clear()
    programs.fill_area_courses(S(), "202501", "BSCS-DM", groups(), 0)
    assert first == ["BSCS-DM_CEL", "BSCS_CEL"], first
    assert asked == [], asked              # neither the unknown name nor the empty answer is asked again


def test_double_major_borrows_the_majors_lists():
    import json
    import tempfile
    import programs
    out = Path(tempfile.mkdtemp())
    (out / "BSCS.json").write_text(json.dumps({"entries": {
        "202501": {"groups": [{"kind": "core", "name": "Core Electives", "courses": ["CS 301", "CS 306"]},
                              {"kind": "area", "name": "Area Electives", "courses": ["CS 412"]},
                              {"kind": "free", "name": "Free Electives", "courses": ["HUM 207"]}]},
        "202601": {"sameAs": "202501"}}}))
    groups = [{"kind": "core", "name": "Core Electives", "credits": 9, "courses": []},
              {"kind": "area", "name": "Area Electives", "courses": ["CS 999"]},          # already has its own list
              {"kind": "free", "name": "Free Electives", "any": True, "courses": []},
              {"kind": "required", "name": "Required", "courses": []}]
    took = programs.borrow_from_major(groups, "BSCS-DM", "202601", out)                    # follows sameAs
    assert took == ["core", "free"], took
    assert groups[0]["courses"] == ["CS 301", "CS 306"] and groups[0]["borrowed"] == "BSCS" and groups[0]["credits"] == 9
    assert groups[1]["courses"] == ["CS 999"] and "borrowed" not in groups[1]
    assert groups[2]["courses"] == ["HUM 207"] and groups[3]["courses"] == []
    assert programs.borrow_from_major(groups, "BSCS", "202601", out) == []                 # a normal major never borrows
    assert programs.borrow_from_major([{"kind": "core", "courses": []}], "BSMAT-DM", "202601", out) == []   # no major file yet


def test_rerunning_never_wipes_stored_entries():
    """The newest entry terms are re-fetched on every run. When one came back unchanged it used to be
    stored as sameAs *itself*, which erased the programme's data. Unchanged terms must stay full; a
    changed one must not drag the older terms that pointed at it along."""
    import contextlib
    import io
    import json
    import tempfile
    import programs
    data = Path(tempfile.mkdtemp())
    (data / "terms.json").write_text(json.dumps({"terms": [{"code": "202601"}]}))
    page = ("<html><body><table><tr><td colspan=3><b>SUMMARY OF DEGREE REQUIREMENTS</b></td></tr>"
            "<tr><th></th><th>Minimum SU Credits</th></tr><tr><td>Core Electives</td><td>18</td></tr></table></body></html>")
    state = {"core": ["CS 301"]}
    asked = []

    class S:
        def get(self, url, timeout=None, headers=None):
            asked.append(url)
            if "p_degree_detail" in url:
                return _Resp(page)
            return _list(*state["core"])

    real = (programs.make_session, programs.make_probe_session, programs.time.sleep)
    programs.make_session = programs.make_probe_session = lambda: S()
    programs.time.sleep = lambda x: None

    def run():
        programs.WORKING.clear()
        programs.HARD_FAIL.clear()
        asked.clear()
        with contextlib.redirect_stdout(io.StringIO()):
            programs.main(["--data", str(data), "--delay", "0", "--programs", "BSCS",
                           "--entries", "202601", "202501", "202401", "202301"])
        return json.loads((data / "programs" / "BSCS.json").read_text())["entries"], len(asked)

    try:
        first, n1 = run()
        assert "groups" in first["202601"] and all(first[t] == {"sameAs": "202601"} for t in ("202501", "202401", "202301"))
        again, n2 = run()                                     # nothing changed
        assert "groups" in again["202601"], again["202601"]    # still a full entry, not {"sameAs": "202601"}
        assert [t for t, e in again.items() if "sameAs" not in e] == ["202601"]
        assert n2 < n1, (n1, n2)                              # the old cohorts were skipped, only the two newest re-fetched
        state["core"] = ["CS 301", "CS 306"]                  # the newest cohorts' list grows
        third, _ = run()

        def core(term):                                       # what a student of that cohort would see
            e = third[term]
            for _ in range(10):
                if "sameAs" not in e:
                    break
                e = third[e["sameAs"]]
            return e["groups"][0]["courses"]

        assert core("202601") == ["CS 301", "CS 306"] and core("202501") == ["CS 301", "CS 306"]   # re-fetched, so both moved
        assert core("202401") == ["CS 301"] and core("202301") == ["CS 301"], third           # older cohorts keep the old content
        assert all("sameAs" in e or "groups" in e for e in third.values())
        assert all(e.get("sameAs") != t for t, e in third.items())                           # nothing points at itself
    finally:
        programs.make_session, programs.make_probe_session, programs.time.sleep = real


def test_kind_of_basic_science_engineering():
    import programs
    assert programs.kind_of("Basic Science Courses") == "basicscience"
    assert programs.kind_of("Engineering") == "engineering"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
