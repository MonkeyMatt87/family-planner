"""Reads Google Calendar (or any iCal) feeds and expands them into plain event dicts.

Google gives every calendar a "Secret address in iCal format" - no OAuth needed.
Feeds are cached in memory so the wall display polling every minute doesn't hammer Google.
"""
import logging
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import icalendar
import recurring_ical_events

log = logging.getLogger("planner.calendars")

CACHE_SECONDS = 10 * 60
_cache: dict[str, tuple[float, icalendar.Calendar]] = {}
_errors: dict[str, str] = {}


def _fetch(url: str, force: bool = False) -> icalendar.Calendar | None:
    url = url.strip()
    if url.startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    hit = _cache.get(url)
    if hit and not force and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        resp = httpx.get(url, timeout=15, follow_redirects=True)
        resp.raise_for_status()
        cal = icalendar.Calendar.from_ical(resp.content)
        _cache[url] = (time.time(), cal)
        _errors.pop(url, None)
        return cal
    except Exception as exc:  # keep showing the last good copy if Google hiccups
        log.warning("calendar fetch failed for %s: %s", url[:60], exc)
        _errors[url] = str(exc)
        return hit[1] if hit else None


def last_error(url: str) -> str | None:
    return _errors.get(url.strip())


def clear_cache() -> None:
    _cache.clear()


def events_between(cal_row: dict, start: date, end: date, tz: ZoneInfo, force: bool = False) -> list[dict]:
    """Events overlapping [start, end) for one configured calendar, in local time."""
    cal = _fetch(cal_row["url"], force)
    if cal is None:
        return []
    out = []
    for ev in recurring_ical_events.of(cal).between(start, end):
        dtstart = ev.get("DTSTART").dt
        dtend_prop = ev.get("DTEND")
        dtend = dtend_prop.dt if dtend_prop else None
        all_day = not isinstance(dtstart, datetime)
        if all_day:
            end_day = dtend if dtend else dtstart + timedelta(days=1)
            # Multi-day all-day events show on every day they cover.
            d = dtstart
            while d < end_day:
                if start <= d < end:
                    out.append(_item(ev, cal_row, d, None, None, True))
                d += timedelta(days=1)
        else:
            s = _local(dtstart, tz)
            e = _local(dtend, tz) if dtend else s
            out.append(_item(ev, cal_row, s.date(), s.strftime("%H:%M"), e.strftime("%H:%M"), False))
    return out


def _local(dt: datetime, tz: ZoneInfo) -> datetime:
    return dt.astimezone(tz) if dt.tzinfo else dt


def _item(ev, cal_row, day: date, start_time, end_time, all_day) -> dict:
    return {
        "source": "google",
        "calendar_id": cal_row["id"],
        "calendar": cal_row["name"],
        "person_id": cal_row.get("person_id"),
        "color": cal_row.get("color"),
        "title": str(ev.get("SUMMARY", "(no title)")),
        "uid": str(ev.get("UID", "")),
        "location": str(ev.get("LOCATION", "") or ""),
        "date": day.isoformat(),
        "start_time": start_time,
        "end_time": end_time,
        "all_day": all_day,
    }
