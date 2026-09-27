"""The Homelab tab on "My page" (/me): Proxmox, AdGuard, and the netmon helper's device scans and speed tests.

Everything is read on the server with keys saved in Settings (never sent to a browser), cached briefly
so a page left open doesn't keep hitting the homelab.
"""
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import db

log = logging.getLogger("planner.homelab")

NETMON = db.DATA_DIR / "netmon"

_cache: dict[str, tuple[float, object]] = {}


def _cached(key: str, seconds: int, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < seconds:
        return hit[1]
    value = fn()
    _cache[key] = (time.time(), value)
    return value


def clear_cache() -> None:
    _cache.clear()


def _error(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        return {401: "the login or token was refused", 403: "the token doesn't have permission (needs PVEAuditor)"}.get(
            code, f"it answered {code}")
    if isinstance(exc, (httpx.ConnectError, httpx.TimeoutException)):
        return "couldn't reach it"
    return str(exc)[:200]


# ---------------------------------------------------------------- Proxmox (read-only API token)

def _pve(conn):
    host = db.get_setting(conn, "pve_host").strip()
    token_id, secret = db.get_setting(conn, "pve_token_id").strip(), db.get_setting(conn, "pve_token_secret").strip()
    if not host or not token_id or not secret:
        return None
    base = host if host.startswith("http") else f"https://{host}:8006"
    client = httpx.Client(base_url=f"{base.rstrip('/')}/api2/json", timeout=10, verify=False,  # Proxmox's own certificate
                          headers={"Authorization": f"PVEAPIToken={token_id}={secret}"})
    return client


def _guest_ips(client, g: dict, scanned: dict) -> list[dict]:
    """[{ip, how}] for a container or VM: what's live (Proxmox, or the network scan by MAC), else the static
    address in its config. how = static or DHCP, from the config."""
    kind = "lxc" if g["type"] == "lxc" else "qemu"
    try:
        cfg = client.get(f"/nodes/{g['node']}/{kind}/{g['id']}/config").raise_for_status().json()["data"]
    except Exception:
        return []
    nics = {}  # mac -> "192.168.1.20/24" (static) or "dhcp"
    for k, v in cfg.items():
        if re.fullmatch(r"net\d+", k) and (m := MAC.search(str(v))):
            ip = re.search(r"(?:^|,)ip=([^,]+)", str(v))
            nics[m[0].lower()] = ip[1] if ip else "dhcp"
    live = {}
    if g["status"] == "running" and kind == "lxc":
        try:
            for i in client.get(f"/nodes/{g['node']}/lxc/{g['id']}/interfaces").raise_for_status().json()["data"]:
                mac = (i.get("hwaddr") or "").lower()
                if mac in nics:  # skips lo and Docker's own bridges inside the container
                    live[mac] = [a["ip-address"] for a in i.get("ip-addresses", []) if a.get("ip-address-type") == "inet"]
        except Exception:
            pass
    out = []
    for mac, conf in nics.items():
        how = "DHCP" if conf == "dhcp" else "static"
        ips = live.get(mac) or ([scanned[mac]] if g["status"] == "running" and scanned.get(mac) else [])
        if not ips and how == "static":
            ips = [conf.split("/")[0]]
        out += [{"ip": ip, "how": how} for ip in ips]
    return out


def proxmox(conn) -> dict:
    client = _pve(conn)
    if not client:
        return {"configured": False}

    def fetch():
        with client:
            try:
                nodes = []
                for n in client.get("/nodes").raise_for_status().json()["data"]:
                    info = {"name": n["node"], "online": n.get("status") == "online", "cpu": n.get("cpu", 0),
                            "cpus": n.get("maxcpu", 0), "mem": n.get("mem", 0), "mem_total": n.get("maxmem", 0),
                            "uptime": n.get("uptime", 0)}
                    if info["online"]:
                        st = client.get(f"/nodes/{n['node']}/status").raise_for_status().json()["data"]
                        info.update(load=st.get("loadavg", []), version=st.get("pveversion", ""),
                                    cpu_model=st.get("cpuinfo", {}).get("model", ""),
                                    root=st.get("rootfs", {}), swap=st.get("swap", {}))
                        rrd = client.get(f"/nodes/{n['node']}/rrddata", params={"timeframe": "day"}).raise_for_status().json()["data"]
                        info["history"] = [{"t": p["time"], "cpu": p.get("cpu"), "mem": p.get("memused"),
                                            "netin": p.get("netin"), "netout": p.get("netout")} for p in rrd]
                    nodes.append(info)
                guests = [{"id": g["vmid"], "name": g.get("name", ""), "type": g["type"], "node": g.get("node"),
                           "status": g.get("status"), "cpu": g.get("cpu", 0), "cpus": g.get("maxcpu", 0),
                           "mem": g.get("mem", 0), "mem_total": g.get("maxmem", 0), "disk": g.get("disk", 0),
                           "disk_total": g.get("maxdisk", 0), "netin": g.get("netin", 0), "netout": g.get("netout", 0),
                           "uptime": g.get("uptime", 0)}
                          for g in client.get("/cluster/resources", params={"type": "vm"}).raise_for_status().json()["data"]]
                scanned = {mac: d.get("ip") for mac, d in _read("devices.json", {"devices": {}})["devices"].items()}
                for g in guests:
                    g["ips"] = _guest_ips(client, g, scanned)
                storage = [{"name": s["storage"], "node": s.get("node"), "used": s.get("disk", 0), "total": s.get("maxdisk", 0),
                            "type": s.get("plugintype", "")}
                           for s in client.get("/cluster/resources", params={"type": "storage"}).raise_for_status().json()["data"]
                           if s.get("status") == "available"]
                return {"configured": True, "nodes": nodes, "guests": sorted(guests, key=lambda g: g["id"]), "storage": storage}
            except Exception as exc:
                log.warning("proxmox failed: %s", exc)
                return {"configured": True, "error": _error(exc)}

    return _cached("pve", 30, fetch)


MAC = re.compile(r"[0-9a-f]{2}(?::[0-9a-f]{2}){5}", re.I)


def pve_macs(conn) -> dict:
    """MAC -> "105 · docker (LXC)" for every Proxmox guest, so the network list can name them."""
    client = _pve(conn)
    if not client:
        return {}

    def fetch():
        out = {}
        host = db.get_setting(conn, "pve_host").strip()
        host = re.sub(r"^https?://|:\d+/?$", "", host)
        with client:
            try:
                nodes = [n["node"] for n in client.get("/nodes").raise_for_status().json()["data"]]
                out[f"ip:{host}"] = f"Proxmox host · {', '.join(nodes)}"
                for g in client.get("/cluster/resources", params={"type": "vm"}).raise_for_status().json()["data"]:
                    cfg = client.get(f"/nodes/{g['node']}/{g['type']}/{g['vmid']}/config").raise_for_status().json()["data"]
                    for k, v in cfg.items():
                        if re.fullmatch(r"net\d+", k) and (m := MAC.search(str(v))):
                            out[m[0].lower()] = f"{g['vmid']} · {g.get('name', '')} ({'LXC' if g['type'] == 'lxc' else 'VM'})"
            except Exception as exc:
                log.warning("proxmox guest MACs failed: %s", exc)
        return out

    return _cached("pve_macs", 10 * 60, fetch)


def _guess(mac: str, ip: str | None) -> str:
    if ip and ip.endswith(".1"):
        return "Router"
    if mac.startswith("bc:24:11"):
        return "Proxmox container or VM"
    if int(mac[1], 16) & 2:  # "locally administered": phones and tablets hide their real address on Wi-Fi
        return "Phone or tablet (private Wi-Fi address)"
    return ""


# ---------------------------------------------------------------- AdGuard Home

def _adguard(conn):
    host = db.get_setting(conn, "adguard_host").strip()
    user, password = db.get_setting(conn, "adguard_user").strip(), db.get_setting(conn, "adguard_password")
    if not host or not user or not password:
        return None
    base = host if host.startswith("http") else f"http://{host}"
    return httpx.Client(base_url=f"{base.rstrip('/')}/control", timeout=10, auth=(user, password))


def adguard(conn) -> dict:
    client = _adguard(conn)
    if not client:
        return {"configured": False}

    def fetch():
        with client:
            try:
                status = client.get("/status").raise_for_status().json()
                stats = client.get("/stats").raise_for_status().json()
                clients = client.get("/clients").raise_for_status().json()
                queries, blocked = stats.get("num_dns_queries", 0), stats.get("num_blocked_filtering", 0)
                return {
                    "configured": True, "version": status.get("version", ""), "protection": status.get("protection_enabled"),
                    "running": status.get("running"), "queries": queries, "blocked": blocked,
                    "blocked_pct": blocked / queries * 100 if queries else 0,
                    "avg_ms": round(stats.get("avg_processing_time", 0) * 1000, 1),
                    "hours": stats.get("time_units") == "hours", "per_unit": stats.get("dns_queries", []),
                    "blocked_per_unit": stats.get("blocked_filtering", []),
                    "top_clients": [_pair(c) for c in stats.get("top_clients", [])[:15]],
                    "top_blocked": [_pair(c) for c in stats.get("top_blocked_domains", [])[:10]],
                    "top_domains": [_pair(c) for c in stats.get("top_queried_domains", [])[:10]],
                    "names": _client_names(clients),
                }
            except Exception as exc:
                log.warning("adguard failed: %s", exc)
                return {"configured": True, "error": _error(exc)}

    return _cached("adguard", 60, fetch)


def _pair(d: dict) -> dict:
    (k, v), = d.items()
    return {"name": k, "count": v}


def _client_names(clients: dict) -> dict:
    """ip or mac -> name, from AdGuard's saved clients and the ones it found itself (rDNS, DHCP, hosts)."""
    names = {}
    for c in clients.get("auto_clients") or []:
        if c.get("name"):
            names[c["ip"]] = c["name"]
    for c in clients.get("clients") or []:
        for ident in c.get("ids", []):
            names[ident.lower()] = c["name"]
    return names


def protection(conn, on: bool) -> None:
    client = _adguard(conn)
    if not client:
        raise RuntimeError("AdGuard isn't set up")
    with client:
        client.post("/protection", json={"enabled": on}).raise_for_status()
    _cache.pop("adguard", None)


# ---------------------------------------------------------------- netmon (device scans, speed tests)

def _read(name: str, default):
    try:
        return json.loads((NETMON / name).read_text())
    except (FileNotFoundError, ValueError):
        return default


def speedtests() -> dict:
    tests = _read("speedtest.json", {"tests": []})["tests"]
    return {"tests": tests[-24 * 7:], "running": (NETMON / "speedtest-running").exists() or (NETMON / "run-speedtest").exists(),
            "helper": NETMON.exists()}


def run_speedtest() -> None:
    if not NETMON.exists():
        raise RuntimeError("the netmon helper isn't running")
    (NETMON / "run-speedtest").write_text(datetime.now(timezone.utc).isoformat())


def devices(conn) -> dict:
    data = _read("devices.json", {"devices": {}})
    online = set(data.get("online_now", []))
    names = adguard(conn).get("names", {}) if db.get_setting(conn, "adguard_user") else {}
    mine = {r["mac"]: r["name"] for r in conn.execute("SELECT mac, name FROM device_names")}
    guests = pve_macs(conn)
    counts = {c["name"]: c["count"] for c in adguard(conn).get("top_clients", [])} if names else {}
    out = []
    for mac, d in data["devices"].items():
        out.append({"mac": mac, "ip": d.get("ip"), "vendor": d.get("vendor", ""), "online": mac in online,
                    "first_seen": d.get("first_seen"), "last_seen": d.get("last_seen"),
                    "name": mine.get(mac) or guests.get(mac) or guests.get(f"ip:{d.get('ip')}") or names.get(mac) or names.get(d.get("ip"), ""),
                    "guess": _guess(mac, d.get("ip")), "named_here": mac in mine,
                    "dns_queries": counts.get(d.get("ip"))})
    out.sort(key=lambda d: (not d["online"], not d["name"], [int(x) for x in (d["ip"] or "0.0.0.0").split(".")]))
    return {"devices": out, "last_scan": data.get("last_scan"), "helper": NETMON.exists()}
