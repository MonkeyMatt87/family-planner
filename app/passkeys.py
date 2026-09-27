"""Face ID sign-in (WebAuthn passkeys) for phones coming in through Cloudflare.

A phone that's already signed in with the PIN registers a passkey: the phone keeps the private key,
unlocked by Face ID; the server keeps only the public key. Signing in later is a Face ID glance.
Passkeys need https and a fixed site name, so they use the "Public web address" from Settings.
"""
import json
import secrets
import time
from datetime import datetime
from urllib.parse import urlparse

import webauthn
from fastapi import APIRouter, HTTPException, Request, Response
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from . import auth, db

router = APIRouter()
CHALLENGE_COOKIE = "fp_challenge"
CHALLENGE_SECONDS = 5 * 60
_challenges: dict[str, tuple[float, bytes]] = {}


def _site(request: Request) -> tuple[str, str]:
    """(rp_id, origin), e.g. ("family.example.com", "https://family.example.com")."""
    with db.db() as conn:
        public = db.get_setting(conn, "public_url").rstrip("/")
    if not public.startswith(("https://", "http://localhost")):  # localhost: browsers allow passkeys there for testing
        raise HTTPException(400, "Set Settings → Public web address to the https:// address first")
    return urlparse(public).hostname, public


def _new_challenge(resp: Response) -> bytes:
    now = time.time()
    for k in [k for k, (t, _) in _challenges.items() if now - t > CHALLENGE_SECONDS]:
        del _challenges[k]
    token, challenge = secrets.token_urlsafe(24), secrets.token_bytes(32)
    _challenges[token] = (now, challenge)
    resp.set_cookie(CHALLENGE_COOKIE, token, max_age=CHALLENGE_SECONDS, httponly=True, secure=True, samesite="strict")
    return challenge


def _take_challenge(request: Request) -> bytes:
    hit = _challenges.pop(request.cookies.get(CHALLENGE_COOKIE, ""), None)
    if not hit or time.time() - hit[0] > CHALLENGE_SECONDS:
        raise HTTPException(400, "That took too long. Try again.")
    return hit[1]


def _user_id() -> bytes:
    with db.db() as conn:
        uid = db.get_setting(conn, "passkey_user_id")
        if not uid:
            uid = bytes_to_base64url(secrets.token_bytes(16))
            conn.execute("INSERT INTO settings (key, value) VALUES ('passkey_user_id', ?)", (uid,))
    return base64url_to_bytes(uid)


def _descriptors() -> list[PublicKeyCredentialDescriptor]:
    with db.db() as conn:
        return [PublicKeyCredentialDescriptor(id=base64url_to_bytes(r["id"]))
                for r in db.rows(conn.execute("SELECT id FROM passkeys"))]


def has_passkeys() -> bool:
    with db.db() as conn:
        return conn.execute("SELECT 1 FROM passkeys LIMIT 1").fetchone() is not None


# ---------------------------------------------------------------- add Face ID to a signed-in phone

@router.post("/api/passkeys/register/options")
def register_options(request: Request, response: Response):
    if not auth.is_external(request):
        raise HTTPException(400, "Open the planner from its https:// address to set up Face ID")
    rp_id, _ = _site(request)
    with db.db() as conn:
        family = db.get_setting(conn, "family_name", "Family")
    options = webauthn.generate_registration_options(
        rp_id=rp_id, rp_name="Family Planner", user_id=_user_id(), user_name=family, user_display_name=family,
        challenge=_new_challenge(response), exclude_credentials=_descriptors(),
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED, user_verification=UserVerificationRequirement.REQUIRED),
    )
    return json.loads(webauthn.options_to_json(options))


@router.post("/api/passkeys/register/verify")
async def register_verify(request: Request):
    body = await request.json()
    rp_id, origin = _site(request)
    try:
        v = webauthn.verify_registration_response(
            credential=body["credential"], expected_challenge=_take_challenge(request),
            expected_rp_id=rp_id, expected_origin=origin, require_user_verification=True)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"Face ID setup didn't work: {exc}")
    name = (body.get("name") or "Phone").strip()[:40]
    role = auth.cookie_role(request.cookies.get(auth.COOKIE)) or "adult"  # a kid's phone gets a kid passkey
    with db.db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO passkeys (id, public_key, sign_count, name, created, role) VALUES (?, ?, ?, ?, ?, ?)",
            (bytes_to_base64url(v.credential_id), v.credential_public_key, v.sign_count, name,
             datetime.now().isoformat(timespec="minutes"), role))
    return {"ok": True}


@router.get("/api/passkeys")
def list_passkeys():
    with db.db() as conn:
        return db.rows(conn.execute("SELECT id, name, created, last_used, role FROM passkeys ORDER BY created"))


@router.delete("/api/passkeys/{pid}")
def delete_passkey(pid: str):
    with db.db() as conn:
        conn.execute("DELETE FROM passkeys WHERE id = ?", (pid,))
    return {"ok": True}


# ---------------------------------------------------------------- sign in with Face ID (public)

@router.post("/passkey/login/options")
def login_options(request: Request, response: Response):
    rp_id, _ = _site(request)
    options = webauthn.generate_authentication_options(
        rp_id=rp_id, challenge=_new_challenge(response), allow_credentials=_descriptors(),
        user_verification=UserVerificationRequirement.REQUIRED)
    return json.loads(webauthn.options_to_json(options))


@router.post("/passkey/login/verify")
async def login_verify(request: Request, response: Response):
    body = await request.json()
    rp_id, origin = _site(request)
    challenge = _take_challenge(request)
    cred_id = body.get("credential", {}).get("id", "")
    with db.db() as conn:
        row = conn.execute("SELECT * FROM passkeys WHERE id = ?", (cred_id,)).fetchone()
    if not row:
        raise HTTPException(401, "This phone's Face ID isn't set up here any more. Use the PIN.")
    try:
        v = webauthn.verify_authentication_response(
            credential=body["credential"], expected_challenge=challenge, expected_rp_id=rp_id,
            expected_origin=origin, credential_public_key=row["public_key"],
            credential_current_sign_count=row["sign_count"], require_user_verification=True)
    except Exception as exc:
        raise HTTPException(401, f"Face ID sign-in didn't work: {exc}")
    with db.db() as conn:
        conn.execute("UPDATE passkeys SET sign_count = ?, last_used = ? WHERE id = ?",
                     (v.new_sign_count, datetime.now().isoformat(timespec="minutes"), cred_id))
    auth.set_login_cookie(response, row["role"])
    return {"ok": True, "role": row["role"]}
