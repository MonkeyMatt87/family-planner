// Face ID (passkeys): used by the sign-in page and by Settings.

const b64u = {
  toBuf(s) {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    return Uint8Array.from(bin, c => c.charCodeAt(0)).buffer;
  },
  fromBuf(buf) {
    let bin = "";
    for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
};

const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);

async function postJSON(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

// Adds Face ID to this phone. The phone must already be signed in.
async function registerPasskey(name) {
  const o = await postJSON("/api/passkeys/register/options");
  const cred = await navigator.credentials.create({ publicKey: {
    ...o,
    challenge: b64u.toBuf(o.challenge),
    user: { ...o.user, id: b64u.toBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: b64u.toBuf(c.id) })),
  } });
  const r = cred.response;
  await postJSON("/api/passkeys/register/verify", { name, credential: {
    id: cred.id, rawId: b64u.fromBuf(cred.rawId), type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: b64u.fromBuf(r.clientDataJSON),
      attestationObject: b64u.fromBuf(r.attestationObject),
      transports: r.getTransports ? r.getTransports() : [],
    },
  } });
}

// Signs in with Face ID; on success the server sets the login cookie and returns {role}.
async function signInWithPasskey() {
  const o = await postJSON("/passkey/login/options");
  const cred = await navigator.credentials.get({ publicKey: {
    ...o,
    challenge: b64u.toBuf(o.challenge),
    allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: b64u.toBuf(c.id) })),
  } });
  const r = cred.response;
  return postJSON("/passkey/login/verify", { credential: {
    id: cred.id, rawId: b64u.fromBuf(cred.rawId), type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: b64u.fromBuf(r.clientDataJSON),
      authenticatorData: b64u.fromBuf(r.authenticatorData),
      signature: b64u.fromBuf(r.signature),
      userHandle: r.userHandle ? b64u.fromBuf(r.userHandle) : undefined,
    },
  } });
}
