"""Medicine: scheduled pills with reminders (an adult's morning and evening pills, say), and a log of medicine given to
the kids (Children's Tylenol, Advil...) with "next dose not before" and a daily limit, so nobody doubles up.

- A medicine belongs to a person. times = the reminder times ("08:00", "20:00"); as-needed medicine has none.
- min_hours / max_per_day are the spacing rules the family types in from the package (never made up here).
- Taking or giving one is a row in med_log. A scheduled dose is matched to its time slot (slot).
Reminders: at each time the person's phone is told (a kid's reminders go to the adults), and once more 45 minutes
later if it still isn't marked. When an adult gives a kid medicine, the other adults get a notification.
"""
import json
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import auth, db

router = APIRouter(prefix="/api/meds")
FOLLOW_UP = 45  # minutes after a reminder, if it isn't marked yet

# Suggestions for the add form: names and the usual spacing. Doses go by the package or the doctor.
PRESETS = [
    {"name": "Children's Tylenol (acetaminophen)", "min_hours": 4, "max_per_day": 5},
    {"name": "Children's Advil (ibuprofen)", "min_hours": 6, "max_per_day": 4},
    {"name": "Melatonin", "min_hours": 24, "max_per_day": 1},
    {"name": "Allergy medicine", "min_hours": 24, "max_per_day": 1},
    {"name": "Antibiotic", "min_hours": 8, "max_per_day": 3},
    {"name": "Rescue puffer: Ventolin / salbutamol (blue)", "kind": "puffer", "dose": "2 puffs", "min_hours": 4, "max_per_day": None},
    {"name": "Daily puffer: Flovent / fluticasone (orange)", "kind": "puffer", "dose": "2 puffs", "times": ["08:00", "20:00"],
     "min_hours": None, "max_per_day": 2},
    {"name": "Daily puffer: Symbicort / Advair", "kind": "puffer", "dose": "1 puff", "times": ["08:00", "20:00"],
     "min_hours": None, "max_per_day": 2},
]
SYMPTOMS = ["Cough", "Wheeze", "Short of breath", "Chest tight", "Fever", "Runny nose", "Sore throat", "Earache",
            "Headache", "Stomach ache", "Throwing up", "Diarrhea", "Rash", "Tired", "Not eating", "Other"]
LOW_PUFFS = 30  # warn to refill a puffer below this

_tz = None


def set_tz(tz) -> None:
    global _tz
    _tz = tz


def now() -> datetime:
    return datetime.now(_tz).replace(tzinfo=None)


def _who(request: Request) -> int | None:
    return auth.member_id(auth.cookie_role(request.cookies.get(auth.COOKIE)))


def _clock(hm: str) -> str:
    h, m = map(int, hm.split(":"))
    return f"{h % 12 or 12}:{m:02d} {'am' if h < 12 else 'pm'}"


def _status(conn, med: dict, t: datetime) -> dict:
    """Today's slots (taken or not), the last dose, when the next one is allowed, how many today."""
    today = t.date().isoformat()
    log = db.rows(conn.execute(
        "SELECT l.*, p.name AS by_name FROM med_log l LEFT JOIN people p ON p.id = l.by_person "
        "WHERE l.med_id = ? ORDER BY l.at DESC LIMIT 30", (med["id"],)))
    times = json.loads(med["times"] or "[]")
    slots = [{"time": s, "taken": next((l for l in log if l["slot"] == s and l["at"][:10] == today), None)} for s in times]
    last = log[0] if log else None
    count = sum(1 for l in log if l["at"][:10] == today)
    next_ok = None
    if last and med["min_hours"]:
        n = datetime.fromisoformat(last["at"]) + timedelta(hours=med["min_hours"])
        next_ok = n.isoformat(timespec="minutes") if n > t else None
    return {**med, "times": times, "slots": slots, "last": last, "today": count, "next_ok": next_ok,
            "limit_reached": bool(med["max_per_day"]) and count >= med["max_per_day"], "recent": log[:10],
            "low": med.get("kind") == "puffer" and med.get("puffs_left") is not None and med["puffs_left"] < LOW_PUFFS}


@router.get("")
def list_meds():
    t = now()
    with db.db() as conn:
        meds = db.rows(conn.execute(
            "SELECT m.*, p.name AS person, p.is_kid FROM meds m JOIN people p ON p.id = m.person_id "
            "WHERE m.active = 1 ORDER BY p.sort, m.name"))
        people = db.rows(conn.execute("SELECT id, name, icon, is_kid, color FROM people ORDER BY sort, id"))
        return {"meds": [_status(conn, m, t) for m in meds], "people": people, "presets": PRESETS,
                "cabinet": _cabinet(conn), "now": t.isoformat(timespec="minutes")}


class MedIn(BaseModel):
    person_id: int
    name: str
    dose: str = ""
    times: list[str] = []
    min_hours: float | None = None
    max_per_day: int | None = None
    notes: str = ""
    kind: str = "med"               # med or puffer
    puffs_left: int | None = None   # a puffer's counter (200 when it's new)


def _check(m: MedIn) -> list[str]:
    if not m.name.strip():
        raise HTTPException(400, "give the medicine a name")
    times = sorted({t.strip() for t in m.times if t.strip()})
    for t in times:
        try:
            datetime.strptime(t, "%H:%M")
        except ValueError:
            raise HTTPException(400, f"bad time: {t}")
    return times


@router.post("")
def add_med(m: MedIn):
    times = _check(m)
    with db.db() as conn:
        mid = conn.execute("INSERT INTO meds (person_id, name, dose, times, min_hours, max_per_day, notes, kind, puffs_left) "
                           "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                           (m.person_id, m.name.strip()[:80], m.dose.strip()[:80], json.dumps(times), m.min_hours,
                            m.max_per_day, m.notes.strip()[:300], _kind(m.kind), m.puffs_left)).lastrowid
        link_cabinet(conn)
    return {"id": mid}


@router.put("/{mid}")
def edit_med(mid: int, m: MedIn):
    times = _check(m)
    with db.db() as conn:
        conn.execute("UPDATE meds SET person_id = ?, name = ?, dose = ?, times = ?, min_hours = ?, max_per_day = ?, notes = ?, "
                     "kind = ?, puffs_left = ? WHERE id = ?",
                     (m.person_id, m.name.strip()[:80], m.dose.strip()[:80], json.dumps(times), m.min_hours,
                      m.max_per_day, m.notes.strip()[:300], _kind(m.kind), m.puffs_left, mid))
    return {"ok": True}


@router.delete("/{mid}")
def remove_med(mid: int):
    """Stops it (the history stays)."""
    with db.db() as conn:
        conn.execute("UPDATE meds SET active = 0 WHERE id = ?", (mid,))
    return {"ok": True}


def _kind(k: str) -> str:
    return "puffer" if k == "puffer" else "med"


class TakeIn(BaseModel):
    puffs: int | None = None  # a puffer: how many puffs this time
    slot: str = ""            # the reminder time this dose is for, if any
    dose: str = ""
    note: str = ""
    by_person: int | None = None  # who gave it (a phone-only sign-in is always themselves)
    anyway: bool = False      # log it even though it's early or over the day's limit
    at: str = ""              # when it was given ("YYYY-MM-DDTHH:MM"); blank = now


def _given_at(value: str, t: datetime) -> datetime:
    """When a dose was given: now, or earlier (up to a week back) if it's being logged late."""
    if not value:
        return t
    try:
        at = datetime.fromisoformat(value[:16])
    except ValueError:
        raise HTTPException(400, "bad time")
    if at > t + timedelta(minutes=5):
        raise HTTPException(400, "that time hasn't happened yet")
    if at < t - timedelta(days=7):
        raise HTTPException(400, "only the last week can be filled in")
    return at


def _spacing_problem(conn, med: dict, at: datetime) -> str | None:
    """Too close to another dose (before or after this one), or over the day's limit."""
    others = [datetime.fromisoformat(r["at"]) for r in conn.execute("SELECT at FROM med_log WHERE med_id = ?", (med["id"],))]
    if med["min_hours"]:
        gap = timedelta(hours=med["min_hours"])
        close = sorted((o for o in others if abs(o - at) < gap), key=lambda o: abs(o - at))
        if close:
            o = close[0]
            when = _clock(o.strftime("%H:%M")) + ("" if o.date() == at.date() else f" on {o:%a}")
            if o <= at:
                return (f"The last dose was at {when}. The next one isn't due until "
                        f"{_clock((o + gap).strftime('%H:%M'))} (every {med['min_hours']:g} hours).")
            return f"There's already a dose logged at {when}, less than {med['min_hours']:g} hours after this one."
    same_day = sum(1 for o in others if o.date() == at.date())
    if med["max_per_day"] and same_day >= med["max_per_day"]:
        return f"That's already {same_day} that day (the limit is {med['max_per_day']})."
    return None


@router.post("/{mid}/take")
def take(mid: int, body: TakeIn, request: Request):
    t = now()
    by = _who(request) or body.by_person
    with db.db() as conn:
        med = conn.execute("SELECT m.*, p.name AS person, p.is_kid FROM meds m JOIN people p ON p.id = m.person_id WHERE m.id = ?",
                           (mid,)).fetchone()
        if not med:
            raise HTTPException(404, "no such medicine")
        med = dict(med)
        at = _given_at(body.at, t)
        if not body.anyway and (problem := _spacing_problem(conn, med, at)):
            raise HTTPException(409, problem)
        puffs = body.puffs if med["kind"] == "puffer" and body.puffs else None
        dose = f"{puffs} puff{'s' if puffs != 1 else ''}" if puffs else (body.dose or med["dose"]).strip()
        conn.execute("INSERT INTO med_log (med_id, person_id, dose, at, slot, by_person, note, puffs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     (mid, med["person_id"], dose[:80], at.isoformat(timespec="minutes"), body.slot, by, body.note.strip()[:200], puffs))
        if puffs and med["puffs_left"] is not None:
            conn.execute("UPDATE meds SET puffs_left = MAX(0, puffs_left - ?) WHERE id = ?", (puffs, mid))
        body.dose = dose
        by_name = conn.execute("SELECT name FROM people WHERE id = ?", (by,)).fetchone()["name"] if by else None
    if med["is_kid"]:  # tell the other adults, so nobody gives it twice
        from . import main  # the adults' phones and topics live in main
        main.notify_adults(f"💊 {med['person']}: {med['name']}",
                           f"{by_name or 'Someone'} gave {(body.dose or med['dose'] or 'a dose')} at {_clock(at.strftime('%H:%M'))}"
                           + ("" if at.date() == t.date() else f" on {at:%a %b %d}"),
                           "/me", exclude=by, topic="meds")
    return {"ok": True}


@router.delete("/log/{lid}")
def undo(lid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM med_log WHERE id = ?", (lid,))
    return {"ok": True}


@router.get("/log")
def history(days: int = 30, person_id: int | None = None):
    since = (now() - timedelta(days=min(days, 365))).isoformat(timespec="minutes")
    sql = ("SELECT l.*, m.name AS med, p.name AS person, b.name AS by_name FROM med_log l JOIN meds m ON m.id = l.med_id "
           "JOIN people p ON p.id = l.person_id LEFT JOIN people b ON b.id = l.by_person WHERE l.at >= ?")
    args: list = [since]
    if person_id:
        sql += " AND l.person_id = ?"
        args.append(person_id)
    with db.db() as conn:
        return db.rows(conn.execute(sql + " ORDER BY l.at DESC LIMIT 300", args))


def reminders(t: datetime) -> list[tuple[str, int | None, str, str, str]]:
    """Due now: (key, person to tell or None for "the adults", title, body, url). Sent once each by push._send_timed."""
    hm = t.strftime("%H:%M")
    out = []
    with db.db() as conn:
        meds = db.rows(conn.execute(
            "SELECT m.*, p.name AS person, p.is_kid, p.access FROM meds m JOIN people p ON p.id = m.person_id "
            "WHERE m.active = 1 AND m.times != '[]'"))
        for med in meds:
            st = _status(conn, med, t)
            for s in st["slots"]:
                if s["taken"]:
                    continue
                first = datetime.combine(t.date(), datetime.strptime(s["time"], "%H:%M").time())
                again = first + timedelta(minutes=FOLLOW_UP)
                for when, key, lead in ((first, "med", "Time for"), (again, "med2", "Did you take")):
                    if when <= t < when + timedelta(minutes=30):
                        who = None if med["is_kid"] else med["person_id"]
                        url = "/my-shifts?page=meds" if med["access"] == "phone" else "/me"
                        title = f"💊 {lead} {'your' if who else med['person'] + chr(39) + 's'} {med['name'].lower() if who else med['name']}"
                        body = f"{_clock(s['time'])}{' · ' + med['dose'] if med['dose'] else ''}{' · ' + med['notes'] if med['notes'] else ''}"
                        out.append((f"{key}-{med['id']}-{s['time']}-{t.date()}", who, title + ("?" if key == "med2" else ""), body, url))
    return out


# ---------------------------------------------------------------- symptoms

class SymptomIn(BaseModel):
    person_id: int
    kinds: list[str] = []
    severity: str = ""
    temp: float | None = None  # °C
    note: str = ""
    at: str = ""               # "YYYY-MM-DDTHH:MM"; blank = now


@router.post("/symptoms")
def add_symptom(s: SymptomIn, request: Request):
    if not s.kinds and not s.note.strip() and s.temp is None:
        raise HTTPException(400, "pick a symptom, a temperature or a note")
    if s.temp is not None and not 30 <= s.temp <= 45:
        raise HTTPException(400, "temperatures are in °C (e.g. 38.5)")
    at = s.at or now().isoformat(timespec="minutes")
    try:
        datetime.fromisoformat(at)
    except ValueError:
        raise HTTPException(400, "bad time")
    with db.db() as conn:
        conn.execute("INSERT INTO symptoms (person_id, at, kinds, severity, temp, note, by_person) VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (s.person_id, at[:16], ", ".join(k.strip() for k in s.kinds if k.strip())[:200],
                      s.severity if s.severity in ("mild", "moderate", "bad") else "", s.temp, s.note.strip()[:300], _who(request)))
    return {"ok": True}


@router.get("/symptoms")
def list_symptoms(person_id: int | None = None, days: int = 30):
    since = (now() - timedelta(days=min(days, 365))).isoformat(timespec="minutes")
    with db.db() as conn:
        return db.rows(conn.execute(
            "SELECT s.*, p.name AS person FROM symptoms s JOIN people p ON p.id = s.person_id WHERE s.at >= ?"
            + (" AND s.person_id = ?" if person_id else "") + " ORDER BY s.at DESC", (since, person_id) if person_id else (since,)))


@router.delete("/symptoms/{sid}")
def delete_symptom(sid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM symptoms WHERE id = ?", (sid,))
    return {"ok": True}


@router.get("/symptom-kinds")
def symptom_kinds():
    return SYMPTOMS


# ---------------------------------------------------------------- the doctor report

def report_data(person_id: int, start: str, end: str) -> dict:
    """Everything given and noted for one person between start and end (dates, inclusive)."""
    s, e = date.fromisoformat(start), date.fromisoformat(end)
    if e < s:
        s, e = e, s
    lo, hi = s.isoformat(), (e + timedelta(days=1)).isoformat()
    with db.db() as conn:
        person = conn.execute("SELECT id, name, birthday, is_kid FROM people WHERE id = ?", (person_id,)).fetchone()
        if not person:
            raise HTTPException(404, "no such person")
        log = db.rows(conn.execute(
            "SELECT l.*, m.name AS med, m.kind, b.name AS by_name FROM med_log l JOIN meds m ON m.id = l.med_id "
            "LEFT JOIN people b ON b.id = l.by_person WHERE l.person_id = ? AND l.at >= ? AND l.at < ? ORDER BY l.at",
            (person_id, lo, hi)))
        syms = db.rows(conn.execute("SELECT s.*, b.name AS by_name FROM symptoms s LEFT JOIN people b ON b.id = s.by_person "
                                    "WHERE s.person_id = ? AND s.at >= ? AND s.at < ? ORDER BY s.at", (person_id, lo, hi)))
        meds_now = db.rows(conn.execute("SELECT name, dose, kind, times, min_hours, max_per_day, notes FROM meds "
                                        "WHERE person_id = ? AND active = 1", (person_id,)))
    days = [(s + timedelta(days=i)).isoformat() for i in range((e - s).days + 1)]
    summary = []
    for name in dict.fromkeys(l["med"] for l in log):
        rows = [l for l in log if l["med"] == name]
        per_day = {d: sum(1 for l in rows if l["at"][:10] == d) for d in days}
        summary.append({"med": name, "kind": rows[0]["kind"], "times": len(rows),
                        "puffs": sum(l["puffs"] or 0 for l in rows) or None,
                        "days_used": sum(1 for v in per_day.values() if v), "most_in_a_day": max(per_day.values()),
                        "per_day": per_day, "first": rows[0]["at"], "last": rows[-1]["at"]})
    fevers = [x for x in syms if x["temp"] is not None]
    age = None
    if person["birthday"]:
        b = date.fromisoformat(person["birthday"])
        age = e.year - b.year - ((e.month, e.day) < (b.month, b.day))
    return {"person": {"name": person["name"], "birthday": person["birthday"], "age": age}, "start": s.isoformat(),
            "end": e.isoformat(), "days": days, "summary": summary, "log": log, "symptoms": syms,
            "highest_temp": max((x["temp"] for x in fevers), default=None), "current_meds": meds_now,
            "made": now().isoformat(timespec="minutes")}


@router.get("/report")
def report(person_id: int, start: str, end: str):
    try:
        return report_data(person_id, start, end)
    except ValueError:
        raise HTTPException(400, "bad dates")


@router.get("/report.csv")
def report_csv(person_id: int, start: str, end: str):
    import csv
    import io
    from fastapi.responses import Response
    d = report_data(person_id, start, end)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["Date", "Time", "Type", "What", "Dose / details", "By", "Note"])
    rows = [(l["at"], "Medicine", l["med"], l["dose"], l["by_name"] or "", l["note"]) for l in d["log"]]
    rows += [(x["at"], "Symptom", x["kinds"], ", ".join(filter(None, [x["severity"], f"{x['temp']} °C" if x["temp"] else ""])),
              x["by_name"] or "", x["note"]) for x in d["symptoms"]]
    for at, kind, what, detail, by, note in sorted(rows):
        w.writerow([at[:10], at[11:16], kind, what, detail, by, note])
    name = f"{d['person']['name']}-medicine-{d['start']}-to-{d['end']}.csv"
    return Response(out.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------------------------------------------------------------- the medicine cabinet

SHARED = ("name", "kind", "times", "min_hours", "max_per_day", "notes")


def link_cabinet(conn) -> None:
    """Give every medicine without one a cabinet entry (same name and type = the same medicine)."""
    for m in db.rows(conn.execute("SELECT * FROM meds WHERE catalog_id IS NULL")):
        found = conn.execute("SELECT id FROM med_catalog WHERE name = ? AND kind = ? AND active = 1", (m["name"], m["kind"])).fetchone()
        cid = found["id"] if found else conn.execute(
            "INSERT INTO med_catalog (name, kind, dose, times, min_hours, max_per_day, notes, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (m["name"], m["kind"], m["dose"], m["times"], m["min_hours"], m["max_per_day"], m["notes"], m["active"])).lastrowid
        conn.execute("UPDATE meds SET catalog_id = ? WHERE id = ?", (cid, m["id"]))


def _cabinet(conn) -> list[dict]:
    items = db.rows(conn.execute("SELECT * FROM med_catalog WHERE active = 1 ORDER BY name COLLATE NOCASE"))
    rows = db.rows(conn.execute("SELECT m.id, m.catalog_id, m.person_id, m.dose, m.puffs_left, p.name FROM meds m "
                                "JOIN people p ON p.id = m.person_id WHERE m.active = 1 ORDER BY p.sort, p.id"))
    for c in items:
        c["times"] = json.loads(c["times"] or "[]")
        c["people"] = [{"person_id": r["person_id"], "name": r["name"], "med_id": r["id"], "dose": r["dose"], "puffs_left": r["puffs_left"]}
                       for r in rows if r["catalog_id"] == c["id"]]
    return items


@router.get("/cabinet")
def cabinet():
    with db.db() as conn:
        return _cabinet(conn)


class Taker(BaseModel):
    person_id: int
    dose: str = ""                  # blank = the cabinet's usual amount
    puffs_left: int | None = None


class CabinetIn(BaseModel):
    name: str
    kind: str = "med"
    dose: str = ""
    times: list[str] = []
    min_hours: float | None = None
    max_per_day: int | None = None
    notes: str = ""
    people: list[Taker] = []


def _cabinet_values(c: CabinetIn) -> dict:
    times = _check(MedIn(person_id=0, name=c.name, times=c.times))
    return {"name": c.name.strip()[:80], "kind": _kind(c.kind), "dose": c.dose.strip()[:80], "times": json.dumps(times),
            "min_hours": c.min_hours, "max_per_day": c.max_per_day, "notes": c.notes.strip()[:300]}


def _sync_people(conn, cid: int, v: dict, people: list[Taker]) -> None:
    """Make the per-person rows match: add the new people, update everyone, stop the ones taken off."""
    current = {r["person_id"]: r for r in db.rows(conn.execute("SELECT * FROM meds WHERE catalog_id = ?", (cid,)))}
    wanted = {p.person_id: p for p in people}
    for pid, p in wanted.items():
        dose = p.dose.strip()[:80] or v["dose"]
        if pid in current:
            conn.execute("UPDATE meds SET name = ?, kind = ?, times = ?, min_hours = ?, max_per_day = ?, notes = ?, dose = ?, "
                         "puffs_left = ?, active = 1 WHERE id = ?",
                         (*(v[k] for k in SHARED), dose, p.puffs_left, current[pid]["id"]))
        else:
            conn.execute("INSERT INTO meds (person_id, name, kind, times, min_hours, max_per_day, notes, dose, puffs_left, catalog_id) "
                         "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (pid, *(v[k] for k in SHARED), dose, p.puffs_left, cid))
    for pid, r in current.items():
        if pid not in wanted:
            conn.execute("UPDATE meds SET active = 0 WHERE id = ?", (r["id"],))


@router.post("/cabinet")
def add_to_cabinet(c: CabinetIn):
    v = _cabinet_values(c)
    with db.db() as conn:
        cid = conn.execute("INSERT INTO med_catalog (name, kind, dose, times, min_hours, max_per_day, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
                           (v["name"], v["kind"], v["dose"], v["times"], v["min_hours"], v["max_per_day"], v["notes"])).lastrowid
        _sync_people(conn, cid, v, c.people)
    return {"id": cid}


@router.put("/cabinet/{cid}")
def edit_cabinet(cid: int, c: CabinetIn):
    v = _cabinet_values(c)
    with db.db() as conn:
        if not conn.execute("UPDATE med_catalog SET name = ?, kind = ?, dose = ?, times = ?, min_hours = ?, max_per_day = ?, notes = ? "
                            "WHERE id = ?", (v["name"], v["kind"], v["dose"], v["times"], v["min_hours"], v["max_per_day"],
                                             v["notes"], cid)).rowcount:
            raise HTTPException(404, "not in the cabinet")
        _sync_people(conn, cid, v, c.people)
    return {"ok": True}


@router.delete("/cabinet/{cid}")
def remove_from_cabinet(cid: int):
    """Stops it for everyone (the history stays)."""
    with db.db() as conn:
        conn.execute("UPDATE med_catalog SET active = 0 WHERE id = ?", (cid,))
        conn.execute("UPDATE meds SET active = 0 WHERE catalog_id = ?", (cid,))
    return {"ok": True}



# ---------------------------------------------------------------- give medicine (pick the person and the medicine)

class GiveIn(TakeIn):
    person_id: int
    catalog_id: int


@router.post("/give")
def give(body: GiveIn, request: Request):
    """Log a cabinet medicine for someone. If they don't take it yet, it's added for them (with the usual amount)."""
    with db.db() as conn:
        c = conn.execute("SELECT * FROM med_catalog WHERE id = ? AND active = 1", (body.catalog_id,)).fetchone()
        if not c:
            raise HTTPException(404, "that medicine isn't in the cabinet")
        if not conn.execute("SELECT 1 FROM people WHERE id = ?", (body.person_id,)).fetchone():
            raise HTTPException(404, "no such person")
        row = conn.execute("SELECT id, active FROM meds WHERE catalog_id = ? AND person_id = ?", (c["id"], body.person_id)).fetchone()
        if row:
            mid = row["id"]
            if not row["active"]:
                conn.execute("UPDATE meds SET active = 1 WHERE id = ?", (mid,))
        else:
            mid = conn.execute("INSERT INTO meds (person_id, name, kind, dose, times, min_hours, max_per_day, notes, catalog_id, puffs_left) "
                               "VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, NULL)",
                               (body.person_id, c["name"], c["kind"], c["dose"], c["min_hours"], c["max_per_day"], c["notes"], c["id"])).lastrowid
    return take(mid, body, request)
