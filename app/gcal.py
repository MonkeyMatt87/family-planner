"""Copies the planner's appointments into a Google calendar, so they show on every phone like any other event.

The secret iCal links are read-only, so writing uses a Google "service account": a robot Google account
whose JSON key is pasted into Settings, and which the family calendar is shared with ("Make changes to
events"). The planner stays the master copy: if Google can't be reached, the change waits (google_state
'pending' or 'delete') and is retried on the next dashboard refresh.
"""
import base64
import json
import logging
import threading
import time
from datetime import date, datetime, timedelta
from urllib.parse import quote

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from . import db

log = logging.getLogger("planner.gcal")

SCOPE = "https://www.googleapis.com/auth/calendar.events"
API = "https://www.googleapis.com/calendar/v3/calendars"
RETRY_SECONDS = 5 * 60

_token: dict = {"value": None, "exp": 0.0, "key": None}
_lock = threading.Lock()
_last_retry = 0.0
_last_error: str | None = None


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def config(conn) -> tuple[dict, str] | None:
    """(service account key, calendar id), or None if pushing to Google isn't set up."""
    raw, cal = db.get_setting(conn, "google_sa_json"), db.get_setting(conn, "google_push_calendar").strip()
    if not raw or not cal:
        return None
    return json.loads(raw), cal


def check_key(raw: str) -> dict:
    key = json.loads(raw)
    if key.get("type") != "service_account" or not key.get("private_key") or not key.get("client_email"):
        raise ValueError("that isn't a service account key (it should say \"type\": \"service_account\")")
    serialization.load_pem_private_key(key["private_key"].encode(), password=None)
    return key


def _access_token(key: dict) -> str:
    if _token["value"] and _token["key"] == key["client_email"] and time.time() < _token["exp"] - 60:
        return _token["value"]
    now = int(time.time())
    header = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = _b64(json.dumps({"iss": key["client_email"], "scope": SCOPE, "aud": key["token_uri"],
                              "iat": now, "exp": now + 3600}).encode())
    private = serialization.load_pem_private_key(key["private_key"].encode(), password=None)
    sig = private.sign(f"{header}.{claims}".encode(), padding.PKCS1v15(), hashes.SHA256())
    r = httpx.post(key["token_uri"], timeout=15, data={
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": f"{header}.{claims}.{_b64(sig)}"})
    r.raise_for_status()
    _token.update(value=r.json()["access_token"], exp=time.time() + r.json().get("expires_in", 3600), key=key["client_email"])
    return _token["value"]


def _request(key: dict, method: str, url: str, body: dict | None = None) -> httpx.Response:
    r = httpx.request(method, url, json=body, timeout=15, headers={"Authorization": f"Bearer {_access_token(key)}"})
    if r.status_code >= 400 and not (method in ("DELETE", "PATCH") and r.status_code in (404, 410)):
        try:
            msg = r.json()["error"]["message"]
        except Exception:
            msg = r.text[:200]
        raise RuntimeError(f"Google said: {msg}")
    return r


def _event(a: dict, person: str | None, tz: str) -> dict:
    title = f"{person} - {a['title']}" if person else a["title"]  # "Emma - Dentist" is matched back to Emma
    d = date.fromisoformat(a["date"])
    if a["start_time"]:
        start = datetime.combine(d, datetime.strptime(a["start_time"], "%H:%M").time())
        end = datetime.combine(d, datetime.strptime(a["end_time"], "%H:%M").time()) if a["end_time"] else None
        if not end or end <= start:
            end = start + timedelta(hours=1)
        when = {"start": {"dateTime": start.isoformat(), "timeZone": tz}, "end": {"dateTime": end.isoformat(), "timeZone": tz}}
    else:
        when = {"start": {"date": d.isoformat()}, "end": {"date": (d + timedelta(days=1)).isoformat()}}
    return {"summary": title, "location": a["location"], "description": a["notes"], **when,
            "extendedProperties": {"private": {"family_planner_id": str(a["id"])}}}


def sync_one(aid: int, tz: str) -> str:
    """Push one appointment's current state to Google. Returns its google_state afterwards."""
    global _last_error
    with _lock, db.db() as conn:
        cfg = config(conn)
        a = conn.execute("SELECT a.*, p.name AS person FROM appointments a LEFT JOIN people p ON p.id = a.person_id "
                         "WHERE a.id = ?", (aid,)).fetchone()
        if not a:
            return ""
        a = dict(a)
        if not cfg:
            if a["google_state"] == "delete":  # Google was disconnected: nothing left to delete there
                conn.execute("DELETE FROM appointments WHERE id = ?", (aid,))
            return a["google_state"]
        key, cal = cfg
        base = f"{API}/{quote(cal, safe='')}/events"
        try:
            if a["google_state"] == "delete":
                if a["google_id"]:
                    _request(key, "DELETE", f"{base}/{a['google_id']}")
                conn.execute("DELETE FROM appointments WHERE id = ?", (aid,))
                _last_error = None
                return "deleted"
            body = _event(a, a["person"], tz)
            if a["google_id"]:
                r = _request(key, "PATCH", f"{base}/{a['google_id']}", body)
                if r.status_code in (404, 410):  # removed in Google: add it again
                    a["google_id"] = ""
            if not a["google_id"]:
                r = _request(key, "POST", base, body)
                conn.execute("UPDATE appointments SET google_id = ? WHERE id = ?", (r.json()["id"], aid))
            conn.execute("UPDATE appointments SET google_state = 'ok' WHERE id = ?", (aid,))
            _last_error = None
            return "ok"
        except Exception as exc:
            log.warning("google push failed for appointment %s: %s", aid, exc)
            _last_error = str(exc)
            if a["google_state"] != "delete":
                conn.execute("UPDATE appointments SET google_state = 'pending' WHERE id = ?", (aid,))
            return "pending" if a["google_state"] != "delete" else "delete"


def retry_pending(tz: str, force: bool = False) -> None:
    """Called on dashboard refreshes: push anything that couldn't reach Google earlier (every 5 min at most)."""
    global _last_retry
    if not force and time.time() - _last_retry < RETRY_SECONDS:
        return
    _last_retry = time.time()
    with db.db() as conn:
        if not config(conn):
            return
        ids = [r["id"] for r in conn.execute("SELECT id FROM appointments WHERE google_state IN ('', 'pending', 'delete')")]
    for aid in ids:
        sync_one(aid, tz)


def status(conn) -> dict:
    cfg = config(conn)
    key = json.loads(db.get_setting(conn, "google_sa_json") or "{}")
    waiting = conn.execute("SELECT COUNT(*) FROM appointments WHERE google_state IN ('', 'pending', 'delete')").fetchone()[0]
    return {"connected": bool(cfg), "robot_email": key.get("client_email", ""),
            "calendar": db.get_setting(conn, "google_push_calendar"), "waiting": waiting if cfg else 0,
            "last_error": _last_error}


def test(tz: str) -> None:
    """Add and remove a test event, so Settings can say straight away whether the sharing is right."""
    with db.db() as conn:
        cfg = config(conn)
    if not cfg:
        raise RuntimeError("paste the key and the calendar ID first")
    key, cal = cfg
    base = f"{API}/{quote(cal, safe='')}/events"
    d = date.today() + timedelta(days=1)
    r = _request(key, "POST", base, {"summary": "Family Planner test", "start": {"date": d.isoformat()},
                                     "end": {"date": (d + timedelta(days=1)).isoformat()}})
    _request(key, "DELETE", f"{base}/{r.json()['id']}")
