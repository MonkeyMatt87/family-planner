"""School days: weekends, summer, holidays and closures, plus an optional "Day 1–N" rotation.

Set in Settings → Kids & school:
  school_start / school_end  the first and last day of the school year (YYYY-MM-DD)
  school_rotation            the length of a rotating schedule (e.g. 6 for Day 1–6), or 0 for none
Closures are days marked "No school" on the Lunch tab (storm days, PD days) and public holidays.
"""
import time
from datetime import date, timedelta

from . import db, holidays

_config: dict = {"at": 0.0}


def _settings() -> dict:
    if time.time() - _config["at"] > 60:
        with db.db() as conn:
            get = lambda k: db.get_setting(conn, k).strip()
            rotation = get("school_rotation")
            _config.update(start=_day(get("school_start")), end=_day(get("school_end")),
                           rotation=int(rotation) if rotation.isdigit() else 0, at=time.time())
    return _config


def reset() -> None:
    _config["at"] = 0.0


def _day(value: str) -> date | None:
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def year_bounds(d: date) -> tuple[date, date]:
    """The school year around `d`: the saved dates, else September 1 to June 30."""
    s = _settings()
    if s["start"] and s["end"]:
        return s["start"], s["end"]
    start_year = d.year if d.month >= 7 else d.year - 1
    return date(start_year, 9, 1), date(start_year + 1, 6, 30)


def rotation_length() -> int:
    return _settings()["rotation"]


def closed_reason(d: date, closures: dict[str, str] | None = None) -> str | None:
    """Why there's no school on this day (weekend, summer, a holiday or a closure), or None if there is school.
    `closures` maps "YYYY-MM-DD" to a reason (days marked on the Lunch tab)."""
    if d.weekday() >= 5:
        return "Weekend"
    first, last = year_bounds(d)
    if not first <= d <= last:
        return "Summer"
    if closures and d.isoformat() in closures:
        return closures[d.isoformat()] or "No school"
    for hd, name, kind in holidays.for_year(d.year):
        if hd == d and kind == "holiday":
            return name
    return None


def rotation_day(d: date, closures: dict[str, str], anchors: list[tuple[date, int]] | None = None) -> int | None:
    """Day 1–N for a school day, counting school days from the latest anchor on or before `d`
    (the first day of school is Day 1; Settings can add "today is Day N"). None if there's no rotation."""
    length = rotation_length()
    if not length or closed_reason(d, closures):
        return None
    first, _ = year_bounds(d)
    start, start_day = max((a for a in (anchors or []) if a[0] <= d), default=(first, 1))
    n, cur = 0, start
    while cur < d:
        if not closed_reason(cur, closures):
            n += 1
        cur += timedelta(days=1)
    return (start_day - 1 + n) % length + 1
