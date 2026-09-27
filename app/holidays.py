"""Public holidays for the family's country and province/state, from the `holidays` library (no downloads).

Set in Settings → General (or the first-run setup): holiday_country ("CA", "US", "GB"…) and
holiday_subdiv ("ON", "NL", "CA"…, optional). Every holiday counts as a day off: school is closed.
Returns (date, name, "holiday") so other code can tell holidays from other all-day items.
"""
import re
import time
from datetime import date
from functools import lru_cache

import holidays as holidays_lib
from holidays import registry

from . import db

_config: dict = {"at": 0.0, "value": ("", "")}


def _country() -> tuple[str, str]:
    if time.time() - _config["at"] > 60:
        with db.db() as conn:
            _config["value"] = (db.get_setting(conn, "holiday_country").strip().upper(),
                                db.get_setting(conn, "holiday_subdiv").strip().upper())
        _config["at"] = time.time()
    return _config["value"]


def reset() -> None:
    """Call after the country changes, so the next lookup uses it."""
    _config["at"] = 0.0


@lru_cache(maxsize=64)
def _year(country: str, subdiv: str, year: int) -> tuple[tuple[date, str, str], ...]:
    if not country:
        return ()
    try:
        found = holidays_lib.country_holidays(country, subdiv=subdiv or None, years=year)
    except (NotImplementedError, KeyError):
        return ()
    return tuple(sorted((d, name, "holiday") for d, name in found.items()))


def for_year(year: int) -> tuple[tuple[date, str, str], ...]:
    return _year(*_country(), year)


def between(start: date, end: date) -> list[tuple[date, str, str]]:
    out = []
    for year in range(start.year, end.year + 1):
        out += [h for h in for_year(year) if start <= h[0] < end]
    return out


@lru_cache(maxsize=1)
def countries() -> list[dict]:
    """For the setup screen: every supported country, with its provinces/states."""
    supported = holidays_lib.list_supported_countries()
    out = []
    for class_name, code, *_ in registry.COUNTRIES.values():
        if code not in supported:
            continue
        aliases = {}
        try:
            aliases = holidays_lib.country_holidays(code).get_subdivision_aliases()
        except Exception:
            pass
        out.append({
            "code": code,
            "name": re.sub(r"(?<=[a-z])(?=[A-Z])", " ", class_name),  # "UnitedStates" -> "United States"
            "subdivs": [{"code": s, "name": (aliases.get(s) or [s])[0]} for s in supported[code]],
        })
    return sorted(out, key=lambda c: c["name"])
