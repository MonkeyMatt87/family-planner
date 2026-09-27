"""Optional: pulls the school lunch menu from the School Lunch Association (schoollunch.ca, Newfoundland and
Labrador). Off until a school is picked in Settings → School lunch menu. Other families type or paste their menu
on the Lunch tab. It's also an example of a menu importer to copy for another lunch provider.

Their menu pages load one JSON file with every school in it:
    {"Some Elementary": [{"month": "September", "day": 24, "weekday": "Thursday",
                                 "items": ["Macaroni & Cheese", "Garlic Naan Bread", ...]}, ...], ...}
items[0] is the main dish. Days with no lunch service are left out (or carry status "no_service").
There's no year in the data, so each date gets the year that puts it closest to today.
"""
import difflib
import json
import logging
import re
import threading
import time
from datetime import date, datetime, timedelta

import httpx

from . import db

log = logging.getLogger("planner.lunch")

DEFAULT_URL = "https://schoollunch.ca/menu-data.json"
NO_SERVICE = "No lunch service"
SYNC_EVERY = 6 * 3600
RETRY_AFTER = 30 * 60
MONTHS = ["january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december"]

_lock = threading.Lock()
_last_try = 0.0


def guess_year(month: int, day: int, today: date) -> int:
    """School menus rarely carry a year; pick the one that puts the date closest to today."""
    best = None
    for y in (today.year - 1, today.year, today.year + 1):
        try:
            d = date(y, month, day)
        except ValueError:
            continue
        if best is None or abs((d - today).days) < abs((best - today).days):
            best = d
    if best is None:
        raise ValueError
    return best.year


# ---------------------------------------------------------------- favourites

def _norm(s: str) -> str:
    s = s.lower().replace("&", " and ")
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s).split())


def matches(dish: str, likes: list[str]) -> bool:
    """True if the dish is one of the likes, forgiving spelling slips ('Macaronie and Cheese')."""
    d = _norm(dish)
    if not d:
        return False
    return any(difflib.SequenceMatcher(None, d, _norm(like)).ratio() >= 0.85 for like in likes if like.strip())


# ---------------------------------------------------------------- sync

def _save(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def sync(today: date) -> dict:
    """Download the menu and store each day's main dish. Returns {"imported": n} or {"error": "..."}."""
    global _last_try
    with _lock:
        _last_try = time.time()
        with db.db() as conn:
            url = db.get_setting(conn, "lunch_menu_url") or DEFAULT_URL
            school = db.get_setting(conn, "lunch_school").strip()
        if not school:
            return {"error": "pick your school first"}
        try:
            resp = httpx.get(url, timeout=20, follow_redirects=True, headers={"User-Agent": "family-planner"})
            resp.raise_for_status()
            data = resp.json()
            names = {n.lower(): n for n in data}
            if school.lower() not in names:
                close = difflib.get_close_matches(school, list(data), n=1)
                raise ValueError(f"school '{school}' isn't in the menu" + (f" (did you mean '{close[0]}'?)" if close else ""))
            days = data[names[school.lower()]]
            menus = {}
            for d in days:
                if d.get("status") == "no_service" or not d.get("items"):
                    continue
                month = MONTHS.index(d["month"].lower()) + 1
                day = date(guess_year(month, int(d["day"]), today), month, int(d["day"]))
                menus[day.isoformat()] = d["items"][0].strip()
        except Exception as exc:
            log.warning("lunch menu sync failed: %s", exc)
            with db.db() as conn:
                _save(conn, "lunch_sync_error", str(exc)[:200])
            return {"error": str(exc)}

        with db.db() as conn:
            for iso, main in menus.items():
                conn.execute(
                    "INSERT INTO lunch_menu (date, menu) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET menu = excluded.menu",
                    (iso, main),
                )
            # School weekdays inside the menu's range with no lunch listed (holidays, PD days).
            if menus:
                d, last = date.fromisoformat(min(menus)), date.fromisoformat(max(menus))
                while d <= last:
                    iso = d.isoformat()
                    if d.weekday() < 5 and iso not in menus:
                        conn.execute(
                            "INSERT INTO lunch_menu (date, menu) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET menu = "
                            "excluded.menu WHERE lunch_menu.menu = ''",
                            (iso, NO_SERVICE),
                        )
                    d += timedelta(days=1)
            _save(conn, "lunch_synced_at", datetime.now().isoformat(timespec="minutes"))
            _save(conn, "lunch_sync_error", "")
        log.info("lunch menu synced: %d days for %s", len(menus), school)
        _sync_order_windows(school)
        return {"imported": len(menus)}


def _page_url(school: str) -> str:
    return "https://schoollunch.ca/menu-" + re.sub(r"[^a-z0-9]+", "-", school.lower()).strip("-") + ".html"


def _sync_order_windows(school: str) -> None:
    """The menu page lists each month's ordering window, e.g. ['2026-10-13T09:00:00-02:30', '2026-10-21T23:59:00-02:30']."""
    try:
        resp = httpx.get(_page_url(school), timeout=20, follow_redirects=True, headers={"User-Agent": "family-planner"})
        resp.raise_for_status()
        block = re.search(r"const OW\s*=\s*\[(.*?)\]\s*\.map", resp.text, re.S)
        pairs = re.findall(r"\['(\d{4}-\d{2}-\d{2})T[^']*',\s*'(\d{4}-\d{2}-\d{2})T[^']*'\]", block.group(1)) if block else []
        if pairs:
            with db.db() as conn:
                _save(conn, "lunch_order_windows", json.dumps(pairs))
    except Exception as exc:
        log.warning("couldn't read the lunch ordering dates: %s", exc)


def order_windows(conn) -> list[tuple[date, date]]:
    try:
        return [(date.fromisoformat(a), date.fromisoformat(b))
                for a, b in json.loads(db.get_setting(conn, "lunch_order_windows", "[]"))]
    except (ValueError, TypeError):
        return []


def maybe_sync(today: date) -> None:
    """Called when lunch data is read: refresh if the last sync is old. Failures retry after 30 min."""
    if time.time() - _last_try < RETRY_AFTER:
        return
    with db.db() as conn:
        if db.get_setting(conn, "lunch_auto", "0") != "1" or not db.get_setting(conn, "lunch_school").strip():
            return
        synced = db.get_setting(conn, "lunch_synced_at")
    if synced and (datetime.now() - datetime.fromisoformat(synced)).total_seconds() < SYNC_EVERY:
        return
    sync(today)
