"""netmon: the homelab helper behind the Homelab tab on "My page" (/me).

Runs next to the planner on the Docker LXC, on the host's network (so it can see every device's MAC):
  - every 5 minutes, an ARP scan of the home network -> /out/devices.json
  - every hour (or when the planner drops /out/run-speedtest), an Ookla speed test -> /out/speedtest.json
The planner only reads these files; netmon has no web page and no open port.
"""
import json
import logging
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(os.environ.get("NETMON_OUT", "/out"))
IFACE = os.environ.get("NETMON_IFACE", "eth0")
SCAN_EVERY = int(os.environ.get("NETMON_SCAN_SECONDS", "300"))
SPEEDTEST_EVERY = int(os.environ.get("NETMON_SPEEDTEST_SECONDS", "3600"))
KEEP_TESTS = 24 * 45  # about six weeks of hourly tests
TRIGGER = OUT / "run-speedtest"

logging.basicConfig(level=logging.INFO, format="%(asctime)s netmon %(message)s")
log = logging.getLogger()
LINE = re.compile(r"^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f:]{17})\s*(.*)$", re.I)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load(name: str, default):
    try:
        return json.loads((OUT / name).read_text())
    except (FileNotFoundError, ValueError):
        return default


def save(name: str, data) -> None:
    tmp = OUT / f".{name}.tmp"
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(OUT / name)  # the planner never sees a half-written file


def scan() -> None:
    r = subprocess.run(["arp-scan", "--localnet", "--interface", IFACE, "--retry=2", "--plain"],
                       capture_output=True, text=True, timeout=120)
    seen = {}
    for line in r.stdout.splitlines():
        m = LINE.match(line.strip())
        if m:
            seen[m[2].lower()] = (m[1], m[3].strip())
    if not seen:
        log.warning("scan found nothing: %s", r.stderr.strip()[:200])
        return
    try:  # an ARP scan never answers for the machine it runs on, so add this LXC itself
        own_mac = Path(f"/sys/class/net/{IFACE}/address").read_text().strip().lower()
        own_ip = subprocess.run(["hostname", "-I"], capture_output=True, text=True).stdout.split()[0]
        seen.setdefault(own_mac, (own_ip, ""))
    except Exception:
        pass
    data = load("devices.json", {"devices": {}})
    t = now()
    for mac, (ip, vendor) in seen.items():
        d = data["devices"].setdefault(mac, {"first_seen": t})
        d.update(ip=ip, last_seen=t)
        if vendor and "unknown" not in vendor.lower():
            d["vendor"] = vendor
    data["last_scan"] = t
    data["online_now"] = sorted(seen)
    save("devices.json", data)
    log.info("scan: %d devices online", len(seen))


def speedtest() -> None:
    r = subprocess.run(["speedtest", "--accept-license", "--accept-gdpr", "--format=json"],
                       capture_output=True, text=True, timeout=180)
    data = load("speedtest.json", {"tests": []})
    try:
        j = json.loads(r.stdout)
        test = {
            "at": now(),
            "down_mbps": round(j["download"]["bandwidth"] * 8 / 1e6, 1),
            "up_mbps": round(j["upload"]["bandwidth"] * 8 / 1e6, 1),
            "ping_ms": round(j["ping"]["latency"], 1),
            "jitter_ms": round(j["ping"].get("jitter", 0), 1),
            "loss": j.get("packetLoss"),
            "isp": j.get("isp", ""),
            "server": f"{j['server']['name']} ({j['server']['location']})",
            "url": j.get("result", {}).get("url", ""),
        }
        log.info("speedtest: %s down, %s up, %s ms", test["down_mbps"], test["up_mbps"], test["ping_ms"])
    except Exception:
        test = {"at": now(), "error": (r.stderr or r.stdout).strip()[-300:] or "speedtest failed"}
        log.warning("speedtest failed: %s", test["error"])
    data["tests"] = (data["tests"] + [test])[-KEEP_TESTS:]
    save("speedtest.json", data)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    last_scan = 0.0
    tests = load("speedtest.json", {"tests": []})["tests"]
    last_test = datetime.fromisoformat(tests[-1]["at"]).timestamp() if tests else 0.0
    while True:
        if time.time() - last_scan >= SCAN_EVERY:
            last_scan = time.time()
            try:
                scan()
            except Exception as exc:
                log.warning("scan error: %s", exc)
        if TRIGGER.exists() or time.time() - last_test >= SPEEDTEST_EVERY:
            TRIGGER.unlink(missing_ok=True)
            last_test = time.time()
            (OUT / "speedtest-running").write_text(now())
            try:
                speedtest()
            except Exception as exc:
                log.warning("speedtest error: %s", exc)
            finally:
                (OUT / "speedtest-running").unlink(missing_ok=True)
        time.sleep(10)


if __name__ == "__main__":
    main()
