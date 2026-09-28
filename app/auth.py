"""Family PIN for visits that come in through the Cloudflare tunnel (Face ID is in passkeys.py).

Cloudflare adds a Cf-Connecting-Ip header to every request it forwards, so a request
without it came straight from the home network (the Pi, a laptop on Wi-Fi) and is let in.
Internet visitors sign in once per device with the PIN or Face ID; the login cookie lasts a year.

Set the PIN in the app (Settings, from home Wi-Fi), or on the server; either logs every device out:
    docker exec -it family-planner python -m app.auth set-pin

Short PINs (4 to 10 digits) are only safe on the internet because wrong guesses are capped: 5 per
address per 15 minutes and 10 in total per day, after which PIN sign-in from the internet pauses (Face ID,
phones already signed in, and home Wi-Fi keep working). Guessing a random 4-digit PIN at 10 a day takes
years, but common ones (1234, 0000, birth years) fall quickly, so avoid those.
"""
import getpass
import hashlib
import hmac
import re
import secrets
import sys
import time

from . import db

COOKIE = "fp_session"
COOKIE_DAYS = 365
MAX_FAILS = 5              # wrong PINs allowed per address...
FAIL_WINDOW = 15 * 60      # ...within this many seconds
MAX_FAILS_TOTAL = 10       # wrong PINs from everyone together...
TOTAL_WINDOW = 24 * 3600   # ...per day
PIN_RE = r"^\d{4,10}$"
PUBLIC_PATHS = {"/health", "/login", "/logout", "/style.css", "/manifest.json", "/passkey.js",
                "/icon.svg", "/icon-180.png", "/icon-512.png", "/passkey/login/options", "/passkey/login/verify"}

_fails: dict[str, list[float]] = {}


def is_external(request) -> bool:
    return "cf-connecting-ip" in request.headers


def client_ip(request) -> str:
    return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "?")


def is_public(path: str) -> bool:
    return path in PUBLIC_PATHS or path.startswith("/feed/")


# A kid session (Kids PIN or a kid's Face ID) can open only these: the kids' page and what it uses.
KID_PATHS = {"/kids", "/kids.js", "/kids.css", "/common.js", "/passkey.js", "/api/kids",
             "/api/passkeys/register/options", "/api/passkeys/register/verify"}


# On the home network (not through Cloudflare) only the kids' pages and the Pi's wall screen open freely.
# Everything else needs an adult sign-in, so a kid on the Wi-Fi can't wander into the adults' pages.
LAN_OPEN_PATHS = {"/display", "/api/dashboard"}


def lan_open(path: str) -> bool:
    return (is_public(path) or path in LAN_OPEN_PATHS or path == "/kids"
            or path.startswith(("/kids/", "/api/kids"))
            or path.endswith((".js", ".css", ".png", ".svg", ".json")))  # page code only, no family data


def kid_allowed(path: str) -> bool:
    return path in KID_PATHS or path.startswith(("/api/kids/", "/kids/")) or is_public(path)


# A "member" (an adult with "Phone view + own shifts") sees the phone view and edits
# only their own shifts. Their session role is "member:<person id>".
MEMBER_PATHS = {"/mobile", "/my-shifts", "/api/dashboard", "/api/me", "/logout", "/passkey.js",
                "/api/passkeys/register/options", "/api/passkeys/register/verify"}


def member_allowed(path: str) -> bool:
    return (path in MEMBER_PATHS or path.startswith(("/api/my/", "/api/alerts/", "/api/meals/", "/api/meds"))
            or path in ("/sw.js", "/meals", "/report") or is_public(path)
            or path.endswith((".js", ".css", ".png", ".svg", ".json")))


def member_id(role: str | None) -> int | None:
    return int(role.split(":")[1]) if role and role.startswith("member:") else None


# ---------------------------------------------------------------- PINs
# The family PIN (setting "password_hash") signs in as an adult; the Kids PIN ("kids_pin_hash") as a kid.

def _hash(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)


def _verify(stored: str, pin: str) -> bool:
    if not stored:
        return False
    salt_hex, hash_hex = stored.split("$")
    return hmac.compare_digest(_hash(pin, bytes.fromhex(salt_hex)).hex(), hash_hex)


def _matches(key: str, pin: str) -> bool:
    with db.db() as conn:
        return _verify(db.get_setting(conn, key), pin)


def _hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(16)
    return f"{salt.hex()}${_hash(pin, salt).hex()}"


def password_is_set() -> bool:
    with db.db() as conn:
        return bool(db.get_setting(conn, "password_hash"))


def kids_pin_is_set() -> bool:
    with db.db() as conn:
        return bool(db.get_setting(conn, "kids_pin_hash"))


def check_password(pin: str) -> bool:
    """True for the family (adult) PIN."""
    return _matches("password_hash", pin)


def role_for_pin(pin: str) -> str | None:
    """Session role for a PIN: the family PIN and "Everything" people are "adult", the Kids PIN is "kid",
    and a "Phone view + own shifts" person is "member:<id>"."""
    if _matches("password_hash", pin):
        return "adult"
    if _matches("kids_pin_hash", pin):
        return "kid"
    with db.db() as conn:
        for p in conn.execute("SELECT id, pin_hash, access FROM people WHERE pin_hash != ''"):
            if _verify(p["pin_hash"], pin):
                return "adult" if p["access"] == "full" else f"member:{p['id']}"
    return None


def someone_has_pin(pin: str) -> bool:
    with db.db() as conn:
        return any(_verify(p["pin_hash"], pin) for p in conn.execute("SELECT pin_hash FROM people WHERE pin_hash != ''"))


def pin_in_use(pin: str, except_person: int | None = None) -> bool:
    """PINs must all differ, or we couldn't tell who signed in."""
    if _matches("password_hash", pin) or _matches("kids_pin_hash", pin):
        return True
    with db.db() as conn:
        return any(_verify(p["pin_hash"], pin) for p in conn.execute(
            "SELECT pin_hash FROM people WHERE pin_hash != '' AND id != ?", (except_person or 0,)))


def set_person_pin(pid: int, pin: str | None, access: str, remove: bool = False) -> None:
    """A person's own PIN (None keeps it) and what they can do. Any change signs every device out, so
    nobody keeps a sign-in with the old access (Face ID gets them back in)."""
    with db.db() as conn:
        if remove:
            conn.execute("UPDATE people SET pin_hash = '' WHERE id = ?", (pid,))
        elif pin:
            conn.execute("UPDATE people SET pin_hash = ? WHERE id = ?", (_hash_pin(pin), pid))
        conn.execute("UPDATE people SET access = ? WHERE id = ?", (access, pid))
        conn.execute("UPDATE settings SET value = ? WHERE key = 'session_secret'", (secrets.token_hex(32),))


def _save_pin(key: str, pin: str) -> None:
    with db.db() as conn:
        for k, value in ((key, _hash_pin(pin)),
                         ("session_secret", secrets.token_hex(32))):  # new secret = everyone signs in again
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (k, value),
            )


def set_password(pin: str) -> None:
    _save_pin("password_hash", pin)


def set_kids_pin(pin: str) -> None:
    _save_pin("kids_pin_hash", pin)


# ---------------------------------------------------------------- login cookie: "<issued>.<role>.<signature>"

def _secret() -> bytes:
    with db.db() as conn:
        return db.get_setting(conn, "session_secret").encode()


def _sign(payload: str) -> str:
    return hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()


def make_cookie(role: str = "adult") -> str:
    payload = f"{int(time.time())}.{role}"
    return f"{payload}.{_sign(payload)}"


def cookie_role(value: str | None) -> str | None:
    """'adult' or 'kid' for a valid login cookie, else None."""
    if not value or not _secret():
        return None
    parts = value.split(".")
    if len(parts) == 2:              # cookies from before kid sign-in existed were all adults
        issued, role, sig, payload = parts[0], "adult", parts[1], parts[0]
    elif len(parts) == 3:
        issued, role, sig = parts
        payload = f"{issued}.{role}"
    else:
        return None
    if not (role in ("adult", "kid") or re.fullmatch(r"member:\d+", role)) or not hmac.compare_digest(sig, _sign(payload)):
        return None
    if not issued.isdigit() or time.time() - int(issued) >= COOKIE_DAYS * 86400:
        return None
    return role


def cookie_ok(value: str | None) -> bool:
    return cookie_role(value) is not None


def set_login_cookie(response, role: str = "adult", request=None) -> None:
    """HTTPS-only when the visit came over https (Cloudflare, Caddy); at home over plain http a browser
    would throw a secure cookie away, so there it's an ordinary one."""
    secure = request is None or is_external(request) or request.url.scheme == "https"         or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(COOKIE, make_cookie(role), max_age=COOKIE_DAYS * 86400,
                        httponly=True, secure=secure, samesite="lax")


# ---------------------------------------------------------------- brute-force guard

def locked_out(ip: str) -> bool:
    now = time.time()
    for key in list(_fails):
        _fails[key] = [t for t in _fails[key] if now - t < TOTAL_WINDOW]
        if not _fails[key]:
            del _fails[key]
    recent_here = [t for t in _fails.get(ip, []) if now - t < FAIL_WINDOW]
    total = sum(len(v) for v in _fails.values())
    return len(recent_here) >= MAX_FAILS or total >= MAX_FAILS_TOTAL


def record_fail(ip: str) -> None:
    _fails.setdefault(ip, []).append(time.time())


def clear_fails(ip: str | None = None) -> None:
    """Forget wrong tries from one address, or from everyone (after a new PIN is set)."""
    if ip is None:
        _fails.clear()
    else:
        _fails.pop(ip, None)


# ---------------------------------------------------------------- command line

def main() -> None:
    if sys.argv[1:] not in (["set-pin"], ["set-password"]):
        print("usage: python -m app.auth set-pin")
        sys.exit(2)
    db.init()
    first = getpass.getpass("New family PIN (4 to 10 digits): ")
    if not re.match(PIN_RE, first):
        print("Use 4 to 10 digits. Nothing changed.")
        sys.exit(1)
    if getpass.getpass("Type it again: ") != first:
        print("They didn't match. Nothing changed.")
        sys.exit(1)
    set_password(first)
    print("PIN saved. Every device will need to sign in again (Face ID still works for that).")


if __name__ == "__main__":
    main()
