"""Family Planner - API + static pages.

  /          phone app (add to iPhone home screen)
  /display   wall screen for the Raspberry Pi
  /api/...   JSON API used by both
  /feed/...  iCal feeds phones can subscribe to (work shifts, tasks, reminders)
  /login     family password, asked only of visitors coming through Cloudflare (see auth.py)
"""
import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import threading
import time
from collections import Counter
from datetime import date, datetime, timedelta
from html import escape as html_escape
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from zoneinfo import ZoneInfo

import httpx
import icalendar
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, auth, calendars, db, gcal, holidays, homelab, house, kids_content, lunch_sync, meals, meds, passkeys, push, school, school_mail, shift_text

logging.basicConfig(level=logging.INFO)
TZ = ZoneInfo(os.environ.get("TZ") or "UTC")
STATIC = Path(__file__).resolve().parent / "static"
LUNCH_CHOICES = {"buy", "pack", "none"}
TASK_CATEGORIES = {"school", "project", "chore", "errand", "other"}

app = FastAPI(title="Family Planner")
db.init()
app.include_router(passkeys.router)
app.include_router(meals.router)
app.include_router(meds.router)
app.include_router(house.router)
meds.set_tz(TZ)
house.set_tz(TZ)
with db.db() as _conn:
    meals.seed(_conn)  # starter suppers, once
    meds.link_cabinet(_conn)  # older medicines get their cabinet entry
    house.seed(_conn)  # common car and house jobs, and the emergency numbers for the family's country, once


# Pages link their .js/.css as "/app.js?v=<ASSET_VERSION>". The version changes whenever any file in
# static/ changes, so neither Cloudflare nor a phone can pair a new page with an old script.
ASSET_VERSION = hashlib.sha1(b"".join(p.read_bytes() for p in sorted(STATIC.iterdir()) if p.is_file())).hexdigest()[:10]
ASSET_REF = re.compile(r'((?:src|href)="/[\w.-]+\.(?:js|css|json|png|svg))"')


def _page(name: str, html: str | None = None) -> HTMLResponse:
    html = html if html is not None else (STATIC / name).read_text(encoding="utf-8")
    return HTMLResponse(ASSET_REF.sub(rf'\1?v={ASSET_VERSION}"', html), headers={"Cache-Control": "private, no-cache"})


def _set_cache_header(request: Request, resp: Response) -> None:
    """Say how long browsers and Cloudflare may keep this. Without it Cloudflare tells phones to keep
    files for 4 hours, which is how a phone ended up running a new page with an old script."""
    if "cache-control" in resp.headers:
        return
    shared = auth.is_public(request.url.path)  # the same for everyone, so Cloudflare may keep a copy
    if "v" in request.query_params:            # versioned file: it never changes under this address
        resp.headers["Cache-Control"] = f"{'public' if shared else 'private'}, max-age=31536000, immutable"
    else:
        resp.headers["Cache-Control"] = "no-cache" if shared else "private, no-cache"


KIDS_HOME_ONLY_HTML = (
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>My Day</title>'
    '<body style="font:18px system-ui;text-align:center;padding:40px 20px;background:#fff7ec;color:#2b2340">'
    '<p style="font-size:48px;margin:0">🏠</p><h1>This page only works at home</h1>'
    "<p>Connect to the home Wi-Fi and open it again.</p></body>")


SETUP_PATHS = {"/setup", "/setup.js", "/api/setup", "/api/setup/countries"}


@app.middleware("http")
async def require_password(request: Request, call_next):
    path = request.url.path
    if not _set_up() and not (path in SETUP_PATHS or auth.is_public(path) or path.endswith((".css", ".js", ".png", ".svg", ".json"))):
        # A brand-new planner: everything waits for the first-run setup, which only opens on the home network.
        if path.startswith("/api/"):
            return JSONResponse({"detail": "finish the first-run setup at /setup"}, status_code=409)
        return RedirectResponse("/setup", status_code=303)
    if auth.is_external(request) and (path == "/kids" or path.startswith(("/kids/", "/api/kids"))):
        return HTMLResponse(KIDS_HOME_ONLY_HTML, status_code=403)  # the kids' pages are for home Wi-Fi only
    role = auth.cookie_role(request.cookies.get(auth.COOKIE))
    home = not auth.is_external(request)
    # Open without signing in: the login page and page code, and at home the kids' pages and the wall screen
    # (and everything until a family PIN exists).
    if auth.is_public(path) or home and (auth.lan_open(path) or not auth.password_is_set()):
        resp = await call_next(request)
        _set_cache_header(request, resp)
        return resp
    if role == "kid" and not auth.kid_allowed(path):  # kids see only their page (no bills, no settings)
        if path.startswith("/api/"):
            return JSONResponse({"detail": "not on the kids' page"}, status_code=403)
        return RedirectResponse("/kids", status_code=303)
    if auth.member_id(role) and not auth.member_allowed(path):  # phone view + own shifts only
        if path.startswith("/api/"):
            return JSONResponse({"detail": "not available on this sign-in"}, status_code=403)
        return RedirectResponse("/mobile", status_code=303)
    if role:
        resp = await call_next(request)
        _set_cache_header(request, resp)
        return resp
    if path.startswith("/api/"):
        return JSONResponse({"detail": "login required"}, status_code=401)
    return RedirectResponse(f"/login?next={quote(path)}", status_code=303)


def today() -> date:
    return datetime.now(TZ).date()


def parse_day(value: str | None, fallback: date) -> date:
    if not value:
        return fallback
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(400, f"bad date: {value}")


# ---------------------------------------------------------------- people

class PersonIn(BaseModel):
    name: str
    color: str
    is_kid: bool = False
    aliases: str | None = None  # comma-separated, e.g. "Dad"; None leaves them unchanged
    icon: str | None = None     # an emoji shown by the name; None leaves it unchanged
    theme: str | None = None    # kids' page look: "", "island" or "power"
    birthday: str | None = None # YYYY-MM-DD or ""
    teacher: str | None = None        # kids: "Ms. Smith"
    teacher_email: str | None = None
    class_notes: str | None = None    # e.g. an ordering code, "BEE folder every day"
    page_tabs: list[str] | None = None  # the tabs their own page shows (My page, or the phone-only page)


# Never send pin_hash anywhere: a 6-digit PIN's hash can be cracked offline.
PEOPLE_COLUMNS = "id, name, color, is_kid, sort, aliases, icon, theme, birthday, access, pin_hash != '' AS has_pin"


@app.get("/api/people")
def list_people():
    """For adults' pages. The teacher details stay out of PEOPLE_COLUMNS, which the open wall screen also uses."""
    with db.db() as conn:
        return db.rows(conn.execute(f"SELECT {PEOPLE_COLUMNS}, teacher, teacher_email, class_notes, page_tabs FROM people ORDER BY sort, id"))


@app.post("/api/people")
def add_person(p: PersonIn):
    with db.db() as conn:
        sort = conn.execute("SELECT COALESCE(MAX(sort), 0) + 1 FROM people").fetchone()[0]
        cur = conn.execute(
            "INSERT INTO people (name, color, is_kid, sort, aliases, icon) VALUES (?, ?, ?, ?, ?, ?)",
            (p.name, p.color, int(p.is_kid), sort, (p.aliases or "").strip(), (p.icon or "").strip()[:8]),
        )
        if p.is_kid:
            db.seed_chores(conn, cur.lastrowid)
        return {"id": cur.lastrowid}


@app.put("/api/people/{pid}")
def update_person(pid: int, p: PersonIn):
    with db.db() as conn:
        conn.execute("UPDATE people SET name = ?, color = ?, is_kid = ? WHERE id = ?", (p.name, p.color, int(p.is_kid), pid))
        if p.aliases is not None:
            conn.execute("UPDATE people SET aliases = ? WHERE id = ?", (p.aliases.strip(), pid))
        if p.icon is not None:
            conn.execute("UPDATE people SET icon = ? WHERE id = ?", (p.icon.strip()[:8], pid))
        if p.theme is not None:
            conn.execute("UPDATE people SET theme = ? WHERE id = ?", (p.theme if p.theme in ("island", "power") else "", pid))
        if p.birthday is not None:
            if p.birthday:
                parse_day(p.birthday, today())
            conn.execute("UPDATE people SET birthday = ? WHERE id = ?", (p.birthday, pid))
        if p.page_tabs is not None:
            conn.execute("UPDATE people SET page_tabs = ? WHERE id = ?", (json.dumps([t for t in p.page_tabs if re.fullmatch(r"[a-z]{2,12}", t)]), pid))
        for col in ("teacher", "teacher_email", "class_notes"):
            if getattr(p, col) is not None:
                conn.execute(f"UPDATE people SET {col} = ? WHERE id = ?", (getattr(p, col).strip()[:500], pid))
    return {"ok": True}


@app.delete("/api/people/{pid}")
def delete_person(pid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM people WHERE id = ?", (pid,))
    return {"ok": True}


# ---------------------------------------------------------------- tasks

class TaskIn(BaseModel):
    title: str
    person_id: int | None = None
    category: str = "other"
    due_date: str | None = None
    notes: str = ""
    done: bool = False


def _check_task(t: TaskIn):
    if not t.title.strip():
        raise HTTPException(400, "title required")
    if t.category not in TASK_CATEGORIES:
        raise HTTPException(400, "bad category")
    if t.due_date:
        parse_day(t.due_date, today())


@app.get("/api/tasks")
def list_tasks(include_done: bool = False):
    sql = "SELECT * FROM tasks"
    if not include_done:
        # Keep finished tasks visible for a day so an accidental tick can be undone.
        sql += " WHERE done = 0 OR done_at >= datetime('now', '-1 day')"
    sql += " ORDER BY done, due_date IS NULL, due_date, id"
    with db.db() as conn:
        return db.rows(conn.execute(sql))


@app.post("/api/tasks")
def add_task(t: TaskIn):
    _check_task(t)
    with db.db() as conn:
        cur = conn.execute(
            "INSERT INTO tasks (title, person_id, category, due_date, notes) VALUES (?, ?, ?, ?, ?)",
            (t.title.strip(), t.person_id, t.category, t.due_date or None, t.notes),
        )
        return {"id": cur.lastrowid}


@app.put("/api/tasks/{tid}")
def update_task(tid: int, t: TaskIn):
    _check_task(t)
    with db.db() as conn:
        conn.execute(
            """UPDATE tasks SET title = ?, person_id = ?, category = ?, due_date = ?, notes = ?, done = ?,
               done_at = CASE WHEN ? = 1 THEN COALESCE(done_at, datetime('now')) ELSE NULL END
               WHERE id = ?""",
            (t.title.strip(), t.person_id, t.category, t.due_date or None, t.notes, int(t.done), int(t.done), tid),
        )
    return {"ok": True}


@app.delete("/api/tasks/{tid}")
def delete_task(tid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM tasks WHERE id = ?", (tid,))
    return {"ok": True}


# ---------------------------------------------------------------- appointments
# Typed into the planner (by an adult, or on a phone-access person's page) for anyone in the family.

class AppointmentIn(BaseModel):
    title: str
    person_id: int | None = None  # None = the whole family
    date: str
    start_time: str | None = None  # None = all day
    end_time: str | None = None
    location: str = ""
    notes: str = ""


def _check_appointment(a: AppointmentIn) -> None:
    if not a.title.strip():
        raise HTTPException(400, "title required")
    parse_day(a.date, today())
    if a.end_time and not a.start_time:
        raise HTTPException(400, "an end time needs a start time")
    _check_times(*filter(None, (a.start_time, a.end_time)))
    if a.person_id is not None:
        with db.db() as conn:
            if not conn.execute("SELECT 1 FROM people WHERE id = ?", (a.person_id,)).fetchone():
                raise HTTPException(400, "unknown person")


def _appointment_values(a: AppointmentIn) -> tuple:
    return (a.title.strip(), a.person_id, a.date, a.start_time or None, a.end_time or None,
            a.location.strip(), a.notes.strip())


@app.get("/api/appointments")
def list_appointments(start: str | None = None, end: str | None = None):
    s = parse_day(start, today())
    e = parse_day(end, s + timedelta(days=90))
    with db.db() as conn:
        return db.rows(conn.execute(
            "SELECT * FROM appointments WHERE date >= ? AND date < ? AND google_state != 'delete' ORDER BY date, start_time IS NOT NULL, start_time, id",
            (s.isoformat(), e.isoformat())))


@app.post("/api/appointments")
def add_appointment(a: AppointmentIn):
    return _insert_appointment(a, None)


def _insert_appointment(a: AppointmentIn, added_by: int | None) -> dict:
    _check_appointment(a)
    with db.db() as conn:
        cur = conn.execute(
            "INSERT INTO appointments (title, person_id, date, start_time, end_time, location, notes, added_by) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (*_appointment_values(a), added_by))
    _push_to_google(cur.lastrowid)
    return {"id": cur.lastrowid}


def _push_to_google(aid: int) -> None:
    """Copy the change to the Google calendar in the background (see gcal.py), so saving stays quick."""
    threading.Thread(target=gcal.sync_one, args=(aid, str(TZ)), daemon=True).start()


@app.put("/api/appointments/{aid}")
def update_appointment(aid: int, a: AppointmentIn):
    _check_appointment(a)
    with db.db() as conn:
        cur = conn.execute(
            "UPDATE appointments SET title = ?, person_id = ?, date = ?, start_time = ?, end_time = ?, "
            "location = ?, notes = ?, google_state = 'pending' WHERE id = ? AND google_state != 'delete'",
            (*_appointment_values(a), aid))
        if not cur.rowcount:
            raise HTTPException(404, "no such appointment")
    _push_to_google(aid)
    return {"ok": True}


@app.delete("/api/appointments/{aid}")
def delete_appointment(aid: int):
    with db.db() as conn:
        # Anything already copied to Google is removed there first; the row goes once that has worked.
        conn.execute("DELETE FROM appointments WHERE id = ? AND google_id = ''", (aid,))
        conn.execute("UPDATE appointments SET google_state = 'delete' WHERE id = ?", (aid,))
    _push_to_google(aid)
    return {"ok": True}


# ---------------------------------------------------------------- work shifts

class TemplateIn(BaseModel):
    name: str
    start_time: str
    end_time: str


class ShiftIn(BaseModel):
    person_id: int
    date: str
    start_time: str
    end_time: str
    label: str = "Work"
    notes: str = ""


class ShiftToggle(BaseModel):
    person_id: int
    date: str
    label: str
    start_time: str
    end_time: str


TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _check_times(*values: str):
    for v in values:
        if not TIME_RE.match(v):
            raise HTTPException(400, f"bad time: {v} (use HH:MM)")


@app.get("/api/shift-templates")
def list_templates():
    with db.db() as conn:
        return db.rows(conn.execute("SELECT * FROM shift_templates ORDER BY sort, id"))


@app.post("/api/shift-templates")
def add_template(t: TemplateIn):
    _check_times(t.start_time, t.end_time)
    with db.db() as conn:
        sort = conn.execute("SELECT COALESCE(MAX(sort), 0) + 1 FROM shift_templates").fetchone()[0]
        cur = conn.execute(
            "INSERT INTO shift_templates (name, start_time, end_time, sort) VALUES (?, ?, ?, ?)",
            (t.name, t.start_time, t.end_time, sort),
        )
        return {"id": cur.lastrowid}


@app.put("/api/shift-templates/{tid}")
def update_template(tid: int, t: TemplateIn):
    _check_times(t.start_time, t.end_time)
    with db.db() as conn:
        conn.execute(
            "UPDATE shift_templates SET name = ?, start_time = ?, end_time = ? WHERE id = ?",
            (t.name, t.start_time, t.end_time, tid),
        )
    return {"ok": True}


@app.delete("/api/shift-templates/{tid}")
def delete_template(tid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM shift_templates WHERE id = ?", (tid,))
    return {"ok": True}


@app.get("/api/shifts")
def list_shifts(start: str | None = None, end: str | None = None, person_id: int | None = None):
    s = parse_day(start, today() - timedelta(days=7))
    e = parse_day(end, today() + timedelta(days=60))
    sql = "SELECT * FROM shifts WHERE date >= ? AND date < ?"
    args: list = [s.isoformat(), e.isoformat()]
    if person_id:
        sql += " AND person_id = ?"
        args.append(person_id)
    with db.db() as conn:
        return db.rows(conn.execute(sql + " ORDER BY date, start_time", args))


@app.post("/api/shifts")
def add_shift(s: ShiftIn):
    parse_day(s.date, today())
    _check_times(s.start_time, s.end_time)
    with db.db() as conn:
        cur = conn.execute(
            "INSERT INTO shifts (person_id, date, start_time, end_time, label, notes) VALUES (?, ?, ?, ?, ?, ?)",
            (s.person_id, s.date, s.start_time, s.end_time, s.label or "Work", s.notes),
        )
        return {"id": cur.lastrowid}


@app.put("/api/shifts/{sid}")
def update_shift(sid: int, s: ShiftIn):
    parse_day(s.date, today())
    _check_times(s.start_time, s.end_time)
    with db.db() as conn:
        conn.execute(
            "UPDATE shifts SET person_id = ?, date = ?, start_time = ?, end_time = ?, label = ?, notes = ? WHERE id = ?",
            (s.person_id, s.date, s.start_time, s.end_time, s.label.strip() or "Work", s.notes, sid),
        )
    return {"ok": True}


@app.post("/api/shifts/toggle")
def toggle_shift(t: ShiftToggle):
    """Tap-a-day entry: adds this exact shift to the day, or removes it if it's already there.
    Other shifts that day are left alone (someone might have three)."""
    parse_day(t.date, today())
    _check_times(t.start_time, t.end_time)
    label = t.label.strip() or "Work"
    with db.db() as conn:
        match = conn.execute(
            "SELECT id FROM shifts WHERE person_id = ? AND date = ? AND label = ? AND start_time = ? AND end_time = ?",
            (t.person_id, t.date, label, t.start_time, t.end_time),
        ).fetchone()
        if match:
            conn.execute("DELETE FROM shifts WHERE id = ?", (match["id"],))
            return {"state": "removed"}
        conn.execute(
            "INSERT INTO shifts (person_id, date, start_time, end_time, label) VALUES (?, ?, ?, ?, ?)",
            (t.person_id, t.date, t.start_time, t.end_time, label),
        )
        return {"state": "set"}


class ShiftTextIn(BaseModel):
    person_id: int
    week_start: str       # any day in the week that weekday names refer to
    text: str
    save: bool = False    # False = just show what would be added


@app.post("/api/shifts/parse")
def parse_shifts(body: ShiftTextIn):
    """Typed shifts ("Monday: 8:00am-11:00am - Office") → preview, or save them (skipping exact duplicates)."""
    shifts, skipped = shift_text.parse(body.text, parse_day(body.week_start, today()))
    added = 0
    if body.save:
        with db.db() as conn:
            for s in shifts:
                if not conn.execute(
                        "SELECT 1 FROM shifts WHERE person_id = ? AND date = ? AND start_time = ? AND end_time = ? AND label = ?",
                        (body.person_id, s["date"], s["start_time"], s["end_time"], s["label"])).fetchone():
                    conn.execute("INSERT INTO shifts (person_id, date, start_time, end_time, label) VALUES (?, ?, ?, ?, ?)",
                                 (body.person_id, s["date"], s["start_time"], s["end_time"], s["label"]))
                    added += 1
    return {"shifts": shifts, "skipped": skipped, "added": added}


@app.get("/api/shifts/recent")
def recent_shifts(person_id: int):
    """Shifts this person has worked lately, most used first, to pick from when entering a new schedule."""
    with db.db() as conn:
        return db.rows(conn.execute(
            "SELECT label, start_time, end_time, COUNT(*) AS times, MAX(date) AS last FROM shifts "
            "WHERE person_id = ? AND date >= ? GROUP BY label, start_time, end_time "
            "ORDER BY times DESC, last DESC LIMIT 12",
            (person_id, (today() - timedelta(days=120)).isoformat())))


@app.delete("/api/shifts/{sid}")
def delete_shift(sid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM shifts WHERE id = ?", (sid,))
    return {"ok": True}


# ---------------------------------------------------------------- school lunch

class MenuIn(BaseModel):
    menu: str = ""
    no_school: bool = False


class ChoiceIn(BaseModel):
    choice: str | None  # buy / pack / none, or null to fall back to the weekly default


class DefaultsIn(BaseModel):
    person_id: int
    weekday: int  # 0 = Monday
    choice: str | None


class ImportIn(BaseModel):
    text: str


class LikesIn(BaseModel):
    dishes: list[str]


def _school_closures(conn) -> dict[str, str]:
    """No-school days: from the school newsletters, and days marked "No school" on the Lunch tab (storm days)."""
    closures = {r["date"]: r["title"] for r in conn.execute("SELECT date, title FROM school_dates WHERE kind = 'closed'")}
    closures.update({r["date"]: "No school" for r in conn.execute("SELECT date FROM lunch_menu WHERE no_school = 1")})
    return closures


def _school_events(conn, start: date, end: date) -> dict[str, list[str]]:
    """Special days from the newsletters ("📸 Picture Day"), and dates the school hasn't confirmed yet."""
    out: dict[str, list[str]] = {}
    closed = {r["date"] for r in conn.execute("SELECT date FROM school_dates WHERE kind = 'closed'")}
    for r in conn.execute("SELECT date, title, kind FROM school_dates WHERE kind IN ('event', 'maybe') AND date >= ? AND date < ? "
                          "ORDER BY source LIKE 'class:%'", (start.isoformat(), end.isoformat())):
        if r["date"] in closed and (r["kind"] == "maybe" or "unknown" in r["title"].lower()):
            continue  # a teacher has since confirmed there's no school
        title = f"Maybe no school: {r['title']}" if r["kind"] == "maybe" else r["title"]
        day = out.setdefault(r["date"], [])
        if not any(_same_event(title, t) for t in day):  # the newsletter and a teacher often list the same day
            day.append(title)
    return out


def _same_event(a: str, b: str) -> bool:
    words = lambda s: {w for w in re.findall(r"[a-z]{4,}", s.lower())}
    wa, wb = words(a), words(b)
    return bool(wa and wb) and len(wa & wb) >= min(len(wa), len(wb), 2)


def _rotation_anchors(conn) -> list[tuple[date, int]]:
    """Dates the school said were "Day N" (newsletters), plus Settings → "School day number today"."""
    anchors = [(date.fromisoformat(r["date"]), r["day_number"])
               for r in conn.execute("SELECT date, day_number FROM school_dates WHERE kind = 'day'")]
    try:
        d, n = db.get_setting(conn, "rotation_anchor").split(":")
        anchors.append((date.fromisoformat(d), int(n)))
    except ValueError:
        pass
    return anchors


def _lunch_days(conn, start: date, end: date) -> list[dict]:
    kids = db.rows(conn.execute("SELECT id FROM people WHERE is_kid = 1 ORDER BY sort, id"))
    menus = {r["date"]: r for r in db.rows(conn.execute(
        "SELECT * FROM lunch_menu WHERE date >= ? AND date < ?", (start.isoformat(), end.isoformat())))}
    plans = {(r["date"], r["person_id"]): r["choice"] for r in db.rows(conn.execute(
        "SELECT * FROM lunch_plan WHERE date >= ? AND date < ?", (start.isoformat(), end.isoformat())))}
    defaults = {(r["person_id"], r["weekday"]): r["choice"] for r in db.rows(conn.execute("SELECT * FROM lunch_default"))}
    likes: dict[int, list[str]] = {}
    for r in db.rows(conn.execute("SELECT * FROM lunch_like")):
        likes.setdefault(r["person_id"], []).append(r["dish"])
    closures = _school_closures(conn)
    out = []
    d = start
    while d < end:
        if d.weekday() < 5:
            iso = d.isoformat()
            menu = menus.get(iso, {})
            reason = school.closed_reason(d, closures)  # holidays, newsletter closures, summer, or marked on the Lunch tab
            no_school = reason is not None
            kid_plans = []
            for k in kids:
                override = plans.get((iso, k["id"]))
                liked = lunch_sync.matches(menu.get("menu", ""), likes.get(k["id"], []))
                if override:
                    choice = override
                elif k["id"] in likes and menu.get("menu"):
                    choice = "buy" if liked else "pack"  # menu is known: buy only the dishes they like
                else:
                    choice = defaults.get((k["id"], d.weekday()))
                kid_plans.append({
                    "person_id": k["id"],
                    "choice": None if no_school else choice,
                    "is_override": override is not None,
                    "liked": liked,
                })
            out.append({"date": iso, "menu": menu.get("menu", ""), "no_school": no_school,
                        "holiday": reason if reason and not menu.get("no_school") else None, "kids": kid_plans})
        d += timedelta(days=1)
    return out


@app.get("/api/lunch")
def get_lunch(start: str | None = None, end: str | None = None):
    s = parse_day(start, today())
    e = parse_day(end, s + timedelta(days=35))
    lunch_sync.maybe_sync(today())
    with db.db() as conn:
        return _lunch_days(conn, s, e)


@app.post("/api/lunch/sync")
def sync_lunch():
    return lunch_sync.sync(today())


@app.get("/api/lunch-likes")
def get_likes():
    with db.db() as conn:
        return db.rows(conn.execute("SELECT * FROM lunch_like ORDER BY rowid"))


@app.put("/api/lunch-likes/{pid}")
def set_likes(pid: int, body: LikesIn):
    dishes = [d.strip() for d in body.dishes if d.strip()]
    with db.db() as conn:
        conn.execute("DELETE FROM lunch_like WHERE person_id = ?", (pid,))
        conn.executemany("INSERT INTO lunch_like (person_id, dish) VALUES (?, ?)", [(pid, d) for d in dishes])
    return {"ok": True}


@app.put("/api/lunch/{day}")
def set_menu(day: str, m: MenuIn):
    parse_day(day, today())
    with db.db() as conn:
        conn.execute(
            "INSERT INTO lunch_menu (date, menu, no_school) VALUES (?, ?, ?) "
            "ON CONFLICT(date) DO UPDATE SET menu = excluded.menu, no_school = excluded.no_school",
            (day, m.menu.strip(), int(m.no_school)),
        )
    return {"ok": True}


@app.put("/api/lunch/{day}/{pid}")
def set_choice(day: str, pid: int, c: ChoiceIn):
    parse_day(day, today())
    with db.db() as conn:
        if c.choice is None:
            conn.execute("DELETE FROM lunch_plan WHERE date = ? AND person_id = ?", (day, pid))
        elif c.choice in LUNCH_CHOICES:
            conn.execute(
                "INSERT INTO lunch_plan (date, person_id, choice) VALUES (?, ?, ?) "
                "ON CONFLICT(date, person_id) DO UPDATE SET choice = excluded.choice",
                (day, pid, c.choice),
            )
        else:
            raise HTTPException(400, "bad choice")
    return {"ok": True}


@app.get("/api/lunch-defaults")
def get_defaults():
    with db.db() as conn:
        return db.rows(conn.execute("SELECT * FROM lunch_default"))


@app.put("/api/lunch-defaults")
def set_default(d: DefaultsIn):
    if not 0 <= d.weekday <= 4:
        raise HTTPException(400, "weekday must be 0-4")
    with db.db() as conn:
        if d.choice is None:
            conn.execute("DELETE FROM lunch_default WHERE person_id = ? AND weekday = ?", (d.person_id, d.weekday))
        elif d.choice in LUNCH_CHOICES:
            conn.execute(
                "INSERT INTO lunch_default (person_id, weekday, choice) VALUES (?, ?, ?) "
                "ON CONFLICT(person_id, weekday) DO UPDATE SET choice = excluded.choice",
                (d.person_id, d.weekday, d.choice),
            )
        else:
            raise HTTPException(400, "bad choice")
    return {"ok": True}


MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
_SEP = r"\s*[-:–—.|)]?\s*"
IMPORT_PATTERNS = [
    # 2026-09-29 Pizza
    (re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})" + _SEP + r"(.+)$"), "iso"),
    # 9/29 Pizza  or  9/29/2026 Pizza
    (re.compile(r"^(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?" + _SEP + r"(.+)$"), "md"),
    # Sept 29 Pizza  or  September 29: Pizza
    (re.compile(r"^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?" + _SEP + r"(.+)$", re.I), "name"),
]
WEEKDAY_PREFIX = re.compile(r"^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+", re.I)
NO_SCHOOL = re.compile(r"\b(no school|pd day|holiday|closed|no classes)\b", re.I)


def _guess_year(month: int, day: int) -> int:
    return lunch_sync.guess_year(month, day, today())


def parse_menu_text(text: str) -> tuple[list[tuple[str, str]], list[str]]:
    parsed, skipped = [], []
    for raw in text.splitlines():
        line = WEEKDAY_PREFIX.sub("", raw.strip())
        if not line:
            continue
        for pattern, kind in IMPORT_PATTERNS:
            m = pattern.match(line)
            if not m:
                continue
            try:
                if kind == "iso":
                    d = date(int(m[1]), int(m[2]), int(m[3]))
                elif kind == "md":
                    mo, dy = int(m[1]), int(m[2])
                    yr = int(m[3]) if m[3] else _guess_year(mo, dy)
                    d = date(yr + 2000 if yr < 100 else yr, mo, dy)
                else:
                    mo = MONTHS.get(m[1][:3].lower())
                    if not mo:
                        continue
                    dy = int(m[2])
                    d = date(int(m[3]) if m[3] else _guess_year(mo, dy), mo, dy)
            except ValueError:
                continue
            parsed.append((d.isoformat(), m[4].strip()))
            break
        else:
            skipped.append(raw.strip())
    return parsed, skipped


@app.post("/api/lunch/import")
def import_menu(body: ImportIn):
    """Paste a menu, one day per line, e.g. '9/29 Chicken nuggets' or 'Mon Sept 29 - Pizza'."""
    parsed, skipped = parse_menu_text(body.text)
    with db.db() as conn:
        for day, menu in parsed:
            conn.execute(
                "INSERT INTO lunch_menu (date, menu, no_school) VALUES (?, ?, ?) "
                "ON CONFLICT(date) DO UPDATE SET menu = excluded.menu, no_school = excluded.no_school",
                (day, menu, int(bool(NO_SCHOOL.search(menu)))),
            )
    return {"imported": len(parsed), "skipped": skipped}


# ---------------------------------------------------------------- google calendars

class CalendarIn(BaseModel):
    name: str
    url: str
    person_id: int | None = None
    color: str | None = None


@app.get("/api/calendars")
def list_calendars():
    with db.db() as conn:
        cals = db.rows(conn.execute("SELECT * FROM calendars ORDER BY id"))
    for c in cals:
        c["error"] = calendars.last_error(c["url"])
    return cals


@app.post("/api/calendars")
def add_calendar(c: CalendarIn):
    if not re.match(r"^(https?|webcal)://", c.url.strip()):
        raise HTTPException(400, "URL must start with https:// (use the 'Secret address in iCal format')")
    with db.db() as conn:
        cur = conn.execute(
            "INSERT INTO calendars (name, url, person_id, color) VALUES (?, ?, ?, ?)",
            (c.name, c.url.strip(), c.person_id, c.color or None),
        )
        return {"id": cur.lastrowid}


@app.put("/api/calendars/{cid}")
def update_calendar(cid: int, c: CalendarIn):
    with db.db() as conn:
        conn.execute(
            "UPDATE calendars SET name = ?, url = ?, person_id = ?, color = ? WHERE id = ?",
            (c.name, c.url.strip(), c.person_id, c.color or None, cid),
        )
    return {"ok": True}


@app.delete("/api/calendars/{cid}")
def delete_calendar(cid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM calendars WHERE id = ?", (cid,))
    return {"ok": True}


@app.post("/api/calendars/refresh")
def refresh_calendars():
    calendars.clear_cache()
    return {"ok": True}


# ---------------------------------------------------------------- agenda / dashboard

TITLE_PREFIX = re.compile(r"^\s*(?P<head>[^-–—:]+?)\s*[-–—:]\s*(?P<rest>\S.*)$")


def _person_from_title(item: dict, names: dict[str, int]) -> None:
    """Google's iCal links don't carry event colours, so a shared calendar's events are matched to a
    person by the name they start with: 'Emma - Swimming' becomes Emma's 'Swimming'.
    'Emma School Lunch' is Emma's but keeps its title; 'Emma/Noah - PD Day' stays a family event."""
    m = TITLE_PREFIX.match(item["title"])
    head = m["head"] if m else (item["title"].split() or [""])[0]  # no dash: only the first word can be a name
    words = [w.lower() for w in re.split(r"[\s/&,+]+", head) if w]
    ids = {names[w] for w in words if w in names}
    if len(ids) != 1:
        return
    item["person_id"] = ids.pop()
    if m and len(words) == 1:
        item["title"] = m["rest"].strip()
    else:
        item["who_in_title"] = True


def agenda(conn, start: date, end: date) -> list[dict]:
    """Everything with a date in [start, end): Google events, work shifts, task due dates."""
    items: list[dict] = []
    names = {}
    for p in db.rows(conn.execute("SELECT id, name, aliases FROM people")):
        for n in [p["name"], *p["aliases"].split(",")]:
            if n.strip():
                names[n.strip().lower()] = p["id"]
    # Appointments copied to Google come back in its feed; they're shown once, from the planner's own copy.
    pushed = {f"{r['google_id']}@google.com" for r in conn.execute("SELECT google_id FROM appointments WHERE google_id != ''")}
    for cal in db.rows(conn.execute("SELECT * FROM calendars")):
        for ev in calendars.events_between(cal, start, end, TZ):
            if ev["uid"] in pushed:
                continue
            if ev["person_id"] is None and not ev["color"]:
                _person_from_title(ev, names)
            items.append(ev)

    # School: days with no school (PD days, breaks, days marked on the Lunch tab) and special days.
    closures = _school_closures(conn)
    events = _school_events(conn, start, end)
    holiday_days = {d for d, _, kind in holidays.between(start, end) if kind == "holiday"}
    d = start
    while d < end:
        reason = school.closed_reason(d, closures)
        title = None
        if reason and reason not in ("Weekend", "Summer") and d not in holiday_days:
            title = "No school" if reason == "No school" else f"No school: {reason}"
        for t in filter(None, (title, *events.get(d.isoformat(), []))):
            items.append({
                "source": "school", "person_id": None, "title": t, "color": "#4f9fd9",
                "date": d.isoformat(), "start_time": None, "end_time": None, "all_day": True, "location": "",
            })
        d += timedelta(days=1)

    for o in _bill_occurrences(conn, start, end):
        items.append({
            "source": "bill", "bill_id": o["bill_id"], "person_id": None, "paid": o["paid"],
            "title": f"💲 {o['name']} due" + (f" ({o['amount']})" if o["amount"] else "") + (" · paid" if o["paid"] else ""),
            "color": "#3fa66b" if o["paid"] else "#d4553f",
            "date": o["due_date"], "start_time": None, "end_time": None, "all_day": True, "location": "",
        })

    for opens, closes in lunch_sync.order_windows(conn):
        for d, title in ((opens, f"🍽️ School lunch ordering opens (until {closes:%b} {closes.day})"),
                         (closes, "🍽️ Last day to order school lunch")):
            if start <= d < end:
                items.append({
                    "source": "reminder", "person_id": None, "title": title, "color": "#e0a800",
                    "date": d.isoformat(), "start_time": None, "end_time": None, "all_day": True, "location": "",
                })

    if db.get_setting(conn, "show_holidays", "1") == "1":
        for d, name, kind in holidays.between(start, end):
            items.append({
                "source": "holiday", "kind": kind, "person_id": None, "title": name,
                "color": "#d9a93b" if kind == "holiday" else "#7d8590",
                "date": d.isoformat(), "start_time": None, "end_time": None, "all_day": True, "location": "",
            })

    for s in db.rows(conn.execute(
            "SELECT * FROM shifts WHERE date >= ? AND date < ?", (start.isoformat(), end.isoformat()))):
        items.append({
            "source": "shift", "id": s["id"], "person_id": s["person_id"], "title": s["label"],
            "date": s["date"], "start_time": s["start_time"], "end_time": s["end_time"],
            "all_day": False, "overnight": s["end_time"] <= s["start_time"], "location": "",
        })

    for d, title in meals.supper_titles(conn, start, end).items():
        items.append({
            "source": "meal", "person_id": None, "title": title, "color": "#c4843a",
            "date": d, "start_time": None, "end_time": None, "all_day": True, "location": "",
        })

    for a in db.rows(conn.execute(
            "SELECT * FROM appointments WHERE date >= ? AND date < ? AND google_state != 'delete'",
            (start.isoformat(), end.isoformat()))):
        items.append({
            "source": "appt", "id": a["id"], "person_id": a["person_id"], "title": a["title"],
            "date": a["date"], "start_time": a["start_time"], "end_time": a["end_time"],
            "all_day": not a["start_time"], "location": a["location"], "notes": a["notes"],
        })

    for t in db.rows(conn.execute(
            "SELECT * FROM tasks WHERE done = 0 AND due_date >= ? AND due_date < ?",
            (start.isoformat(), end.isoformat()))):
        items.append({
            "source": "task", "id": t["id"], "person_id": t["person_id"], "title": t["title"],
            "category": t["category"], "date": t["due_date"], "start_time": None, "end_time": None,
            "all_day": True, "location": "",
        })

    items.sort(key=lambda i: (i["date"], not i["all_day"], i["source"] != "holiday", i["start_time"] or "", i["title"].lower()))
    return items


@app.get("/api/agenda")
def get_agenda(start: str | None = None, end: str | None = None):
    s = parse_day(start, today())
    e = parse_day(end, s + timedelta(days=14))
    if (e - s).days > 120:
        raise HTTPException(400, "range too large")
    with db.db() as conn:
        return agenda(conn, s, e)


_weather_cache: dict = {"at": 0.0, "key": None, "data": None}


def weather(conn) -> dict | None:
    lat, lon = db.get_setting(conn, "latitude"), db.get_setting(conn, "longitude")
    if not lat or not lon:
        return None
    key = (lat, lon)
    if _weather_cache["key"] == key and time.time() - _weather_cache["at"] < 30 * 60:
        return _weather_cache["data"]
    units = db.get_setting(conn, "temp_unit", "celsius")
    try:
        r = httpx.get("https://api.open-meteo.com/v1/forecast", timeout=10, params={
            "latitude": lat, "longitude": lon, "timezone": str(TZ), "forecast_days": 7,
            "current": "temperature_2m,weather_code",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,"
                     "snowfall_sum,apparent_temperature_min,apparent_temperature_max,wind_gusts_10m_max,uv_index_max",
            "temperature_unit": units,
        })
        r.raise_for_status()
        j = r.json()
        data = {
            "temp": round(j["current"]["temperature_2m"]),
            "code": j["current"]["weather_code"],
            "daily": [
                {"date": d, "code": c, "hi": round(hi), "lo": round(lo), "rain": p}
                for d, c, hi, lo, p in zip(
                    j["daily"]["time"], j["daily"]["weather_code"], j["daily"]["temperature_2m_max"],
                    j["daily"]["temperature_2m_min"], j["daily"]["precipitation_probability_max"])
            ],
        }
        daily = j["daily"]
        for i, day in enumerate(data["daily"]):
            f = lambda k: (daily.get(k) or [None] * 7)[i]
            day["hints"] = dress_hints(f("apparent_temperature_min"), f("apparent_temperature_max"), day["rain"] or 0,
                                       f("precipitation_sum") or 0, f("snowfall_sum") or 0, f("wind_gusts_10m_max") or 0,
                                       f("uv_index_max") or 0, units)
        _weather_cache.update(at=time.time(), key=key, data=data)
        return data
    except Exception as exc:
        logging.warning("weather fetch failed: %s", exc)
        return _weather_cache["data"]


def dress_hints(feels_lo, feels_hi, rain_pct, rain_mm, snow_cm, gusts_kmh, uv, units="celsius") -> list[str]:
    """What to wear or bring, from a day's forecast (the "feels like" low is the walk to school)."""
    c = (lambda v: None if v is None else (v - 32) * 5 / 9) if units == "fahrenheit" else (lambda v: v)
    lo, hi = c(feels_lo), c(feels_hi)
    out = []
    if snow_cm >= 1:
        out.append("❄️ Snow: boots, snow pants and mittens")
    elif rain_pct >= 60 and rain_mm >= 1:
        out.append("☔ Rain: raincoat and rain boots")
    elif rain_pct >= 40:
        out.append("🌂 Maybe rain: bring a raincoat")
    if lo is not None:
        if lo <= -15:
            out.append("🥶 Very cold: warmest coat, hat, mittens, and cover your face")
        elif lo <= -5:
            out.append("🧣 Cold: winter coat, hat, mittens and a scarf")
        elif lo <= 2:
            out.append("🧥 Winter coat, hat and mittens")
        elif lo <= 9:
            out.append("🧥 A warm jacket")
        elif lo <= 15 and (hi is None or hi <= 22):
            out.append("🧥 A light jacket or hoodie")
    if gusts_kmh >= 70:
        out.append("💨 Very windy: hold on to your hat")
    elif gusts_kmh >= 50:
        out.append("💨 Windy")
    if hi is not None and hi >= 27:
        out.append("🧢 Hot: sun hat, water bottle and sunscreen")
    elif uv >= 6 and not snow_cm:
        out.append("🧴 Strong sun: sunscreen")
    return out


def _day_weather(w: dict | None, d: date) -> dict | None:
    return next((x for x in (w or {}).get("daily", []) if x["date"] == d.isoformat()), None)


@app.get("/api/dashboard")
def dashboard(days: int = 7):
    """One call with everything the wall display shows."""
    t = today()
    days = max(1, min(days, 14))
    lunch_sync.maybe_sync(t)
    threading.Thread(target=gcal.retry_pending, args=(str(TZ),), daemon=True).start()
    with db.db() as conn:
        people = db.rows(conn.execute(f"SELECT {PEOPLE_COLUMNS} FROM people ORDER BY sort, id"))
        items = agenda(conn, t, t + timedelta(days=days))
        if db.get_setting(conn, "bills_on_wall", "0") != "1":
            items = [i for i in items if i["source"] != "bill"]  # everyone sees the wall
        tasks = db.rows(conn.execute(
            "SELECT * FROM tasks WHERE done = 0 AND (due_date IS NULL OR due_date < ?) "
            "ORDER BY due_date IS NULL, due_date, id",
            ((t + timedelta(days=14)).isoformat(),)))
        lunch = _lunch_days(conn, t, t + timedelta(days=10))
        return {
            "today": t.isoformat(),
            "now": datetime.now(TZ).strftime("%H:%M"),
            "people": people,
            "days": [
                {"date": (t + timedelta(days=i)).isoformat(),
                 "items": [x for x in items if x["date"] == (t + timedelta(days=i)).isoformat()]}
                for i in range(days)
            ],
            "tasks": tasks,
            "lunch": lunch[:3],
            "weather": weather(conn),
            "family_name": db.get_setting(conn, "family_name", "Family"),
        }


# ---------------------------------------------------------------- "my shifts" (phone view + own shifts)
# For a "member" sign-in (phone view + own shifts): add, type and change only their own shifts. The person always comes
# from the sign-in, never from the request, so they can't touch anyone else's.

def _me(request: Request) -> int:
    pid = auth.member_id(auth.cookie_role(request.cookies.get(auth.COOKIE)))
    if not pid:
        raise HTTPException(403, "for a phone sign-in only (use the Work tab)")
    return pid


def _own_shift(conn, sid: int, pid: int) -> None:
    if not conn.execute("SELECT 1 FROM shifts WHERE id = ? AND person_id = ?", (sid, pid)).fetchone():
        raise HTTPException(404, "not your shift")


class MyShiftIn(BaseModel):
    date: str
    start_time: str
    end_time: str
    label: str = "Work"
    notes: str = ""


class MyShiftTextIn(BaseModel):
    week_start: str
    text: str
    save: bool = False


@app.get("/api/me")
def me(request: Request):
    role = auth.cookie_role(request.cookies.get(auth.COOKIE))
    pid = auth.member_id(role)
    with db.db() as conn:
        person = conn.execute("SELECT id, name, icon, color, page_tabs FROM people WHERE id = ?", (pid,)).fetchone() if pid else None
    return {"role": "member" if pid else role or "home", "person": dict(person) if person else None}


@app.get("/api/my/shifts")
def my_shifts(request: Request, start: str | None = None, end: str | None = None):
    return list_shifts(start, end, _me(request))


@app.get("/api/my/shifts/recent")
def my_recent_shifts(request: Request):
    return recent_shifts(_me(request))


@app.post("/api/my/shifts")
def my_add_shift(request: Request, s: MyShiftIn):
    return add_shift(ShiftIn(person_id=_me(request), **s.model_dump()))


@app.put("/api/my/shifts/{sid}")
def my_update_shift(request: Request, sid: int, s: MyShiftIn):
    pid = _me(request)
    with db.db() as conn:
        _own_shift(conn, sid, pid)
    return update_shift(sid, ShiftIn(person_id=pid, **s.model_dump()))


@app.delete("/api/my/shifts/{sid}")
def my_delete_shift(request: Request, sid: int):
    pid = _me(request)
    with db.db() as conn:
        _own_shift(conn, sid, pid)
    return delete_shift(sid)


@app.post("/api/my/shifts/parse")
def my_parse_shifts(request: Request, body: MyShiftTextIn):
    return parse_shifts(ShiftTextIn(person_id=_me(request), **body.model_dump()))


# Appointments for anyone in the family, from the same page.

@app.get("/api/my/people")
def my_people(request: Request):
    _me(request)
    with db.db() as conn:
        return db.rows(conn.execute(f"SELECT {PEOPLE_COLUMNS} FROM people ORDER BY sort, id"))


@app.get("/api/my/appointments")
def my_appointments(request: Request, start: str | None = None, end: str | None = None):
    _me(request)
    return list_appointments(start, end)


@app.post("/api/my/appointments")
def my_add_appointment(request: Request, a: AppointmentIn):
    return _insert_appointment(a, _me(request))


@app.put("/api/my/appointments/{aid}")
def my_update_appointment(request: Request, aid: int, a: AppointmentIn):
    _me(request)
    return update_appointment(aid, a)


@app.delete("/api/my/appointments/{aid}")
def my_delete_appointment(request: Request, aid: int):
    _me(request)
    return delete_appointment(aid)


# ---------------------------------------------------------------- people's own PINs (adults only)

class PersonPinIn(BaseModel):
    pin: str | None = None  # a new PIN, or None to keep theirs
    access: str = "full"    # full, or phone (phone view + own shifts)
    remove: bool = False


@app.put("/api/people/{pid}/pin")
def set_person_pin(pid: int, body: PersonPinIn):
    if body.access not in ("full", "phone"):
        raise HTTPException(400, "bad access")
    if body.pin:
        if not re.match(auth.PIN_RE, body.pin):
            raise HTTPException(400, "Use 4 to 10 digits")
        if auth.pin_in_use(body.pin, pid):
            raise HTTPException(400, "That PIN is already used by someone else. Pick another.")
    with db.db() as conn:
        if not conn.execute("SELECT 1 FROM people WHERE id = ? AND is_kid = 0", (pid,)).fetchone():
            raise HTTPException(404, "adults only")
    auth.set_person_pin(pid, None if body.remove else body.pin, body.access, remove=body.remove)
    auth.clear_fails()
    return {"ok": True}


# ---------------------------------------------------------------- bills (adults only)

REPEATS = {"none", "weekly", "biweekly", "monthly", "yearly"}


class BillIn(BaseModel):
    name: str
    amount: str = ""
    due_date: str
    repeat: str = "monthly"
    notes: str = ""


def _add_months(d: date, months: int, day: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    y, m = d.year + y, m + 1
    last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
    return date(y, m, min(day, last))  # the 31st becomes the last day in shorter months


def bill_dates(bill: dict, start: date, end: date) -> list[date]:
    """Due dates of one bill in [start, end)."""
    first = date.fromisoformat(bill["due_date"])
    out, d, i = [], first, 0
    while d < end and i < 1000:
        if d >= start:
            out.append(d)
        i += 1
        if bill["repeat"] == "none":
            break
        elif bill["repeat"] == "weekly":
            d = first + timedelta(weeks=i)
        elif bill["repeat"] == "biweekly":
            d = first + timedelta(weeks=2 * i)
        elif bill["repeat"] == "monthly":
            d = _add_months(first, i, first.day)
        else:
            d = _add_months(first, 12 * i, first.day)
    return out


def _bill_occurrences(conn, start: date, end: date) -> list[dict]:
    paid = {(r["bill_id"], r["due_date"]) for r in conn.execute("SELECT bill_id, due_date FROM bill_paid")}
    out = []
    for b in db.rows(conn.execute("SELECT * FROM bills WHERE active = 1")):
        for d in bill_dates(b, start, end):
            out.append({"bill_id": b["id"], "name": b["name"], "amount": b["amount"], "repeat": b["repeat"],
                        "notes": b["notes"], "due_date": d.isoformat(), "paid": (b["id"], d.isoformat()) in paid})
    return sorted(out, key=lambda o: (o["due_date"], o["name"].lower()))


def _check_bill(b: BillIn) -> None:
    if not b.name.strip():
        raise HTTPException(400, "Give the bill a name")
    if b.repeat not in REPEATS:
        raise HTTPException(400, "bad repeat")
    parse_day(b.due_date, today())


@app.get("/api/bills")
def list_bills():
    with db.db() as conn:
        return db.rows(conn.execute("SELECT * FROM bills WHERE active = 1 ORDER BY name"))


@app.post("/api/bills")
def add_bill(b: BillIn):
    _check_bill(b)
    with db.db() as conn:
        conn.execute("INSERT INTO bills (name, amount, due_date, repeat, notes) VALUES (?, ?, ?, ?, ?)",
                     (b.name.strip(), b.amount.strip(), b.due_date, b.repeat, b.notes.strip()))
    return {"ok": True}


@app.put("/api/bills/{bid}")
def update_bill(bid: int, b: BillIn):
    _check_bill(b)
    with db.db() as conn:
        conn.execute("UPDATE bills SET name = ?, amount = ?, due_date = ?, repeat = ?, notes = ? WHERE id = ?",
                     (b.name.strip(), b.amount.strip(), b.due_date, b.repeat, b.notes.strip(), bid))
    return {"ok": True}


@app.delete("/api/bills/{bid}")
def delete_bill(bid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM bills WHERE id = ?", (bid,))
    return {"ok": True}


@app.get("/api/bills/upcoming")
def upcoming_bills(days: int = 60):
    """Unpaid bills from the last 60 days, plus everything due in the next `days`."""
    t = today()
    with db.db() as conn:
        occ = _bill_occurrences(conn, t - timedelta(days=60), t + timedelta(days=max(1, min(days, 400))))
    return [o for o in occ if o["due_date"] >= t.isoformat() or not o["paid"]]


class PaidIn(BaseModel):
    due_date: str


@app.post("/api/bills/{bid}/paid")
def toggle_paid(bid: int, body: PaidIn):
    parse_day(body.due_date, today())
    with db.db() as conn:
        if conn.execute("SELECT 1 FROM bill_paid WHERE bill_id = ? AND due_date = ?", (bid, body.due_date)).fetchone():
            conn.execute("DELETE FROM bill_paid WHERE bill_id = ? AND due_date = ?", (bid, body.due_date))
            return {"paid": False}
        conn.execute("INSERT INTO bill_paid (bill_id, due_date, paid_at) VALUES (?, ?, ?)",
                     (bid, body.due_date, datetime.now(TZ).isoformat(timespec="minutes")))
        return {"paid": True}


# ---------------------------------------------------------------- kids' pages (home Wi-Fi only)
# Only what a kid should see: their own events, to-dos and chores, family events, school, lunch, weather.
# Never shifts, adults' appointments, bills or settings.

PARTY = re.compile(r"birthday|b-?day|party", re.I)
KID_TASK_LIMIT = 8  # open to-dos a kid can add themselves


def _kid(conn, pid: int) -> dict:
    kid = conn.execute("SELECT id, name, color, icon, theme, birthday, teacher FROM people WHERE id = ? AND is_kid = 1",
                       (pid,)).fetchone()
    if not kid:
        raise HTTPException(404, "not one of the kids")
    return dict(kid)


def _next_birthday(birthday: str, t: date) -> dict | None:
    try:
        b = date.fromisoformat(birthday)
    except ValueError:
        return None
    for year in (t.year, t.year + 1):
        try:
            nxt = b.replace(year=year)
        except ValueError:  # born on Feb 29
            nxt = date(year, 3, 1)
        if nxt >= t:
            return {"date": nxt.isoformat(), "days": (nxt - t).days, "age": year - b.year}
    return None


def _school_day(conn, d: date, kid_name: str) -> dict:
    closures = _school_closures(conn)
    reason = school.closed_reason(d, closures)
    events = _school_events(conn, d, d + timedelta(days=1)).get(d.isoformat(), [])
    info = {"date": d.isoformat(), "school": reason is None, "reason": reason, "event": " · ".join(events) or None}
    if reason is None:
        n = school.rotation_day(d, closures, _rotation_anchors(conn))
        info["rotation"] = n
        info["special"] = _specials(conn, kid_name).get(n)
    return info


@app.get("/api/school/dates")
def school_dates():
    """What the newsletters said, from today on (for Settings)."""
    with db.db() as conn:
        return db.rows(conn.execute(
            "SELECT date, title, kind, day_number FROM school_dates WHERE date >= ? ORDER BY date, kind",
            (today().isoformat(),)))


@app.get("/api/kids")
def kids_list():
    with db.db() as conn:
        return db.rows(conn.execute("SELECT id, name, color, icon, theme FROM people WHERE is_kid = 1 ORDER BY sort, id"))


@app.get("/api/kids/{pid}")
def kid_page(pid: int):
    now = datetime.now(TZ)
    t = now.date()
    lunch_sync.maybe_sync(t)
    with db.db() as conn:
        kid = _kid(conn, pid)
        items = [i for i in agenda(conn, t, t + timedelta(days=30))
                 if i["source"] in ("holiday", "school")
                 or i["source"] in ("google", "appt") and i["person_id"] in (None, pid)
                 or i["source"] == "task" and i["person_id"] == pid]
        lunch = [{"date": d["date"], "menu": d["menu"],
                  "choice": next((k["choice"] for k in d["kids"] if k["person_id"] == pid), None)}
                 for d in _lunch_days(conn, t, t + timedelta(days=10)) if not d["no_school"]][:2]
        tasks = db.rows(conn.execute(
            "SELECT id, title, due_date, done, added_by FROM tasks WHERE person_id = ? "
            "AND (done = 0 OR done_at >= datetime('now', '-1 day')) "
            "ORDER BY done, due_date IS NULL, due_date, id", (pid,)))

        # Morning summary: today until 3 pm, then tomorrow (so they can get ready the night before).
        focus = t if now.hour < 15 else t + timedelta(days=1)
        summary = _school_day(conn, focus, kid["name"])
        summary["when"] = "today" if focus == t else "tomorrow"
        summary["lunch"] = next((l for l in lunch if l["date"] == focus.isoformat()), None)
        w = weather(conn)
        fw = _day_weather(w, focus)
        summary["weather"] = {"code": fw["code"], "hi": fw["hi"], "lo": fw["lo"], "hints": fw.get("hints", [])} if fw else None

        # Chores for today, and stars earned this week (Monday to today).
        closures = _school_closures(conn)
        school_today = school.closed_reason(t, closures) is None
        all_chores = db.rows(conn.execute(
            "SELECT c.id, c.title, c.school_days, c.routine, c.at, "
            "EXISTS(SELECT 1 FROM chore_done d WHERE d.chore_id = c.id AND d.date = ?) AS done "
            "FROM chores c WHERE c.person_id = ? ORDER BY c.at, c.sort, c.id", (t.isoformat(), pid)))
        chores = [c for c in all_chores if c["routine"] == "day" and (school_today or not c["school_days"])]
        # Bedtime and homework follow tonight: a school night (school tomorrow) or not; bedtime shows from 4 pm,
        # homework and reading from 3 pm.
        school_tomorrow = school.closed_reason(t + timedelta(days=1), closures) is None
        bedtime = [c for c in all_chores if c["routine"] == "bedtime" and _night_fits(c["school_days"], school_tomorrow)]
        homework = [c for c in all_chores if c["routine"] == "homework" and _night_fits(c["school_days"], school_tomorrow)]
        balance = _star_balance(conn, pid)
        rewards = db.rows(conn.execute(
            "SELECT id, title, cost FROM rewards WHERE person_id IS NULL OR person_id = ? ORDER BY cost, sort, id", (pid,)))
        monday = t - timedelta(days=t.weekday())
        stars = conn.execute(
            "SELECT COUNT(*) FROM chore_done d JOIN chores c ON c.id = d.chore_id WHERE c.person_id = ? AND d.date >= ?",
            (pid, monday.isoformat())).fetchone()[0]

        # Next weekday off school after today (holiday, PD day, break, or the start of summer).
        next_off = None
        for i in range(1, 250):
            d = t + timedelta(days=i)
            reason = school.closed_reason(d, closures)
            if reason and reason != "Weekend":
                next_off = {"date": d.isoformat(), "days": i, "name": "summer vacation" if reason == "Summer" else reason}
                break

        birthdays = []
        for p in db.rows(conn.execute("SELECT id, name, birthday FROM people WHERE birthday != ''")):
            nb = _next_birthday(p["birthday"], t)
            if nb and (p["id"] == pid or nb["days"] <= 30):
                birthdays.append({**nb, "name": p["name"], "mine": p["id"] == pid})
        parties = [{"date": i["date"], "days": (date.fromisoformat(i["date"]) - t).days, "title": i["title"],
                    "start_time": i["start_time"], "location": i.get("location", "")}
                   for i in items if i["source"] in ("google", "appt") and PARTY.search(i["title"])]

        return {
            "kid": kid, "today": t.isoformat(), "weather": w, "summary": summary, "money": _money(conn, pid, brief=True),
            "days": [{"date": (t + timedelta(days=i)).isoformat(),
                      "items": [x for x in items if x["date"] == (t + timedelta(days=i)).isoformat()]} for i in range(7)],
            "lunch": lunch, "tasks": tasks, "chores": chores, "stars": stars,
            "bedtime": bedtime, "bedtime_show": now.hour >= 16 and bool(bedtime),
            "homework": homework, "homework_show": now.hour >= 15 and bool(homework),
            "balance": balance, "rewards": rewards,
            "next_day_off": next_off, "birthdays": sorted(birthdays, key=lambda b: b["days"]), "parties": parties,
            "home_url": db.get_setting(conn, "home_url").rstrip("/"),
            **kids_content.for_kid(pid, t),
        }


def _morning_message(pid: int) -> tuple[str, str, str] | None:
    """The 7 am notification for a kid on a school day: Day number, gym/music/library, lunch, special day, weather."""
    t = today()
    with db.db() as conn:
        kid = _kid(conn, pid)
        info = _school_day(conn, t, kid["name"])
        if not info["school"]:
            return None
        day = (_lunch_days(conn, t, t + timedelta(days=1)) or [{}])[0]
        lunch = next((k["choice"] for k in day.get("kids", []) if k["person_id"] == pid), None)
        menu = day.get("menu", "")
        w = weather(conn)
        jobs = conn.execute("SELECT COUNT(*) FROM chores WHERE person_id = ?", (pid,)).fetchone()[0]
    parts = [f"🏫 Day {info['rotation']}" + (f" · {info['special']}" if info.get("special") else "")]
    if lunch == "buy":
        parts.append(f"🍽️ School lunch: {menu}")
    elif lunch == "pack":
        parts.append("🥪 Bring your packed lunch")
    if info.get("event"):
        parts.append(info["event"])
    if w:
        d0 = w["daily"][0]
        parts.append(f"{weatherish(w['code'])} {w['temp']}°, high {d0['hi']}°")
        parts += d0.get("hints", [])[:2]
    parts.append(f"🚌 Bus at 8:30 · {jobs} jobs to tick off")
    return f"☀️ Good morning, {kid['name']}!", "\n".join(parts), f"/kids/{kid['name'].lower()}"


def _bedtime_messages(now: datetime) -> list[tuple[str, int, str, str, str]]:
    """Bedtime reminders due now: (key, kid, title, body, url) for each step whose time has come in the last
    30 minutes, on school nights, unless the kid has already ticked it."""
    t = now.date()
    hm = now.strftime("%H:%M")
    soon = (now - timedelta(minutes=30)).strftime("%H:%M")
    out = []
    with db.db() as conn:
        school_tomorrow = school.closed_reason(t + timedelta(days=1), _school_closures(conn)) is None
        steps = db.rows(conn.execute(
            "SELECT c.id, c.person_id, c.title, c.at, c.school_days, p.name FROM chores c JOIN people p ON p.id = c.person_id "
            "WHERE c.routine = 'bedtime' AND c.at != '' ORDER BY c.at"))
        done = {r["chore_id"] for r in conn.execute("SELECT chore_id FROM chore_done WHERE date = ?", (t.isoformat(),))}
    for s in steps:
        if not (soon < s["at"] <= hm) or s["id"] in done or not _night_fits(s["school_days"], school_tomorrow):
            continue
        later = [x for x in steps if x["person_id"] == s["person_id"] and x["at"] > s["at"]
                 and _night_fits(x["school_days"], school_tomorrow)]
        body = f"Next at {_clock(later[0]['at'])}: {later[0]['title']}" if later else "Sleep well! 💤"
        out.append((f"bed-{s['id']}-{t}", s["person_id"], f"🌙 {s['name']}: {s['title']}", body, f"/kids/{s['name'].lower()}"))
    return out


def _night_fits(school_days: int, school_tomorrow: bool) -> bool:
    """Tonight's bedtime and homework: 0 every night, 1 school nights, 2 weekends and nights before a day off."""
    return school_days == 0 or (school_days == 1) == school_tomorrow


def _star_balance(conn, pid: int) -> int:
    """Stars (flowers, coins) saved up: every ticked job, minus the rewards already given."""
    earned = conn.execute("SELECT COUNT(*) FROM chore_done d JOIN chores c ON c.id = d.chore_id WHERE c.person_id = ?",
                          (pid,)).fetchone()[0]
    spent = conn.execute("SELECT COALESCE(SUM(cost), 0) FROM reward_log WHERE person_id = ?", (pid,)).fetchone()[0]
    return earned - spent


def _clock(hm: str) -> str:
    h, m = map(int, hm.split(":"))
    return f"{h % 12 or 12}:{m:02d}"


def weatherish(code: int) -> str:
    return "☀️" if code in (0, 1) else "⛅" if code == 2 else "☁️" if code in (3, 45, 48) else "❄️" if 71 <= code <= 86 else "🌧️"


class PushSubIn(BaseModel):
    subscription: dict


@app.get("/api/kids/push/key")  # two path parts, so it can't be mistaken for /api/kids/{pid}
def kids_push_key():
    return {"key": push.public_key()}


@app.post("/api/kids/{pid}/push")
def kid_push_on(pid: int, body: PushSubIn):
    with db.db() as conn:
        _kid(conn, pid)
    try:
        push.save(pid, body.subscription)
    except (KeyError, TypeError):
        raise HTTPException(400, "bad subscription")
    return {"ok": True}


@app.post("/api/kids/{pid}/push/test")
def kid_push_test(pid: int):
    """Send the morning summary now (or a hello if there's no school today)."""
    msg = _morning_message(pid)
    if not msg:
        with db.db() as conn:
            name = _kid(conn, pid)["name"]
        msg = (f"👋 Hi {name}!", "Morning reminders are on. They come at 7:00 on school days.", f"/kids/{name.lower()}")
    return {"sent": push.send(pid, *msg)}


@app.post("/api/kids/{pid}/tasks/{tid}")
def kid_tick_task(pid: int, tid: int):
    """A kid ticks one of their own to-dos on or off."""
    with db.db() as conn:
        _kid(conn, pid)
        row = conn.execute("SELECT done FROM tasks WHERE id = ? AND person_id = ?", (tid, pid)).fetchone()
        if not row:
            raise HTTPException(404, "not your to-do")
        done = 0 if row["done"] else 1
        conn.execute("UPDATE tasks SET done = ?, done_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END WHERE id = ?",
                     (done, done, tid))
    return {"done": bool(done)}


class KidTaskIn(BaseModel):
    title: str
    due_date: str | None = None


@app.post("/api/kids/{pid}/tasks")
def kid_add_task(pid: int, body: KidTaskIn):
    """A kid adds a to-do for themselves ("need poster board by Friday"), within reason."""
    title = " ".join(body.title.split())
    if not 2 <= len(title) <= 60:
        raise HTTPException(400, "Keep it between 2 and 60 letters")
    due = None
    if body.due_date:
        d = parse_day(body.due_date, today())
        if not today() <= d <= today() + timedelta(days=60):
            raise HTTPException(400, "Pick a day in the next two months")
        due = d.isoformat()
    with db.db() as conn:
        _kid(conn, pid)
        open_count = conn.execute("SELECT COUNT(*) FROM tasks WHERE added_by = ? AND done = 0", (pid,)).fetchone()[0]
        if open_count >= KID_TASK_LIMIT:
            raise HTTPException(400, f"You already have {KID_TASK_LIMIT} to-dos. Finish some first!")
        conn.execute("INSERT INTO tasks (title, person_id, category, due_date, added_by) VALUES (?, ?, 'other', ?, ?)",
                     (title, pid, due, pid))
    return {"ok": True}


@app.post("/api/kids/{pid}/chores/{cid}")
def kid_tick_chore(pid: int, cid: int):
    with db.db() as conn:
        _kid(conn, pid)
        if not conn.execute("SELECT 1 FROM chores WHERE id = ? AND person_id = ?", (cid, pid)).fetchone():
            raise HTTPException(404, "not your chore")
        t = today().isoformat()
        if conn.execute("SELECT 1 FROM chore_done WHERE chore_id = ? AND date = ?", (cid, t)).fetchone():
            conn.execute("DELETE FROM chore_done WHERE chore_id = ? AND date = ?", (cid, t))
            return {"done": False}
        conn.execute("INSERT INTO chore_done (chore_id, date) VALUES (?, ?)", (cid, t))
        return {"done": True}


# Adults manage the chore lists in Settings.
class ChoreIn(BaseModel):
    person_id: int
    title: str
    school_days: int = 0   # 0 every day/night, 1 school days/nights, 2 weekends and days off
    routine: str = "day"   # day, bedtime or homework
    at: str = ""           # HH:MM, a reminder for a bedtime or homework step


@app.get("/api/chores")
def list_chores():
    with db.db() as conn:
        return db.rows(conn.execute("SELECT * FROM chores ORDER BY person_id, routine = 'bedtime', at, sort, id"))


@app.post("/api/chores")
def add_chore(c: ChoreIn):
    title = c.title.strip()[:80]
    if not title:
        raise HTTPException(400, "Give the chore a name")
    with db.db() as conn:
        _kid(conn, c.person_id)
        sort = conn.execute("SELECT COALESCE(MAX(sort), 0) + 1 FROM chores WHERE person_id = ?", (c.person_id,)).fetchone()[0]
        if c.routine not in ("day", "bedtime", "homework") or c.school_days not in (0, 1, 2):
            raise HTTPException(400, "bad routine")
        if c.at:
            _check_times(c.at)
        conn.execute("INSERT INTO chores (person_id, title, school_days, sort, routine, at) VALUES (?, ?, ?, ?, ?, ?)",
                     (c.person_id, title, int(c.school_days), sort, c.routine, c.at if c.routine != "day" else ""))
    return {"ok": True}


@app.delete("/api/chores/{cid}")
def delete_chore(cid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM chores WHERE id = ?", (cid,))
    return {"ok": True}


# ---------------------------------------------------------------- settings

PUBLIC_SETTINGS = {"family_name", "latitude", "longitude", "temp_unit", "public_url", "lunch_school", "lunch_auto",
                   "show_holidays", "rotation_anchor", "bills_on_wall", "holiday_country", "holiday_subdiv",
                   "school_start", "school_end", "school_rotation", "home_url"}


PRIVATE_SETTINGS = {"password_hash", "kids_pin_hash", "session_secret", "passkey_user_id", "vapid_private_pem",
                    "google_sa_json", "pve_token_secret", "adguard_password"}


@app.get("/api/settings")
def get_settings(request: Request):
    with db.db() as conn:
        s = {r["key"]: r["value"] for r in db.rows(conn.execute("SELECT * FROM settings"))
             if r["key"] not in PRIVATE_SETTINGS}
        school_day = school.rotation_day(today(), _school_closures(conn), _rotation_anchors(conn))
    return {"timezone": str(TZ), "via_internet": auth.is_external(request), "pin_set": auth.password_is_set(),
            "kids_pin_set": auth.kids_pin_is_set(), "school_day_today": school_day, **s}


@app.put("/api/settings")
def put_settings(values: dict[str, str]):
    with db.db() as conn:
        for k, v in values.items():
            if k in PUBLIC_SETTINGS:
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (k, str(v).strip()),
                )
    _weather_cache.update(at=0.0)
    holidays.reset()
    school.reset()
    return {"ok": True}


# Copying appointments into a Google calendar (gcal.py). The key never leaves the server once saved.

class GoogleIn(BaseModel):
    key_json: str = ""  # blank = keep the saved key
    calendar: str


@app.get("/api/google")
def google_status():
    with db.db() as conn:
        return gcal.status(conn)


@app.put("/api/google")
def google_connect(body: GoogleIn):
    with db.db() as conn:
        if body.key_json.strip():
            try:
                gcal.check_key(body.key_json)
            except Exception as exc:
                raise HTTPException(400, f"Couldn't read that key: {exc}")
            conn.execute("INSERT INTO settings (key, value) VALUES ('google_sa_json', ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (body.key_json.strip(),))
        elif not db.get_setting(conn, "google_sa_json"):
            raise HTTPException(400, "paste the key file's contents")
        conn.execute("INSERT INTO settings (key, value) VALUES ('google_push_calendar', ?) "
                     "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (body.calendar.strip(),))
    try:
        gcal.test(str(TZ))
    except Exception as exc:
        raise HTTPException(400, f"Saved, but Google refused a test event: {exc}. Is the calendar shared with the "
                                 "robot's address with \"Make changes to events\"?")
    gcal.retry_pending(str(TZ), force=True)
    with db.db() as conn:
        return gcal.status(conn)


@app.delete("/api/google")
def google_disconnect():
    """Stop copying. Events already in Google stay there."""
    with db.db() as conn:
        conn.execute("DELETE FROM settings WHERE key IN ('google_sa_json', 'google_push_calendar')")
        conn.execute("DELETE FROM appointments WHERE google_state = 'delete'")
        conn.execute("UPDATE appointments SET google_state = ''")  # google_id stays, so they aren't shown twice
    return {"ok": True}


# ---------------------------------------------------------------- "My page" for adults (/me; homelab.py)
# Adults only: the middleware keeps kid and phone-only sign-ins out of /api/me/*.

@app.get("/api/me/kids")
def me_kids():
    """Each kid's page data (school day, lunch, appointments, to-dos, birthdays), for the Kids tab."""
    with db.db() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM people WHERE is_kid = 1 ORDER BY sort, id")]
    return [kid_page(pid) for pid in ids]


@app.get("/api/me/proxmox")
def me_proxmox():
    with db.db() as conn:
        return homelab.proxmox(conn)


@app.get("/api/me/adguard")
def me_adguard():
    with db.db() as conn:
        return homelab.adguard(conn)


class ProtectionIn(BaseModel):
    enabled: bool


@app.post("/api/me/adguard/protection")
def me_adguard_protection(body: ProtectionIn):
    with db.db() as conn:
        try:
            homelab.protection(conn, body.enabled)
        except Exception as exc:
            raise HTTPException(502, f"AdGuard: {exc}")
    return {"ok": True}


@app.get("/api/me/speedtest")
def me_speedtest():
    return homelab.speedtests()


@app.post("/api/me/speedtest")
def me_run_speedtest():
    try:
        homelab.run_speedtest()
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))
    return {"ok": True}


@app.get("/api/me/devices")
def me_devices():
    with db.db() as conn:
        return homelab.devices(conn)


class DeviceNameIn(BaseModel):
    name: str


@app.put("/api/me/devices/{mac}")
def me_name_device(mac: str, body: DeviceNameIn):
    mac = mac.lower()
    if not re.fullmatch(r"[0-9a-f]{2}(:[0-9a-f]{2}){5}", mac):
        raise HTTPException(400, "bad MAC address")
    with db.db() as conn:
        if body.name.strip():
            conn.execute("INSERT INTO device_names (mac, name) VALUES (?, ?) ON CONFLICT(mac) DO UPDATE SET name = excluded.name",
                         (mac, body.name.strip()[:60]))
        else:
            conn.execute("DELETE FROM device_names WHERE mac = ?", (mac,))
    return {"ok": True}


# ---------------------------------------------------------------- teachers' emails (My page → Kids)
# Upload an email (.msg/.eml/PDF/photo) or paste its text; see what it found; tick what to add.

MAIL_DIR = db.DATA_DIR / "mail"
MAIL_MAX = 25 * 1024 * 1024


def _specials(conn, kid_name: str) -> dict[int, str]:
    """What each school Day has for this kid (people.specials: from a teacher's calendar, or Settings → Kids)."""
    row = conn.execute("SELECT specials FROM people WHERE name = ?", (kid_name,)).fetchone()
    if row and row["specials"]:
        return {int(k): v for k, v in json.loads(row["specials"]).items()}
    return {}


def _mail_row(conn, mid: int) -> dict:
    row = conn.execute("SELECT * FROM teacher_mail WHERE id = ?", (mid,)).fetchone()
    if not row:
        raise HTTPException(404, "no such email")
    return dict(row)


def _safe_name(name: str) -> str:
    return re.sub(r"[^\w.\- ]+", "_", name)[:120] or "file"


def _mail_path(mid: int, i: int, name: str):
    return MAIL_DIR / str(mid) / f"{i}-{_safe_name(name)}"


def _save_mail(kid: int, mail: dict) -> int:
    with db.db() as conn:
        _kid(conn, kid)
        mid = conn.execute(
            "INSERT INTO teacher_mail (person_id, sender, sender_email, subject, sent, body, files) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (kid, mail["sender"], mail["sender_email"], mail["subject"][:200], mail["sent"], mail["body"][:100_000],
             json.dumps([n for n, _ in mail["attachments"]]))).lastrowid
    (MAIL_DIR / str(mid)).mkdir(parents=True, exist_ok=True)
    for i, (name, data) in enumerate(mail["attachments"]):
        _mail_path(mid, i, name).write_bytes(data)
    return mid


def _mail_detail(mid: int) -> dict:
    """The email, its files, and suggestions with anything already in the planner unticked."""
    with db.db() as conn:
        row = _mail_row(conn, mid)
        names = json.loads(row["files"])
        files = [(n, _mail_path(mid, i, n).read_bytes()) for i, n in enumerate(names) if _mail_path(mid, i, n).exists()]
        near = date.fromisoformat(row["sent"][:10]) if row["sent"] else today()
        items = school_mail.suggestions({**row, "attachments": files}, near)
        kid = _kid(conn, row["person_id"])
        existing = db.rows(conn.execute("SELECT date, title, kind, day_number FROM school_dates"))
        person = conn.execute("SELECT teacher, teacher_email, specials FROM people WHERE id = ?", (kid["id"],)).fetchone()
        tasks = {r["title"].lower() for r in conn.execute("SELECT title FROM tasks WHERE person_id = ?", (kid["id"],))}
    current_specials = json.loads(person["specials"]) if person["specials"] else {}
    for it in items:
        if it["kind"] == "day":
            it["already"] = any(e["kind"] == "day" and e["date"] == it["date"] and e["day_number"] == it["day_number"] for e in existing)
        elif it["kind"] in ("closed", "event"):
            it["already"] = any(e["date"] == it["date"] and (
                e["kind"] == "closed" if it["kind"] == "closed"  # any no-school note that day, whatever it's called
                else _same_event(e["title"], it["title"])) for e in existing)
        elif it["kind"] == "teacher":
            it["already"] = person["teacher"] == it["title"] and person["teacher_email"] == it.get("email", "")
        elif it["kind"] == "specials":
            it["already"] = current_specials == it["specials"]
        elif it["kind"] == "task":
            it["already"] = it["title"].lower() in tasks
        if it.get("already"):
            it["checked"] = False
    return {**{k: row[k] for k in ("id", "person_id", "sender", "sender_email", "subject", "sent", "body", "applied", "created")},
            "kid": kid["name"], "ocr_ready": school_mail.ocr_available(),
            "files": [{"n": i, "name": n, "photo": n.lower().endswith(school_mail.PHOTO), "pdf": n.lower().endswith(".pdf")}
                      for i, n in enumerate(names)],
            "items": items}


@app.post("/api/me/mail")
async def me_upload_mail(request: Request, kid: int, name: str):
    """The file is the request body (no form encoding), named by ?name=."""
    data = await request.body()
    if not data:
        raise HTTPException(400, "that file is empty")
    if len(data) > MAIL_MAX:
        raise HTTPException(413, "that file is bigger than 25 MB")
    try:
        mail = school_mail.read(name, data)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(400, f"couldn't read that file ({exc.__class__.__name__})")
    return _mail_detail(_save_mail(kid, mail))


class MailTextIn(BaseModel):
    kid: int
    text: str
    subject: str = ""


@app.post("/api/me/mail/text")
def me_paste_mail(body: MailTextIn):
    if not body.text.strip():
        raise HTTPException(400, "paste the email's text first")
    first = next((l.strip() for l in body.text.splitlines() if l.strip()), "")
    mail = {"sender": "", "sender_email": "", "subject": body.subject.strip() or first[:80], "sent": "",
            "body": body.text, "attachments": []}
    return _mail_detail(_save_mail(body.kid, mail))


@app.get("/api/me/mail")
def me_list_mail(kid: int):
    with db.db() as conn:
        return db.rows(conn.execute(
            "SELECT id, sender, subject, sent, applied, created, files FROM teacher_mail WHERE person_id = ? "
            "ORDER BY COALESCE(NULLIF(sent, ''), created) DESC", (kid,)))


@app.get("/api/me/mail/{mid}")
def me_mail(mid: int):
    return _mail_detail(mid)


@app.get("/api/me/mail/{mid}/files/{n}")
def me_mail_file(mid: int, n: int):
    with db.db() as conn:
        names = json.loads(_mail_row(conn, mid)["files"])
    if not 0 <= n < len(names) or not _mail_path(mid, n, names[n]).exists():
        raise HTTPException(404, "no such file")
    return FileResponse(_mail_path(mid, n, names[n]), filename=names[n], content_disposition_type="inline")


class MailItem(BaseModel):
    kind: str
    date: str | None = None
    title: str = ""
    day_number: int | None = None
    specials: dict[str, str] | None = None
    email: str | None = None


class MailApplyIn(BaseModel):
    items: list[MailItem]


@app.post("/api/me/mail/{mid}/apply")
def me_apply_mail(mid: int, body: MailApplyIn):
    """Add the ticked suggestions. Teacher dates are kept when a school newsletter arrives (source "class:...")."""
    source = f"class:mail-{mid}"
    added = Counter()
    with db.db() as conn:
        row = _mail_row(conn, mid)
        kid = row["person_id"]
        for it in body.items:
            if it.date:
                parse_day(it.date, today())
            if it.kind == "day" and it.date and it.day_number:
                conn.execute("DELETE FROM school_dates WHERE date = ? AND kind = 'day'", (it.date,))
                conn.execute("INSERT INTO school_dates (date, title, kind, day_number, source) VALUES (?, ?, 'day', ?, ?)",
                             (it.date, f"Day {it.day_number}", it.day_number, source))
            elif it.kind in ("closed", "event") and it.date and it.title.strip():
                conn.execute("INSERT INTO school_dates (date, title, kind, source) VALUES (?, ?, ?, ?)",
                             (it.date, it.title.strip()[:120], it.kind, source))
            elif it.kind == "task" and it.title.strip():
                conn.execute("INSERT INTO tasks (title, person_id, category, due_date, notes) VALUES (?, ?, 'school', ?, ?)",
                             (it.title.strip()[:200], kid, it.date or None,
                              f"From {row['sender'] or 'a teacher'}'s email: {row['subject']}"))
            elif it.kind == "specials" and it.specials:
                conn.execute("UPDATE people SET specials = ? WHERE id = ?", (json.dumps(it.specials, ensure_ascii=False), kid))
            elif it.kind == "teacher" and it.title.strip():
                conn.execute("UPDATE people SET teacher = ?, teacher_email = COALESCE(NULLIF(?, ''), teacher_email) WHERE id = ?",
                             (it.title.strip()[:80], (it.email or "").strip(), kid))
            else:
                continue
            added[it.kind] += 1
        conn.execute("UPDATE teacher_mail SET applied = ? WHERE id = ?", (datetime.now(TZ).isoformat(timespec="minutes"), mid))
    return {"added": dict(added)}


@app.delete("/api/me/mail/{mid}")
def me_delete_mail(mid: int):
    """Removes the saved email and its files (anything already added to the planner stays)."""
    with db.db() as conn:
        _mail_row(conn, mid)
        conn.execute("DELETE FROM teacher_mail WHERE id = ?", (mid,))
    shutil.rmtree(MAIL_DIR / str(mid), ignore_errors=True)
    return {"ok": True}


HOMELAB_FIELDS = ("pve_host", "pve_token_id", "adguard_host", "adguard_user")
HOMELAB_SECRETS = ("pve_token_secret", "adguard_password")


@app.get("/api/me/setup")
def me_setup():
    with db.db() as conn:
        out = {k: db.get_setting(conn, k) for k in HOMELAB_FIELDS}
        out.update({f"{k}_set": bool(db.get_setting(conn, k)) for k in HOMELAB_SECRETS})
    return out


@app.put("/api/me/setup")
def me_save_setup(values: dict[str, str]):
    """Addresses and logins. A blank secret keeps the saved one."""
    with db.db() as conn:
        for k, v in values.items():
            if k in HOMELAB_FIELDS or (k in HOMELAB_SECRETS and v.strip()):
                conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                             (k, v.strip()))
    homelab.clear_cache()
    return {"ok": True}


@app.post("/api/settings/rotate-feed-token")
def rotate_feed_token():
    import secrets
    with db.db() as conn:
        conn.execute("UPDATE settings SET value = ? WHERE key = 'feed_token'", (secrets.token_urlsafe(24),))
    return {"ok": True}


# ---------------------------------------------------------------- iCal feeds for the iPhones

def _check_token(conn, token: str):
    if token != db.get_setting(conn, "feed_token"):
        raise HTTPException(404)


def _ics(name: str, events: list[icalendar.Event]) -> Response:
    cal = icalendar.Calendar()
    cal.add("prodid", "-//Family Planner//EN")
    cal.add("version", "2.0")
    cal.add("x-wr-calname", name)
    cal.add("x-wr-timezone", str(TZ))
    cal.add("refresh-interval;value=duration", "PT1H")
    for ev in events:
        cal.add_component(ev)
    cal.add_missing_timezones()
    return Response(cal.to_ical(), media_type="text/calendar; charset=utf-8")


@app.get("/feed/{token}/shifts.ics")
def shifts_feed(token: str, person_id: int | None = None):
    with db.db() as conn:
        _check_token(conn, token)
        sql = "SELECT s.*, p.name AS person FROM shifts s JOIN people p ON p.id = s.person_id WHERE date >= ?"
        args: list = [(today() - timedelta(days=60)).isoformat()]
        if person_id:
            sql += " AND person_id = ?"
            args.append(person_id)
        shifts = db.rows(conn.execute(sql, args))
    events = []
    for s in shifts:
        d = date.fromisoformat(s["date"])
        start = datetime.combine(d, datetime.strptime(s["start_time"], "%H:%M").time(), TZ)
        end = datetime.combine(d, datetime.strptime(s["end_time"], "%H:%M").time(), TZ)
        if end <= start:
            end += timedelta(days=1)
        ev = icalendar.Event()
        ev.add("uid", f"shift-{s['id']}@family-planner")
        ev.add("summary", f"{s['person']} – {s['label']}")
        ev.add("dtstart", start)
        ev.add("dtend", end)
        ev.add("dtstamp", datetime.now(TZ))
        if s["notes"]:
            ev.add("description", s["notes"])
        events.append(ev)
    return _ics("Work Shifts", events)


@app.get("/feed/{token}/tasks.ics")
def tasks_feed(token: str):
    with db.db() as conn:
        _check_token(conn, token)
        tasks = db.rows(conn.execute(
            "SELECT t.*, p.name AS person FROM tasks t LEFT JOIN people p ON p.id = t.person_id "
            "WHERE done = 0 AND due_date IS NOT NULL"))
        adults = {r["id"] for r in conn.execute("SELECT id FROM people WHERE is_kid = 0")}
    events = []
    for t in tasks:
        d = date.fromisoformat(t["due_date"])
        ev = icalendar.Event()
        ev.add("uid", f"task-{t['id']}@family-planner")
        ev.add("summary", f"{t['person']}: {t['title']}" if t["person"] else t["title"])
        ev.add("dtstart", d)
        ev.add("dtend", d + timedelta(days=1))
        ev.add("dtstamp", datetime.now(TZ))
        if t["notes"]:
            ev.add("description", t["notes"])
        if t["person_id"] in adults or t["person_id"] is None:  # the adults' and family to-dos alert at 7 am
            alarm = icalendar.Alarm()
            alarm.add("action", "DISPLAY")
            alarm.add("description", t["title"])
            alarm.add("trigger", timedelta(hours=7))
            ev.add_component(alarm)
        events.append(ev)
    return _ics("Family Tasks", events)


@app.get("/feed/{token}/reminders.ics")
def reminders_feed(token: str):
    """Unpaid bills and school lunch ordering dates, each with a 9 am alert, for the adults' iPhones."""
    t = today()
    with db.db() as conn:
        _check_token(conn, token)
        bills = [o for o in _bill_occurrences(conn, t - timedelta(days=30), t + timedelta(days=120)) if not o["paid"]]
        windows = lunch_sync.order_windows(conn)
    entries = [(f"bill-{o['bill_id']}-{o['due_date']}", date.fromisoformat(o["due_date"]),
                f"💲 {o['name']} due" + (f" ({o['amount']})" if o["amount"] else "")) for o in bills]
    for opens, closes in windows:
        if closes >= t - timedelta(days=30):
            entries.append((f"lunch-open-{opens}", opens, f"🍽️ School lunch ordering opens (until {closes:%b} {closes.day})"))
            entries.append((f"lunch-close-{closes}", closes, "🍽️ Last day to order school lunch"))
    events = []
    for uid, d, summary in entries:
        ev = icalendar.Event()
        ev.add("uid", f"{uid}@family-planner")
        ev.add("summary", summary)
        ev.add("dtstart", d)
        ev.add("dtend", d + timedelta(days=1))
        ev.add("dtstamp", datetime.now(TZ))
        alarm = icalendar.Alarm()
        alarm.add("action", "DISPLAY")
        alarm.add("description", summary)
        alarm.add("trigger", timedelta(hours=9))  # 9 am on the day
        ev.add_component(alarm)
        events.append(ev)
    return _ics("Bills & Reminders", events)


# ---------------------------------------------------------------- login

def _safe_next(value: str | None) -> str:
    """Where to go after signing in: a page on this site only."""
    return value if value and value.startswith("/") and not value.startswith("//") else "/"


def _login_page(message: str = "", show_form: bool = True, status: int = 200, next_path: str = "/") -> HTMLResponse:
    html = (STATIC / "login.html").read_text(encoding="utf-8")
    html = html.replace("{message}", f'<p class="login-msg">{message}</p>' if message else "")
    html = html.replace("{form_hidden}", "" if show_form else "hidden")
    html = html.replace("{faceid_hidden}", "" if passkeys.has_passkeys() else "hidden")
    html = html.replace("{next}", html_escape(_safe_next(next_path), quote=True))
    resp = _page("login.html", html)
    resp.status_code = status
    return resp


@app.get("/login")
def login_page(request: Request, next: str | None = None):
    if not auth.is_external(request) and (not auth.password_is_set() or auth.cookie_role(request.cookies.get(auth.COOKIE))):
        return RedirectResponse(_safe_next(next), status_code=303)  # at home and already signed in (or no PIN yet)
    if not auth.password_is_set():
        return _login_page("The family PIN hasn't been set up yet. Set it in Settings from home Wi-Fi.",
                           show_form=False, status=503, next_path=next)
    return _login_page(next_path=next)


@app.post("/login")
async def login(request: Request):
    ip = auth.client_ip(request)
    form = parse_qs((await request.body()).decode("utf-8", "replace"))
    next_path = _safe_next((form.get("next") or ["/"])[0])
    if not auth.password_is_set():
        return _login_page("The family PIN hasn't been set up yet.", show_form=False, status=503, next_path=next_path)
    if auth.locked_out(ip):
        return _login_page("Too many wrong PINs, so PIN sign-in is paused for now. Use Face ID, "
                           "or try again later.", status=429, next_path=next_path)
    role = auth.role_for_pin((form.get("password") or [""])[0])
    if not role:
        auth.record_fail(ip)
        logging.getLogger("planner.auth").warning("wrong PIN from %s", ip)
        await asyncio.sleep(1)
        return _login_page("That PIN isn't right.", status=401, next_path=next_path)
    auth.clear_fails(ip)
    if role == "kid" and not auth.kid_allowed(next_path):
        next_path = "/kids"
    if auth.member_id(role) and not auth.member_allowed(next_path):
        next_path = "/mobile"
    resp = RedirectResponse(next_path, status_code=303)
    auth.set_login_cookie(resp, role, request)
    return resp


@app.get("/logout")
def logout():
    resp = RedirectResponse("/login", status_code=303)
    resp.delete_cookie(auth.COOKIE)
    return resp


class PinIn(BaseModel):
    pin: str
    current_pin: str = ""
    kind: str = "family"  # "family" (adults) or "kids"


@app.put("/api/pin")
def set_pin(request: Request, body: PinIn):
    """Changing the PIN through Cloudflare takes the current PIN. (On the home network this page is only
    reachable before any PIN exists, or with an adult sign-in.)"""
    if not re.match(auth.PIN_RE, body.pin):
        raise HTTPException(400, "Use 4 to 10 digits")
    if body.kind == "kids" and auth.check_password(body.pin) or body.kind != "kids" and auth.role_for_pin(body.pin) == "kid":
        raise HTTPException(400, "The Kids PIN and the family PIN have to be different")
    if auth.someone_has_pin(body.pin):
        raise HTTPException(400, "That PIN is already someone's own PIN. Pick another.")
    if auth.is_external(request) and auth.password_is_set():
        ip = auth.client_ip(request)
        if auth.locked_out(ip):
            raise HTTPException(429, "Too many wrong PINs. Try again later.")
        if not auth.check_password(body.current_pin):
            auth.record_fail(ip)
            raise HTTPException(403, "The current PIN isn't right")
    (auth.set_kids_pin if body.kind == "kids" else auth.set_password)(body.pin)
    auth.clear_fails()
    resp = JSONResponse({"ok": True})
    if auth.is_external(request):
        auth.set_login_cookie(resp, request=request)  # a new PIN logs everyone out, but not the phone that just set it
    return resp


# ---------------------------------------------------------------- first-run setup (/setup)
# Shown until the family is added. Only from the home network, so nobody on the internet can claim a new planner.

_setup_done = {"value": False}


def _set_up() -> bool:
    if not _setup_done["value"]:
        with db.db() as conn:
            _setup_done["value"] = db.is_set_up(conn)
    return _setup_done["value"]


class SetupPerson(BaseModel):
    name: str
    color: str
    is_kid: bool = False
    icon: str = ""


class SetupIn(BaseModel):
    family_name: str
    people: list[SetupPerson]
    pin: str
    holiday_country: str = ""
    holiday_subdiv: str = ""
    latitude: str = ""
    longitude: str = ""
    temp_unit: str = "celsius"
    public_url: str = ""


def _setup_allowed(request: Request) -> None:
    if _set_up():
        raise HTTPException(409, "this planner is already set up")
    if auth.is_external(request):
        raise HTTPException(403, "open the setup from your home network (http://<server address>:8080/setup)")


@app.get("/api/setup")
def setup_info(request: Request):
    return {"needed": not _set_up(), "from_home": not auth.is_external(request), "timezone": str(TZ)}


@app.get("/api/setup/countries")
def setup_countries():
    return holidays.countries()


@app.post("/api/setup")
def setup_save(request: Request, body: SetupIn):
    _setup_allowed(request)
    people = [p for p in body.people if p.name.strip()]
    if not people:
        raise HTTPException(400, "add at least one person")
    if not any(not p.is_kid for p in people):
        raise HTTPException(400, "add at least one adult")
    if not re.match(auth.PIN_RE, body.pin):
        raise HTTPException(400, "the family PIN is 4 to 10 digits")
    if body.temp_unit not in ("celsius", "fahrenheit"):
        raise HTTPException(400, "bad temperature unit")
    for v in (body.latitude, body.longitude):
        if v.strip():
            try:
                float(v)
            except ValueError:
                raise HTTPException(400, "latitude and longitude are numbers")
    with db.db() as conn:
        for i, p in enumerate(people, start=1):
            cur = conn.execute("INSERT INTO people (name, color, is_kid, sort, icon) VALUES (?, ?, ?, ?, ?)",
                               (p.name.strip()[:40], p.color, int(p.is_kid), i, p.icon.strip()[:8]))
            if p.is_kid:
                db.seed_chores(conn, cur.lastrowid)
        for k, v in {"family_name": body.family_name.strip() or "Family", "holiday_country": body.holiday_country.upper(),
                     "holiday_subdiv": body.holiday_subdiv.upper(), "latitude": body.latitude.strip(),
                     "longitude": body.longitude.strip(), "temp_unit": body.temp_unit,
                     "public_url": body.public_url.strip().rstrip("/"), "lunch_auto": "0"}.items():
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, v))
        house.seed_emergency(conn)
    auth.set_password(body.pin)
    holidays.reset()
    _setup_done["value"] = True
    resp = JSONResponse({"ok": True})
    auth.set_login_cookie(resp, request=request)  # the computer that did the setup is signed in
    return resp


@app.get("/setup")
def setup_page():
    if _set_up():
        return RedirectResponse("/", status_code=303)
    return _page("setup.html")


# ---------------------------------------------------------------- rewards (My page → Kids; the kids see their progress)

class RewardIn(BaseModel):
    title: str
    cost: int
    person_id: int | None = None  # None = either kid


@app.get("/api/me/rewards")
def me_rewards():
    with db.db() as conn:
        rewards = db.rows(conn.execute("SELECT * FROM rewards ORDER BY cost, sort, id"))
        kids = [r["id"] for r in conn.execute("SELECT id FROM people WHERE is_kid = 1")]
        return {"rewards": rewards,
                "balances": {str(k): _star_balance(conn, k) for k in kids},
                "given": db.rows(conn.execute(
                    "SELECT l.*, p.name FROM reward_log l JOIN people p ON p.id = l.person_id ORDER BY l.at DESC LIMIT 20"))}


@app.post("/api/me/rewards")
def me_add_reward(r: RewardIn):
    if not r.title.strip() or not 1 <= r.cost <= 1000:
        raise HTTPException(400, "give it a name and a cost from 1 to 1000")
    with db.db() as conn:
        if r.person_id is not None:
            _kid(conn, r.person_id)
        conn.execute("INSERT INTO rewards (person_id, title, cost) VALUES (?, ?, ?)", (r.person_id, r.title.strip()[:80], r.cost))
    return {"ok": True}


@app.delete("/api/me/rewards/{rid}")
def me_delete_reward(rid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM rewards WHERE id = ?", (rid,))
    return {"ok": True}


class GiveIn(BaseModel):
    person_id: int


@app.post("/api/me/rewards/{rid}/give")
def me_give_reward(rid: int, body: GiveIn):
    with db.db() as conn:
        kid = _kid(conn, body.person_id)
        r = conn.execute("SELECT * FROM rewards WHERE id = ?", (rid,)).fetchone()
        if not r:
            raise HTTPException(404, "no such reward")
        if _star_balance(conn, kid["id"]) < r["cost"]:
            raise HTTPException(400, f"{kid['name']} doesn't have enough saved up yet")
        conn.execute("INSERT INTO reward_log (person_id, title, cost, at) VALUES (?, ?, ?, ?)",
                     (kid["id"], r["title"], r["cost"], datetime.now(TZ).isoformat(timespec="minutes")))
        return {"balance": _star_balance(conn, kid["id"])}


# ---------------------------------------------------------------- money (My page → Kids; the kids see their balance)
# Each kid's settings are in the setting money_<id>: weekly (cents), payday (0 = Monday), need_stars (the stars they
# must earn that week for the allowance, 0 = none) and star_cents (what one saved star is worth when cashed in, 0 = off).

MONEY_DEFAULT = {"weekly": 0, "payday": 5, "need_stars": 0, "star_cents": 0}


def _dollars(cents: int) -> str:
    return f"{'-' if cents < 0 else ''}${abs(cents) / 100:,.2f}"


def _money_settings(conn, pid: int) -> dict:
    raw = db.get_setting(conn, f"money_{pid}")
    return {**MONEY_DEFAULT, **(json.loads(raw) if raw else {})}


def _week_stars(conn, pid: int, d: date) -> int:
    monday = d - timedelta(days=d.weekday())
    return conn.execute("SELECT COUNT(*) FROM chore_done d JOIN chores c ON c.id = d.chore_id WHERE c.person_id = ? "
                        "AND d.date >= ? AND d.date <= ?", (pid, monday.isoformat(), d.isoformat())).fetchone()[0]


def _money(conn, pid: int, brief: bool = False) -> dict | None:
    m = _money_settings(conn, pid)
    balance = conn.execute("SELECT COALESCE(SUM(cents), 0) FROM money_log WHERE person_id = ?", (pid,)).fetchone()[0]
    log = db.rows(conn.execute("SELECT l.*, p.name AS by_name FROM money_log l LEFT JOIN people p ON p.id = l.by_person "
                               "WHERE l.person_id = ? ORDER BY l.at DESC, l.id DESC LIMIT ?", (pid, 5 if brief else 30)))
    if brief and not (m["weekly"] or m["star_cents"] or log):
        return None  # money isn't used for this kid
    t = today()
    payday = t + timedelta(days=(m["payday"] - t.weekday()) % 7)
    return {"balance": balance, "settings": m, "log": log, "next_payday": payday.isoformat() if m["weekly"] else None,
            "week_stars": _week_stars(conn, pid, t), "stars": _star_balance(conn, pid)}


def _money_add(conn, pid: int, cents: int, kind: str, note: str, by: int | None = None, stars: int = 0, week: str = "") -> None:
    conn.execute("INSERT INTO money_log (person_id, cents, kind, note, stars, week, at, by_person) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                 (pid, cents, kind, note, stars, week, datetime.now(TZ).replace(tzinfo=None).isoformat(timespec="minutes"), by))


def pay_allowances(now: datetime) -> list[tuple[int, str, str]]:
    """On each kid's payday (from 8 am), add the week's allowance once. Returns (kid, title, body) to tell them."""
    if now.hour < 8:
        return []
    out = []
    with db.db() as conn:
        for k in db.rows(conn.execute("SELECT id, name FROM people WHERE is_kid = 1")):
            m = _money_settings(conn, k["id"])
            if not m["weekly"] or now.weekday() != m["payday"]:
                continue
            y, w, _ = now.date().isocalendar()
            week = f"{y}-W{w:02d}"
            if conn.execute("SELECT 1 FROM money_log WHERE person_id = ? AND week = ?", (k["id"], week)).fetchone():
                continue
            stars = _week_stars(conn, k["id"], now.date())
            short = bool(m["need_stars"]) and stars < m["need_stars"]
            try:  # the unique (person, week) index makes sure a week is only ever paid once
                _money_add(conn, k["id"], 0 if short else m["weekly"], "allowance",
                           f"No allowance this week: {stars} of {m['need_stars']} stars" if short else "Weekly allowance", week=week)
            except sqlite3.IntegrityError:
                continue
            if short:
                out.append((k["id"], "💰 No allowance this week", f"You got {stars} of {m['need_stars']} stars. Next week!"))
                continue
            bal = conn.execute("SELECT SUM(cents) FROM money_log WHERE person_id = ?", (k["id"],)).fetchone()[0]
            out.append((k["id"], f"💰 Allowance: {_dollars(m['weekly'])}", f"You have {_dollars(bal)} saved."))
    return out


@app.get("/api/me/money")
def me_money():
    with db.db() as conn:
        return [{"kid": k, **_money(conn, k["id"])} for k in
                db.rows(conn.execute("SELECT id, name, color, icon FROM people WHERE is_kid = 1 ORDER BY sort, id"))]


class MoneySettingsIn(BaseModel):
    weekly: float = 0        # dollars
    payday: int = 5
    need_stars: int = 0
    star_cents: int = 0


@app.put("/api/me/money/{pid}/settings")
def me_money_settings(pid: int, body: MoneySettingsIn):
    if not (0 <= body.weekly <= 200 and 0 <= body.payday <= 6 and 0 <= body.need_stars <= 500 and 0 <= body.star_cents <= 500):
        raise HTTPException(400, "those numbers are out of range")
    with db.db() as conn:
        _kid(conn, pid)
        value = {"weekly": round(body.weekly * 100), "payday": body.payday, "need_stars": body.need_stars, "star_cents": body.star_cents}
        conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (f"money_{pid}", json.dumps(value)))
    return value


class MoneyIn(BaseModel):
    amount: float            # dollars: positive adds; "spent" is taken off
    kind: str = "other"
    note: str = ""
    by_person: int | None = None


@app.post("/api/me/money/{pid}")
def me_money_add(pid: int, body: MoneyIn):
    if body.kind not in ("gift", "spent", "other", "allowance") or not body.amount or abs(body.amount) > 1000:
        raise HTTPException(400, "put in an amount up to $1,000")
    cents = round(body.amount * 100)
    if body.kind == "spent":
        cents = -abs(cents)
    with db.db() as conn:
        _kid(conn, pid)
        _money_add(conn, pid, cents, body.kind, body.note.strip()[:80], body.by_person)
        return _money(conn, pid)


class CashInIn(BaseModel):
    stars: int
    by_person: int | None = None


@app.post("/api/me/money/{pid}/cash-in")
def me_cash_in(pid: int, body: CashInIn):
    """Turn saved stars into money: they come off like a reward (reward_log), and the money goes in."""
    with db.db() as conn:
        kid = _kid(conn, pid)
        m = _money_settings(conn, pid)
        if not m["star_cents"]:
            raise HTTPException(400, "set what a star is worth first (⚙️ Allowance)")
        have = _star_balance(conn, pid)
        if not 1 <= body.stars <= have:
            raise HTTPException(400, f"{kid['name']} has {have} stars saved")
        cents = body.stars * m["star_cents"]
        conn.execute("INSERT INTO reward_log (person_id, title, cost, at) VALUES (?, ?, ?, ?)",
                     (pid, f"💰 Cashed in for {_dollars(cents)}", body.stars, datetime.now(TZ).replace(tzinfo=None).isoformat(timespec="minutes")))
        _money_add(conn, pid, cents, "stars", f"{body.stars} stars cashed in", body.by_person, stars=body.stars)
        return _money(conn, pid)


@app.delete("/api/me/money/entry/{eid}")
def me_money_undo(eid: int):
    with db.db() as conn:
        row = conn.execute("SELECT * FROM money_log WHERE id = ?", (eid,)).fetchone()
        if not row:
            raise HTTPException(404, "no such entry")
        if row["stars"]:  # give the stars back
            conn.execute("DELETE FROM reward_log WHERE id = (SELECT id FROM reward_log WHERE person_id = ? AND cost = ? "
                         "AND title LIKE '💰 Cashed in%' ORDER BY id DESC LIMIT 1)", (row["person_id"], row["stars"]))
        conn.execute("DELETE FROM money_log WHERE id = ?", (eid,))
        return _money(conn, row["person_id"])


# ---------------------------------------------------------------- notifications on the adults' phones
# A phone subscribes for one adult (the phone says who it is); each adult picks topics:
#   evening  the 8 pm "tomorrow" check        homelab  Proxmox, new devices, slow internet (My page)

ALERT_TOPICS = ("evening", "meds", "homelab")


def _topics(conn, pid: int) -> list[str]:
    raw = db.get_setting(conn, f"alert_topics_{pid}")
    return json.loads(raw) if raw else ["evening", "meds"]


def _alert_person(request: Request, pid: int | None) -> int:
    """Adults pick whose phone this is; a phone-only sign-in is always themselves."""
    member = auth.member_id(auth.cookie_role(request.cookies.get(auth.COOKIE)))
    if member:
        return member
    with db.db() as conn:
        if not pid or not conn.execute("SELECT 1 FROM people WHERE id = ? AND is_kid = 0", (pid,)).fetchone():
            raise HTTPException(400, "pick whose phone this is")
    return pid


@app.get("/api/alerts/info")
def alerts_info(request: Request):
    member = auth.member_id(auth.cookie_role(request.cookies.get(auth.COOKIE)))
    with db.db() as conn:
        adults = db.rows(conn.execute("SELECT id, name, icon FROM people WHERE is_kid = 0 ORDER BY sort, id"))
        if member:
            adults = [a for a in adults if a["id"] == member]
        for a in adults:
            a["topics"] = _topics(conn, a["id"])
            a["phones"] = conn.execute("SELECT COUNT(*) FROM push_subs WHERE person_id = ?", (a["id"],)).fetchone()[0]
    return {"key": push.public_key(), "adults": adults, "member": member, "homelab": not member}


class AlertSubIn(BaseModel):
    person_id: int | None = None
    subscription: dict


@app.post("/api/alerts/subscribe")
def alerts_subscribe(request: Request, body: AlertSubIn):
    pid = _alert_person(request, body.person_id)
    try:
        push.save(pid, body.subscription)
    except (KeyError, TypeError):
        raise HTTPException(400, "bad subscription")
    return {"ok": True}


class AlertTopicsIn(BaseModel):
    person_id: int | None = None
    topics: list[str]


@app.put("/api/alerts/topics")
def alerts_topics(request: Request, body: AlertTopicsIn):
    pid = _alert_person(request, body.person_id)
    member = auth.member_id(auth.cookie_role(request.cookies.get(auth.COOKIE)))
    topics = [t for t in body.topics if t in ALERT_TOPICS and not (member and t == "homelab")]
    with db.db() as conn:
        conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (f"alert_topics_{pid}", json.dumps(topics)))
    return {"topics": topics}


class AlertTestIn(BaseModel):
    person_id: int | None = None


@app.post("/api/alerts/test")
def alerts_test(request: Request, body: AlertTestIn):
    pid = _alert_person(request, body.person_id)
    msg = _evening_message(today() + timedelta(days=1)) or ("🌙 Tomorrow", "Nothing special tomorrow.", "/mobile")
    return {"sent": push.send(pid, *msg)}


def _evening_message(t: date) -> tuple[str, str, str] | None:
    """The 8 pm check: what tomorrow needs, for the adults. None if there's nothing to say."""
    lines = []
    with db.db() as conn:
        kids = db.rows(conn.execute("SELECT id, name FROM people WHERE is_kid = 1 ORDER BY sort, id"))
        lunch = (_lunch_days(conn, t, t + timedelta(days=1)) or [{}])[0]
        infos = [(k, _school_day(conn, t, k["name"])) for k in kids]
        closed = [info["reason"] for _, info in infos if not info["school"]]
        if kids and len(closed) == len(infos):
            if closed[0] != "Weekend":
                lines.append(f"🎉 No school: {closed[0]}")
        else:
            for k, info in infos:
                if not info["school"]:
                    continue
                bits = [f"Day {info['rotation']}" if info.get("rotation") else "School"]
                special = info.get("special") or ""
                if special:
                    bits.append(special)
                if "Gym" in special:
                    bits.append("sneakers")
                if "Library" in special:
                    bits.append("library book")
                choice = next((x["choice"] for x in lunch.get("kids", []) if x["person_id"] == k["id"]), None)
                if choice == "buy":
                    bits.append(f"🍽️ {lunch.get('menu') or 'school lunch'}")
                elif choice == "pack":
                    bits.append("🥪 packed lunch")
                lines.append(f"{k['name']}: " + " · ".join(bits))
        fw = _day_weather(weather(conn), t)
        if fw:
            lines.append(f"{weatherish(fw['code'])} {fw['hi']}° / {fw['lo']}°" + (": " + " · ".join(fw["hints"]) if fw.get("hints") else ""))
        school_events = _school_events(conn, t, t + timedelta(days=1)).get(t.isoformat(), [])
        lines += [f"📅 {e}" for e in school_events]
        for it in agenda(conn, t, t + timedelta(days=1)):
            if it["source"] in ("appt", "google"):
                who = conn.execute("SELECT name FROM people WHERE id = ?", (it["person_id"],)).fetchone() if it["person_id"] else None
                when = "" if it["all_day"] else f"{_clock(it['start_time'])} "
                lines.append(f"📍 {when}{it['title']}" + (f" ({who['name']})" if who else ""))
        tasks = db.rows(conn.execute(
            "SELECT t.title, t.due_date, p.name FROM tasks t LEFT JOIN people p ON p.id = t.person_id "
            "WHERE t.done = 0 AND t.due_date IS NOT NULL AND t.due_date <= ? ORDER BY t.due_date", (t.isoformat(),)))
        for task in tasks:
            late = task["due_date"] < t.isoformat()
            title = task["title"].lstrip("📝📋✏️ ")  # the line gets its own icon
            icon = "💳" if school_mail.is_payment(title) else "⚠️" if late else "📝"
            lines.append(f"{icon} {title.removeprefix('💳 ')}" + (" (overdue)" if late else ""))
        for m in conn.execute("SELECT m.name, m.puffs_left, p.name AS person FROM meds m JOIN people p ON p.id = m.person_id "
                              "WHERE m.active = 1 AND m.kind = 'puffer' AND m.puffs_left IS NOT NULL AND m.puffs_left < ?",
                              (meds.LOW_PUFFS,)):
            lines.append(f"🫁 {m['person']}'s {m['name'].split(':')[0].split('(')[0].strip()}: about {m['puffs_left']} puffs left, time to refill")
        for opens, closes in lunch_sync.order_windows(conn):
            if opens == t:
                lines.append(f"🍽️ School lunch ordering opens tomorrow (until {closes:%b} {closes.day})")
            if closes == t:
                lines.append("🍽️ Tomorrow is the last day to order school lunch")
        lines += house.reminders(conn, t)
        for k in kids:
            m = _money_settings(conn, k["id"])
            if m["weekly"] and t.weekday() == m["payday"]:
                lines.append(f"💰 {k['name']}'s allowance ({_dollars(m['weekly'])}) is added tomorrow")
        tonight = t - timedelta(days=1)
        school_tomorrow = school.closed_reason(t, _school_closures(conn)) is None
        for k in kids:
            left = [c["title"] for c in db.rows(conn.execute(
                "SELECT c.title, c.school_days FROM chores c WHERE c.person_id = ? AND c.routine = 'homework' "
                "AND NOT EXISTS(SELECT 1 FROM chore_done d WHERE d.chore_id = c.id AND d.date = ?)", (k["id"], tonight.isoformat())))
                if _night_fits(c["school_days"], school_tomorrow)] if tonight == today() else []
            if left:
                lines.append(f"📚 {k['name']} hasn't ticked: " + ", ".join(left))
    if not lines:
        return None
    return f"🌙 Tomorrow, {t:%A}", "\n".join(lines), "/me"


def _subscribed(conn, topic: str) -> list[int]:
    adults = [r["person_id"] for r in conn.execute(
        "SELECT DISTINCT s.person_id FROM push_subs s JOIN people p ON p.id = s.person_id WHERE p.is_kid = 0")]
    return [a for a in adults if topic in _topics(conn, a)]


def _evening_messages(now: datetime) -> list[tuple[str, int, str, str, str]]:
    if not ("20:00" <= now.strftime("%H:%M") < "20:30"):
        return []
    with db.db() as conn:
        people = _subscribed(conn, "evening")
    msg = _evening_message(now.date() + timedelta(days=1)) if people else None
    return [(f"eve-{now.date()}-{pid}", pid, *msg) for pid in people] if msg else []


def notify_adults(title: str, body: str, url: str, exclude: int | None = None, topic: str = "meds") -> None:
    """Tell every adult with a phone for this topic (in the background), except the one who did it."""
    def send():
        with db.db() as conn:
            people = [p for p in _subscribed(conn, topic) if p != exclude]
        for p in people:
            push.send(p, title, body, url)
    threading.Thread(target=send, daemon=True).start()


def _med_reminders(now: datetime) -> list[tuple[str, int, str, str, str]]:
    """Medicine reminders due now: to the person (an adult's own pills), or to the adults for a kid's medicine."""
    out = []
    with db.db() as conn:
        adults = _subscribed(conn, "meds")
    for key, pid, title, body, url in meds.reminders(now.replace(tzinfo=None)):
        for p in ([pid] if pid else adults):
            out.append((f"{key}-{p}", p, title, body, url))
    return out


_homelab_check = {"at": 0.0}


def _homelab_alerts(now: datetime) -> list[tuple[str, int, str, str, str]]:
    """Every 5 minutes: a container or VM stopping (or coming back), a device never seen before, a slow speed test.
    What's been seen is kept in the setting homelab_alert_state, so each thing is told once."""
    if time.time() - _homelab_check["at"] < 300:
        return []
    _homelab_check["at"] = time.time()
    with db.db() as conn:
        people = _subscribed(conn, "homelab")
        if not people:
            return []
        state = json.loads(db.get_setting(conn, "homelab_alert_state", "{}"))
        news = []
        p = homelab.proxmox(conn)
        if p.get("guests"):
            status = {str(g["id"]): (g["status"], f"{g['id']} · {g['name']}") for g in p["guests"]}
            old = state.get("guests")
            if old is not None:
                for gid, (st, name) in status.items():
                    before = old.get(gid)
                    if before == "running" and st != "running":
                        news.append((f"guest-{gid}-{now:%Y%m%d%H%M}", f"🔴 {name} stopped", f"Proxmox says it's {st}."))
                    elif before and before != "running" and st == "running":
                        news.append((f"guest-{gid}-{now:%Y%m%d%H%M}", f"🟢 {name} is running again", ""))
            state["guests"] = {gid: st for gid, (st, _) in status.items()}
        devices = homelab.devices(conn)
        macs = {d["mac"]: d for d in devices["devices"]}
        known = state.get("macs")
        if known is not None:
            for mac, d in macs.items():
                if mac not in known:
                    label = d["name"] or d["vendor"] or d.get("guess") or "Unknown device"
                    news.append((f"mac-{mac}", "📶 New device on the network", f"{label} · {d['ip']} · {mac}"))
        if macs:
            state["macs"] = sorted(set(known or []) | set(macs))
        tests = [x for x in homelab.speedtests()["tests"] if not x.get("error")]
        if len(tests) >= 6 and tests[-1]["at"] != state.get("speed_at"):
            last, before = tests[-1], sorted(x["down_mbps"] for x in tests[-49:-1])
            normal = before[len(before) // 2]
            if last["down_mbps"] < normal * 0.5:
                news.append((f"speed-{last['at']}", "🐢 Internet is slow",
                             f"{last['down_mbps']:.0f} Mb/s down (normally about {normal:.0f}) · {last['ping_ms']} ms"))
            state["speed_at"] = last["at"]
        conn.execute("INSERT INTO settings (key, value) VALUES ('homelab_alert_state', ?) "
                     "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (json.dumps(state),))
    return [(f"{key}-{pid}", pid, title, body, "/me") for key, title, body in news for pid in people]


# ---------------------------------------------------------------- backups (Settings → Backups)
# A copy of the database every night at 2:30 in data/backups (the last 14 are kept). Copying them off this
# server is still to be planned; until then, "Download" gets the newest one.

BACKUP_DIR = db.DATA_DIR / "backups"
BACKUP_KEEP = 14


def make_backup() -> str:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    name = f"planner-{datetime.now(TZ):%Y-%m-%d-%H%M}.db"
    src = sqlite3.connect(db.DB_PATH)
    dst = sqlite3.connect(BACKUP_DIR / name)
    with dst:
        src.backup(dst)  # a consistent copy even while the planner is writing
    src.close()
    dst.close()
    for old in sorted(BACKUP_DIR.glob("planner-*.db"))[:-BACKUP_KEEP]:
        old.unlink()
    with db.db() as conn:
        conn.execute("INSERT INTO settings (key, value) VALUES ('backup_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (datetime.now(TZ).isoformat(timespec="minutes"),))
    return name


def _maintenance_loop() -> None:
    while True:
        try:
            now = datetime.now(TZ)
            with db.db() as conn:
                last = db.get_setting(conn, "backup_last")
            if now.strftime("%H:%M") >= "02:30" and not last.startswith(now.date().isoformat()):
                logging.getLogger("planner.backup").info("nightly backup: %s", make_backup())
        except Exception:
            logging.getLogger("planner.backup").exception("backup failed")
        try:
            for pid, title, body in pay_allowances(datetime.now(TZ)):
                with db.db() as conn:
                    name = conn.execute("SELECT name FROM people WHERE id = ?", (pid,)).fetchone()["name"]
                push.send(pid, title, body, f"/kids/{name.lower()}")
        except Exception:
            logging.getLogger("planner.money").exception("allowance failed")
        time.sleep(300)


@app.get("/api/backups")
def list_backups():
    files = sorted(BACKUP_DIR.glob("planner-*.db"), reverse=True) if BACKUP_DIR.exists() else []
    with db.db() as conn:
        return {"last": db.get_setting(conn, "backup_last"), "keep": BACKUP_KEEP,
                "files": [{"name": f.name, "size": f.stat().st_size} for f in files]}


@app.post("/api/backups")
def backup_now():
    return {"name": make_backup()}


@app.get("/api/backups/{name}")
def download_backup(name: str):
    if not re.fullmatch(r"planner-[\d-]+\.db", name) or not (BACKUP_DIR / name).exists():
        raise HTTPException(404, "no such backup")
    return FileResponse(BACKUP_DIR / name, filename=name, media_type="application/octet-stream")


# ---------------------------------------------------------------- Admin (/admin): everything at a glance

@app.get("/api/admin/overview")
def admin_overview():
    t = today()
    with db.db() as conn:
        get = lambda k: db.get_setting(conn, k)
        people = db.rows(conn.execute("SELECT id, name, icon, is_kid FROM people ORDER BY sort, id"))
        for p in people:
            p["phones"] = conn.execute("SELECT COUNT(*) FROM push_subs WHERE person_id = ?", (p["id"],)).fetchone()[0]
            p["topics"] = [] if p["is_kid"] else _topics(conn, p["id"])
        cals = [{"name": c["name"], "error": calendars.last_error(c["url"])} for c in db.rows(conn.execute("SELECT * FROM calendars"))]
        windows = [(o, c) for o, c in lunch_sync.order_windows(conn) if c >= t]
        mail = db.rows(conn.execute(
            "SELECT p.name, COUNT(*) AS waiting FROM teacher_mail m JOIN people p ON p.id = m.person_id "
            "WHERE m.applied = '' GROUP BY p.name"))
        overdue = conn.execute("SELECT COUNT(*) FROM tasks WHERE done = 0 AND due_date < ?", (t.isoformat(),)).fetchone()[0]
        upkeep = [j for j in house.jobs(conn, t) if j["state"] in ("overdue", "soon")]
        payments = [r for r in db.rows(conn.execute(
            "SELECT t.title, t.notes, t.due_date, p.name FROM tasks t LEFT JOIN people p ON p.id = t.person_id "
            "WHERE t.done = 0 ORDER BY t.due_date IS NULL, t.due_date")) if school_mail.is_payment(f"{r['title']} {r['notes']}")]
        pushes = db.rows(conn.execute(
            "SELECT l.at, l.title, l.phones, p.name FROM push_log l LEFT JOIN people p ON p.id = l.person_id ORDER BY l.id DESC LIMIT 15"))
        gstatus = gcal.status(conn)
        homelab_on = {"proxmox": bool(get("pve_token_id")), "adguard": bool(get("adguard_user"))}
        backup_last = get("backup_last")
        lunch = {"synced": get("lunch_synced_at"), "error": get("lunch_sync_error")}
    tests =[x for x in homelab.speedtests()["tests"] if not x.get("error")]
    backups = list_backups()
    return {
        "today": t.isoformat(),
        "backups": {"last": backup_last, "count": len(backups["files"])},
        "people": people,
        "google": gstatus, "calendars": cals,
        "lunch": {**lunch, "next_window": [windows[0][0].isoformat(), windows[0][1].isoformat()] if windows else None},
        "mail_waiting": mail,
        "overdue": overdue, "payments": payments, "upkeep": upkeep,
        "pushes": pushes,
        "homelab": {**homelab_on, "last_scan": homelab._read("devices.json", {}).get("last_scan"),
                    "online": len(homelab._read("devices.json", {}).get("online_now", [])),
                    "speed": tests[-1] if tests else None},
    }


@app.get("/report")
def report_page():
    """A printable doctor report of one person's medicine, puffers and symptoms (adults and phone-only sign-ins)."""
    return _page("report.html")


@app.get("/house")
def house_page():
    """Car and house upkeep, contacts and the sitter sheet (adults and phone-only sign-ins)."""
    return _page("house.html")


@app.get("/meals")
def meals_page():
    """Suppers, the grocery list, what's in the house, recipes and flyer deals (adults and phone-only sign-ins)."""
    return _page("meals.html")


@app.get("/admin")
def admin_page():
    """The full planner's Settings, one tab per area, with an Overview (index.html in admin mode)."""
    return _page("index.html")


# ---------------------------------------------------------------- pages

@app.get("/health")
def health():
    return {"ok": True, "version": __version__}


@app.get("/display")
def display_page():
    return _page("display.html")


@app.get("/mobile")
def mobile_page():
    """The wall screen, laid out for a phone (display.js switches layout on the path)."""
    return _page("display.html")


@app.get("/my-shifts")
def my_shifts_page():
    """Phone page for a phone-access person: their own shifts, and appointments for anyone."""
    return _page("myshifts.html")


@app.get("/me")
def me_page():
    """An adult's phone page: the family board, calendar, the kids, and the homelab (adults only, like /api/me/*)."""
    return _page("me.html")


@app.get("/kids")
@app.get("/kids/{name}")
def kids_page(name: str = ""):
    """/kids/<name> (kids.js picks the kid from the address)."""
    return _page("kids.html")


@app.get("/")
def phone_page():
    return _page("index.html")


app.mount("/", StaticFiles(directory=STATIC), name="static")

# Kids' 7 am morning summary on their phones. PLANNER_SCHEDULER=0 turns it off (e.g. for tests).
if os.environ.get("PLANNER_SCHEDULER", "1") == "1":
    push.start(_morning_message, lambda now: _bedtime_messages(now) + _evening_messages(now) + _homelab_alerts(now)
               + _med_reminders(now))
    threading.Thread(target=_maintenance_loop, daemon=True, name="maintenance").start()
