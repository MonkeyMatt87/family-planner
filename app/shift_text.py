"""Reads typed shifts, written the way a paper schedule looks:

    Monday: 8:00am-11:00am - Office - 3hrs
            5:30pm-7:30pm - Office - 2hrs
    Tue 8-10 Office, 10:05-2:05 Clinic, 6-8pm Office
    Sep 28 10-2 Clinic

A line that starts with a day (weekday name, "Sep 28", "9/28" or "2026-09-28") sets the day; lines without
one belong to the day above. Weekday names mean that day in the chosen week (Sunday to Saturday).
Times without am/pm are guessed: 7–11 is morning, 12 is noon, 1–6 is afternoon.
"""
import re
from datetime import date, timedelta

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

DAY_NAME = re.compile(r"^\s*(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?\s*[:,-]?\s*", re.I)
DAY_ISO = re.compile(r"^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*[:,-]?\s*")
DAY_MD = re.compile(r"^\s*(\d{1,2})/(\d{1,2})\s*[:,-]?\s*")
DAY_MONTH = re.compile(r"^\s*([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*[:,-]?\s*", re.I)
TIME = r"(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)?(?![a-z])"  # "12 Andy" isn't 12 am
RANGE = re.compile(TIME + r"\s*(?:-|–|—|to)\s*" + TIME, re.I)
NOISE = re.compile(r"\b\d+(?:\.\d+)?\s*(?:hrs?|hours?)\b|[-–—,:;|]+", re.I)


def _year_for(month: int, day: int, near: date) -> int:
    options = []
    for y in (near.year - 1, near.year, near.year + 1):
        try:
            options.append(date(y, month, day))
        except ValueError:
            pass
    return min(options, key=lambda d: abs((d - near).days)).year


def _day(line: str, week_start: date) -> tuple[date | None, str]:
    """(date, rest of line) if the line starts with a day."""
    sunday = week_start - timedelta(days=(week_start.weekday() + 1) % 7)
    if m := DAY_ISO.match(line):
        return date(int(m[1]), int(m[2]), int(m[3])), line[m.end():]
    if m := DAY_MD.match(line):
        mo, dy = int(m[1]), int(m[2])
        return date(_year_for(mo, dy, week_start), mo, dy), line[m.end():]
    if (m := DAY_MONTH.match(line)) and m[1][:3].lower() in MONTHS:
        mo, dy = MONTHS.index(m[1][:3].lower()) + 1, int(m[2])
        return date(_year_for(mo, dy, week_start), mo, dy), line[m.end():]
    if m := DAY_NAME.match(line):
        wd = WEEKDAYS.index(m[1][:3].lower())
        return sunday + timedelta(days=(wd + 1) % 7), line[m.end():]
    return None, line


def _to24(h: int, mins: int, suffix: str | None) -> tuple[int, int]:
    s = (suffix or "").lower().replace(".", "")
    if s.startswith("p") and h < 12:
        h += 12
    elif s.startswith("a") and h == 12:
        h = 0
    return h, mins


def _times(m: re.Match) -> tuple[str, str]:
    h1, m1, s1, h2, m2, s2 = int(m[1]), int(m[2] or 0), m[3], int(m[4]), int(m[5] or 0), m[6]
    if not s1 and s2:
        # "10-2pm": the start is morning if it would otherwise come after the end
        s1 = s2 if (h1 % 12) < (h2 % 12) or s2.lower().startswith("a") else ("am" if s2.lower().startswith("p") else s2)
    if not s1:
        s1 = "am" if 7 <= h1 <= 11 else "pm"
    start = _to24(h1, m1, s1)
    if not s2:
        end = _to24(h2, m2, "am" if 7 <= h2 <= 11 else "pm")
        if end <= start and h2 < 12:  # "8-10": both morning
            end = _to24(h2, m2, "am" if (h2 + 12) * 60 + m2 > 24 * 60 else s1)
            if end <= start:
                end = _to24(h2, m2, "pm")
    else:
        end = _to24(h2, m2, s2)
    if not (0 <= start[0] < 24 and 0 <= end[0] < 24 and start[1] < 60 and end[1] < 60):
        raise ValueError("bad time")
    return f"{start[0]:02d}:{start[1]:02d}", f"{end[0]:02d}:{end[1]:02d}"


def parse(text: str, week_start: date) -> tuple[list[dict], list[str]]:
    shifts, skipped, current = [], [], None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        day, rest = _day(line, week_start)
        if day:
            current = day
        ranges = list(RANGE.finditer(rest))
        if not ranges:
            if not day:
                skipped.append(line)
            continue
        if current is None:
            skipped.append(line)
            continue
        for i, m in enumerate(ranges):
            label_end = ranges[i + 1].start() if i + 1 < len(ranges) else len(rest)
            label = " ".join(NOISE.sub(" ", rest[m.end():label_end]).split()) or "Work"
            try:
                start, end = _times(m)
            except ValueError:
                skipped.append(line)
                continue
            shifts.append({"date": current.isoformat(), "start_time": start, "end_time": end, "label": label})
    return shifts, skipped
