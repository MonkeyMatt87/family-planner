"""Phone notifications (Web Push) for the kids: a morning summary at 7:00 on school days, and the bedtime
routine's reminders on school nights.

A kid turns it on from their page at https://<home address>/kids/<name> (notifications need
https). The phone gives us a subscription (an address at Google's push service plus keys); we send
to it signed with our VAPID key. The key pair is made once and kept in settings.
"""
import base64
import json
import logging
import threading
import time
from datetime import datetime

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid02
from pywebpush import WebPushException, webpush

from . import db

log = logging.getLogger("planner.push")
SEND_AT = "07:00"
CONTACT = "mailto:family-planner@example.com"  # push services want a contact; nothing is sent here


def _vapid() -> Vapid02:
    with db.db() as conn:
        pem = db.get_setting(conn, "vapid_private_pem")
        if not pem:
            v = Vapid02()
            v.generate_keys()
            pem = v.private_pem().decode()
            conn.execute("INSERT INTO settings (key, value) VALUES ('vapid_private_pem', ?)", (pem,))
    return Vapid02.from_pem(pem.encode())


def public_key() -> str:
    """The key the browser needs to subscribe (applicationServerKey), base64url."""
    raw = _vapid().public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def save(person_id: int, sub: dict) -> None:
    with db.db() as conn:
        conn.execute(
            "INSERT INTO push_subs (person_id, endpoint, p256dh, auth, created) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(endpoint) DO UPDATE SET person_id = excluded.person_id, p256dh = excluded.p256dh, auth = excluded.auth",
            (person_id, sub["endpoint"], sub["keys"]["p256dh"], sub["keys"]["auth"], datetime.now().isoformat(timespec="minutes")))


def remove(endpoint: str) -> None:
    with db.db() as conn:
        conn.execute("DELETE FROM push_subs WHERE endpoint = ?", (endpoint,))


def send(person_id: int, title: str, body: str, url: str) -> int:
    """Send to every phone the kid turned it on for. Returns how many got it; drops dead subscriptions."""
    with db.db() as conn:
        subs = db.rows(conn.execute("SELECT * FROM push_subs WHERE person_id = ?", (person_id,)))
    sent, vapid = 0, _vapid()
    for s in subs:
        try:
            webpush({"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                    json.dumps({"title": title, "body": body, "url": url}), vapid_private_key=vapid,
                    vapid_claims={"sub": CONTACT}, ttl=4 * 3600, timeout=15)
            sent += 1
        except WebPushException as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status in (404, 410):  # the phone unsubscribed or the app was removed
                remove(s["endpoint"])
            log.warning("push to person %s failed: %s", person_id, exc)
    with db.db() as conn:
        conn.execute("INSERT INTO push_log (person_id, title, body, phones) VALUES (?, ?, ?, ?)",
                     (person_id, title, body[:500], sent))
        conn.execute("DELETE FROM push_log WHERE id <= (SELECT MAX(id) - 500 FROM push_log)")
    return sent


def scheduler(morning_message, timed_messages=None) -> None:
    """Runs forever in a background thread: at SEND_AT each day, send each kid their summary.
    morning_message(person_id) returns (title, body, url), or None when there's nothing to send.
    timed_messages(now) returns [(key, person_id, title, body, url)] that are due; each key is sent once."""
    while True:
        try:
            now = datetime.now()
            if timed_messages:
                _send_timed(timed_messages(now), now)
            with db.db() as conn:
                sent_on = db.get_setting(conn, "push_sent_on")
            if now.strftime("%H:%M") >= SEND_AT and sent_on != now.date().isoformat():
                with db.db() as conn:
                    conn.execute("INSERT INTO settings (key, value) VALUES ('push_sent_on', ?) "
                                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (now.date().isoformat(),))
                    kids = [r["person_id"] for r in conn.execute("SELECT DISTINCT person_id FROM push_subs")]
                for pid in kids:
                    msg = morning_message(pid)
                    if msg:
                        log.info("morning summary to person %s: %d phone(s)", pid, send(pid, *msg))
        except Exception:
            log.exception("push scheduler")
        time.sleep(60)


def _send_timed(messages, now: datetime) -> None:
    if not messages:
        return
    today = now.date().isoformat()
    with db.db() as conn:
        sent = json.loads(db.get_setting(conn, "push_timed_sent", "{}"))
    keys = set(sent.get(today, []))
    with_phone = None
    for key, pid, title, body, url in messages:
        if key in keys:
            continue
        keys.add(key)
        if with_phone is None:
            with db.db() as conn:
                with_phone = {r["person_id"] for r in conn.execute("SELECT DISTINCT person_id FROM push_subs")}
        if pid in with_phone:
            log.info("%s to person %s: %d phone(s)", key, pid, send(pid, title, body, url))
    with db.db() as conn:  # only today's keys are kept
        conn.execute("INSERT INTO settings (key, value) VALUES ('push_timed_sent', ?) "
                     "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (json.dumps({today: sorted(keys)}),))


def start(morning_message, timed_messages=None) -> None:
    threading.Thread(target=scheduler, args=(morning_message, timed_messages), daemon=True, name="push").start()
