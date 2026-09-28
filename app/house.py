"""The House page (/house): car and house upkeep, the family's contacts, and a printable sheet for a babysitter.

- Upkeep: each job has how often (every_months) and when it's next due. "Done" logs it and works out the next
  date: from the day it was done (oil change), or the same date every year (fixed = 1: winter tires).
  main._evening_message mentions a job remind_days before it's due, on the day, and every Monday while overdue.
- Contacts: phone numbers in groups. The kids' teachers (people.teacher / teacher_email) show up on their own.
- Sitter sheet: the contacts marked for the sitter, each kid's bedtime and medicine, and the family's notes.
Adults and phone-only sign-ins can use it (auth.member_allowed); the kids can't.
"""
import calendar
import json
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import auth, db

router = APIRouter(prefix="/api/house")

AREAS = ("car", "house", "yard", "other")
GROUPS = ("family", "emergency", "health", "school", "sitters", "other")
_tz = None


def set_tz(tz) -> None:
    global _tz
    _tz = tz


def today() -> date:
    return datetime.now(_tz).date()


def add_months(d: date, months: int) -> date:
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _next_on(month: int, day: int, t: date) -> str:
    d = date(t.year, month, day)
    return (d if d >= t else date(t.year + 1, month, day)).isoformat()


def seed(conn) -> None:
    """Common jobs, once. The ones counted from the last time have no date until it's filled in."""
    if conn.execute("SELECT 1 FROM settings WHERE key = 'upkeep_seeded'").fetchone():
        return
    t = today()
    jobs = [
        ("🛢️ Oil change", "car", 6, 0, None, 14, "Or every 8,000 km, whichever comes first"),
        ("❄️ Winter tires on", "car", 12, 1, _next_on(11, 1, t), 14, "Book the garage early; November fills up"),
        ("☀️ Summer tires on", "car", 12, 1, _next_on(5, 15, t), 14, ""),
        ("🌬️ Furnace / heat pump filter", "house", 3, 0, None, 7, ""),
        ("🚨 Test smoke and CO alarms", "house", 1, 0, None, 3, "Press the test button on each one"),
        ("🔋 Smoke and CO alarm batteries", "house", 12, 1, _next_on(11, 2, t), 7, "When the clocks go back"),
        ("🧺 Clean the dryer vent", "house", 12, 0, None, 7, ""),
        ("🍂 Clean the gutters", "yard", 12, 1, _next_on(10, 20, t), 7, ""),
    ]
    conn.executemany("INSERT INTO upkeep (title, area, every_months, fixed, due, remind_days, notes, sort) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [(*j, i) for i, j in enumerate(jobs)])
    conn.execute("INSERT INTO settings (key, value) VALUES ('upkeep_seeded', '1')")
    seed_emergency(conn)


# Emergency numbers by country (the holidays country from setup); anywhere else gets 112.
EMERGENCY = {
    "CA": [("Emergency", "Police, fire, ambulance", "911"), ("HealthLine", "A nurse, day or night", "811")],
    "US": [("Emergency", "Police, fire, ambulance", "911"), ("Poison Control", "Day or night", "1-800-222-1222")],
    "GB": [("Emergency", "Police, fire, ambulance", "999"), ("NHS 111", "Urgent but not an emergency", "111")],
    "IE": [("Emergency", "Police, fire, ambulance", "112")],
    "AU": [("Emergency", "Police, fire, ambulance", "000")],
    "NZ": [("Emergency", "Police, fire, ambulance", "111")],
}


def seed_emergency(conn) -> None:
    """The emergency numbers for the family's country, once the country is known (setup, or the first start after)."""
    country = db.get_setting(conn, "holiday_country").upper()
    if not country or conn.execute("SELECT 1 FROM settings WHERE key = 'emergency_seeded'").fetchone():
        return
    rows = EMERGENCY.get(country, [("Emergency", "Police, fire, ambulance", "112")])
    conn.executemany("INSERT INTO contacts (name, role, grp, phone, notes, sitter, sort) VALUES (?, ?, 'emergency', ?, ?, 1, ?)",
                     [(n, r, ph, "Say the address first" if i == 0 else "", i) for i, (n, r, ph) in enumerate(rows)])
    conn.execute("INSERT INTO settings (key, value) VALUES ('emergency_seeded', '1')")


def _who(request: Request) -> int | None:
    return auth.member_id(auth.cookie_role(request.cookies.get(auth.COOKIE)))


def _status(job: dict, t: date) -> dict:
    if not job["due"]:
        return {**job, "days": None, "state": "unknown"}
    days = (date.fromisoformat(job["due"]) - t).days
    state = "overdue" if days < 0 else "soon" if days <= job["remind_days"] else "ok"
    return {**job, "days": days, "state": state}


def jobs(conn, t: date | None = None) -> list[dict]:
    t = t or today()
    rows = db.rows(conn.execute(
        "SELECT u.*, (SELECT MAX(done) FROM upkeep_log l WHERE l.upkeep_id = u.id) AS last_done "
        "FROM upkeep u WHERE u.active = 1 ORDER BY u.due IS NULL, u.due, u.sort, u.id"))
    return [_status(r, t) for r in rows]


def reminders(conn, t: date) -> list[str]:
    """Lines for the 8 pm check about day t (tomorrow): a job remind_days ahead, on the day, and on Mondays while overdue."""
    out = []
    for j in jobs(conn, t):
        d = j["days"]
        if d is None:
            continue
        name = j["title"] + (f" ({j['what']})" if j["what"] else "")
        name = ("🔧 " + name) if name[:1].isalnum() else name
        if d == j["remind_days"] and d > 0:
            out.append(f"{name}: due in {d} days ({date.fromisoformat(j['due']):%b} {date.fromisoformat(j['due']).day})")
        elif d == 0:
            out.append(f"{name}: due tomorrow")
        elif d < 0 and t.weekday() == 0:
            weeks = -d // 7
            out.append(f"{name}: overdue" + (f" by {weeks} week{'s' if weeks != 1 else ''}" if weeks else ""))
    return out


class UpkeepIn(BaseModel):
    title: str
    area: str = "house"
    what: str = ""
    every_months: int | None = None
    fixed: bool = False
    due: str | None = None
    remind_days: int = 7
    notes: str = ""


def _clean_job(u: UpkeepIn) -> tuple:
    if not u.title.strip():
        raise HTTPException(400, "give it a name")
    if u.area not in AREAS:
        raise HTTPException(400, "bad area")
    if u.every_months is not None and not 1 <= u.every_months <= 120:
        raise HTTPException(400, "every 1 to 120 months")
    if u.due:
        try:
            date.fromisoformat(u.due)
        except ValueError:
            raise HTTPException(400, "bad date")
    return (u.title.strip()[:80], u.area, u.what.strip()[:40], u.every_months, int(u.fixed), u.due or None,
            max(0, min(u.remind_days, 60)), u.notes.strip()[:300])


@router.get("/upkeep")
def list_upkeep():
    with db.db() as conn:
        items = jobs(conn)
        log = db.rows(conn.execute(
            "SELECT l.*, u.title, p.name AS by_name FROM upkeep_log l JOIN upkeep u ON u.id = l.upkeep_id "
            "LEFT JOIN people p ON p.id = l.by_person ORDER BY l.done DESC, l.id DESC LIMIT 40"))
    return {"jobs": items, "log": log, "today": today().isoformat()}


@router.post("/upkeep")
def add_upkeep(u: UpkeepIn):
    with db.db() as conn:
        sort = conn.execute("SELECT COALESCE(MAX(sort), 0) + 1 FROM upkeep").fetchone()[0]
        cur = conn.execute("INSERT INTO upkeep (title, area, what, every_months, fixed, due, remind_days, notes, sort) "
                           "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (*_clean_job(u), sort))
    return {"id": cur.lastrowid}


@router.put("/upkeep/{uid}")
def edit_upkeep(uid: int, u: UpkeepIn):
    with db.db() as conn:
        conn.execute("UPDATE upkeep SET title = ?, area = ?, what = ?, every_months = ?, fixed = ?, due = ?, remind_days = ?, "
                     "notes = ? WHERE id = ?", (*_clean_job(u), uid))
    return {"ok": True}


@router.delete("/upkeep/{uid}")
def delete_upkeep(uid: int):
    with db.db() as conn:
        conn.execute("UPDATE upkeep SET active = 0 WHERE id = ?", (uid,))  # keep its history
    return {"ok": True}


class DoneIn(BaseModel):
    done: str = ""        # YYYY-MM-DD; blank = today
    note: str = ""
    cost: float | None = None  # dollars
    km: int | None = None
    by_person: int | None = None


@router.post("/upkeep/{uid}/done")
def upkeep_done(uid: int, body: DoneIn, request: Request):
    t = today()
    try:
        done = date.fromisoformat(body.done) if body.done else t
    except ValueError:
        raise HTTPException(400, "bad date")
    if done > t:
        raise HTTPException(400, "that's in the future")
    with db.db() as conn:
        j = conn.execute("SELECT * FROM upkeep WHERE id = ?", (uid,)).fetchone()
        if not j:
            raise HTTPException(404, "no such job")
        conn.execute("INSERT INTO upkeep_log (upkeep_id, done, note, cost, km, by_person) VALUES (?, ?, ?, ?, ?, ?)",
                     (uid, done.isoformat(), body.note.strip()[:200], round(body.cost * 100) if body.cost else None,
                      body.km, _who(request) or body.by_person))
        nxt = None
        if j["every_months"]:
            if j["fixed"] and j["due"]:
                # The same date next time round. Done early (within half the gap before it) counts for this one.
                nxt = date.fromisoformat(j["due"])
                while nxt - timedelta(days=j["every_months"] * 15) <= done:
                    nxt = add_months(nxt, j["every_months"])
            else:
                nxt = add_months(done, j["every_months"])
        conn.execute("UPDATE upkeep SET due = ? WHERE id = ?", (nxt.isoformat() if nxt else None, uid))
    return {"due": nxt.isoformat() if nxt else None}


@router.delete("/upkeep/log/{lid}")
def delete_upkeep_log(lid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM upkeep_log WHERE id = ?", (lid,))
    return {"ok": True}


# ---------------------------------------------------------------- contacts

class ContactIn(BaseModel):
    name: str
    role: str = ""
    grp: str = "other"
    phone: str = ""
    phone2: str = ""
    email: str = ""
    address: str = ""
    notes: str = ""
    person_id: int | None = None
    sitter: bool = False


def _clean_contact(c: ContactIn) -> tuple:
    if not c.name.strip():
        raise HTTPException(400, "give it a name")
    if c.grp not in GROUPS:
        raise HTTPException(400, "bad group")
    if not (c.phone.strip() or c.phone2.strip() or c.email.strip() or c.address.strip()):
        raise HTTPException(400, "add a phone number, email or address")
    return (c.name.strip()[:60], c.role.strip()[:60], c.grp, c.phone.strip()[:30], c.phone2.strip()[:30],
            c.email.strip()[:80], c.address.strip()[:160], c.notes.strip()[:300], c.person_id, int(c.sitter))


def _teachers(conn) -> list[dict]:
    """The kids' teachers, from Admin → People (read-only here)."""
    return [{"id": None, "name": r["teacher"], "role": f"{r['kid']}'s teacher", "grp": "school", "phone": "", "phone2": "",
             "email": r["teacher_email"], "address": "", "notes": "", "person_id": r["id"], "sitter": 0, "auto": True}
            for r in conn.execute("SELECT id, name AS kid, teacher, teacher_email FROM people WHERE is_kid = 1 AND teacher != '' "
                                  "ORDER BY sort, id")]


@router.get("/contacts")
def list_contacts():
    with db.db() as conn:
        rows = db.rows(conn.execute(
            "SELECT c.*, p.name AS person FROM contacts c LEFT JOIN people p ON p.id = c.person_id ORDER BY c.grp, c.sort, c.name"))
        people = db.rows(conn.execute("SELECT id, name, is_kid FROM people ORDER BY sort, id"))
        return {"contacts": rows + _teachers(conn), "people": people, "groups": GROUPS}


@router.post("/contacts")
def add_contact(c: ContactIn):
    with db.db() as conn:
        sort = conn.execute("SELECT COALESCE(MAX(sort), 0) + 1 FROM contacts").fetchone()[0]
        cur = conn.execute("INSERT INTO contacts (name, role, grp, phone, phone2, email, address, notes, person_id, sitter, sort) "
                           "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (*_clean_contact(c), sort))
    return {"id": cur.lastrowid}


@router.put("/contacts/{cid}")
def edit_contact(cid: int, c: ContactIn):
    with db.db() as conn:
        conn.execute("UPDATE contacts SET name = ?, role = ?, grp = ?, phone = ?, phone2 = ?, email = ?, address = ?, notes = ?, "
                     "person_id = ?, sitter = ? WHERE id = ?", (*_clean_contact(c), cid))
    return {"ok": True}


@router.delete("/contacts/{cid}")
def delete_contact(cid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM contacts WHERE id = ?", (cid,))
    return {"ok": True}


# ---------------------------------------------------------------- the sitter sheet

class SitterIn(BaseModel):
    address: str = ""
    notes: str = ""


def _age(birthday: str, t: date) -> int | None:
    try:
        b = date.fromisoformat(birthday)
    except ValueError:
        return None
    return t.year - b.year - ((t.month, t.day) < (b.month, b.day))


@router.get("/sitter")
def sitter_sheet():
    t = today()
    with db.db() as conn:
        get = lambda k: db.get_setting(conn, k)
        kids = []
        for k in db.rows(conn.execute("SELECT id, name, birthday, teacher FROM people WHERE is_kid = 1 ORDER BY sort, id")):
            bedtime = db.rows(conn.execute(
                "SELECT title, at, school_days FROM chores WHERE person_id = ? AND routine = 'bedtime' ORDER BY school_days, at",
                (k["id"],)))
            meds = db.rows(conn.execute(
                "SELECT name, dose, kind, times, min_hours, max_per_day, notes FROM meds WHERE person_id = ? AND active = 1 "
                "ORDER BY name", (k["id"],)))
            for m in meds:
                m["times"] = json.loads(m["times"] or "[]")
            last = conn.execute("SELECT m.name, l.at FROM med_log l JOIN meds m ON m.id = l.med_id WHERE l.person_id = ? "
                                "ORDER BY l.at DESC LIMIT 1", (k["id"],)).fetchone()
            kids.append({**k, "age": _age(k["birthday"], t), "bedtime": bedtime, "meds": meds,
                         "last_med": dict(last) if last and last["at"][:10] >= (t - timedelta(days=1)).isoformat() else None})
        contacts = db.rows(conn.execute(
            "SELECT c.*, p.name AS person FROM contacts c LEFT JOIN people p ON p.id = c.person_id WHERE c.sitter = 1 "
            "ORDER BY CASE c.grp WHEN 'emergency' THEN 0 WHEN 'family' THEN 1 WHEN 'health' THEN 2 ELSE 3 END, c.sort, c.name"))
        return {"family": get("family_name"), "address": get("sitter_address"), "notes": get("sitter_notes"),
                "kids": kids, "contacts": contacts, "today": t.isoformat()}


@router.put("/sitter")
def save_sitter(body: SitterIn):
    with db.db() as conn:
        for k, v in (("sitter_address", body.address.strip()[:200]), ("sitter_notes", body.notes.strip()[:2000])):
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, v))
    return {"ok": True}
