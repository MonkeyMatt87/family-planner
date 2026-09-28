"""Grocery flyer prices from Flipp (the flyer app), for the stores the family picks.

Flipp's public web API needs no account: the flyers near a postal code, a search across their items, and the
items in one flyer. Results are cached for a few hours so the planner stays light on Flipp.
Settings: flyer_postal ("K1A0B1" or "10001"), flyer_stores (JSON list of store names), flyer_watch (JSON list of items).
"""
import concurrent.futures
import json
import logging
import time
from datetime import date

import httpx

from . import db

log = logging.getLogger("planner.flyers")
API = "https://backflipp.wishabi.com/flipp"
HEADERS = {"User-Agent": "Mozilla/5.0 (family-planner)"}
DEFAULT_POSTAL = ""
DEFAULT_STORES: list[str] = []  # none chosen = every store near the postal code
FLYERS_CACHE = 6 * 3600
SEARCH_CACHE = 3 * 3600

_cache: dict[str, tuple[float, object]] = {}


def _get(path: str, params: dict, seconds: int):
    key = path + json.dumps(params, sort_keys=True)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < seconds:
        return hit[1]
    r = httpx.get(f"{API}/{path}", params={"locale": "en-ca", **params}, headers=HEADERS, timeout=20)
    r.raise_for_status()
    value = r.json()
    _cache[key] = (time.time(), value)
    if len(_cache) > 400:  # forget the oldest searches
        for k, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[:100]:
            _cache.pop(k, None)
    return value


def settings(conn) -> dict:
    get = lambda k: db.get_setting(conn, k)
    return {"postal": get("flyer_postal") or DEFAULT_POSTAL,
            "stores": json.loads(get("flyer_stores")) if get("flyer_stores") else DEFAULT_STORES,
            "watch": json.loads(get("flyer_watch")) if get("flyer_watch") else []}


def _name(merchant: str) -> str:
    return (merchant or "").strip()


def stores(postal: str) -> list[dict]:
    """Every store with a current flyer near the postal code, grocery stores first."""
    flyers = _get("flyers", {"postal_code": postal}, FLYERS_CACHE).get("flyers", [])
    out: dict[str, dict] = {}
    for f in flyers:
        name = _name(f.get("merchant"))
        cats = set(f.get("categories") or [])
        s = out.setdefault(name, {"name": name, "logo": f.get("merchant_logo", ""), "grocery": False, "pharmacy": False, "flyers": 0})
        s["grocery"] |= "Groceries" in cats
        s["pharmacy"] |= "Pharmacy" in cats
        s["flyers"] += 1
    return sorted(out.values(), key=lambda s: (not s["grocery"], not s["pharmacy"], s["name"].lower()))


def _price(item: dict) -> dict:
    pre, post = (item.get("pre_price_text") or "").strip(), (item.get("post_price_text") or "").strip()
    price = item.get("current_price") if item.get("current_price") is not None else item.get("price")
    try:
        price = float(price) if price not in (None, "") else None
    except (TypeError, ValueError):
        price = None
    return {"price": price, "text": " ".join(x for x in (pre, f"${price:.2f}" if price is not None else "", post) if x),
            "was": item.get("original_price")}


def search(q: str, postal: str, only: list[str], limit: int = 30) -> list[dict]:
    """Current flyer items matching q at the chosen stores, cheapest first (items without a price last)."""
    q = q.strip()
    if not q or not postal:
        return []
    try:
        items = _get("items/search", {"postal_code": postal, "q": q}, SEARCH_CACHE).get("items", [])
    except Exception as exc:
        log.warning("flyer search %r failed: %s", q, exc)
        return []
    today = date.today().isoformat()
    wanted = {s.lower() for s in only}
    out = []
    for it in items:
        store = _name(it.get("merchant_name"))
        if wanted and store.lower() not in wanted:
            continue
        if (it.get("valid_to") or "9999")[:10] < today:
            continue
        out.append({"store": store, "name": it.get("name", ""), **_price(it), "sale_story": it.get("sale_story") or "",
                    "from": (it.get("valid_from") or "")[:10], "to": (it.get("valid_to") or "")[:10],
                    "image": it.get("clean_image_url") or it.get("clipping_image_url") or "", "flyer_id": it.get("flyer_id")})
    out.sort(key=lambda x: (x["price"] is None, x["price"] or 0))
    return out[:limit]


def deals(names: list[str], postal: str, only: list[str], per_item: int = 3) -> dict[str, list[dict]]:
    """The best few flyer prices for each name (the grocery list, the watch list), searched side by side."""
    names = list(dict.fromkeys(n.strip() for n in names if n.strip()))[:40]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = pool.map(lambda n: (n, search(n, postal, only, per_item)), names)
    return {n: r for n, r in results}


def store_flyer(store: str, postal: str) -> dict:
    """Everything in a store's current flyers (for browsing), by flyer."""
    flyers = [f for f in _get("flyers", {"postal_code": postal}, FLYERS_CACHE).get("flyers", [])
              if _name(f.get("merchant")).lower() == store.lower() and (f.get("valid_to") or "9999")[:10] >= date.today().isoformat()]
    out = []
    for f in flyers[:4]:
        try:
            items = _get(f"flyers/{f['id']}", {}, FLYERS_CACHE).get("items", [])
        except Exception as exc:
            log.warning("flyer %s failed: %s", f["id"], exc)
            continue
        out.append({"id": f["id"], "name": f.get("name", ""), "from": (f.get("valid_from") or "")[:10],
                    "to": (f.get("valid_to") or "")[:10], "thumbnail": f.get("thumbnail_url", ""),
                    "items": [{"name": i.get("name", ""), **_price(i), "image": i.get("cutout_image_url", ""),
                               "sale_story": i.get("sale_story") or ""} for i in items if i.get("name")]})
    return {"store": store, "flyers": out}
