"""More supper ideas from TheMealDB (themealdb.com: a free recipe database with photos, no account needed).

The free API searches one ingredient at a time, so "cook with what we have" searches each picked ingredient and
ranks the meals by how many of the picks they use. Our names are mapped to theirs ("ground beef" -> "Minced Beef").
Everything is cached in memory: the ingredient list and meal details for a week, searches for a day.
"""
import concurrent.futures
import logging
import re
import time
from urllib.parse import quote

import httpx

log = logging.getLogger("planner.recipes")
API = "https://www.themealdb.com/api/json/v1/1"
DAY, WEEK = 86400, 7 * 86400
# Not suppers, unless asked for.
NOT_SUPPER = {"Dessert", "Starter", "Side"}
# Our words -> TheMealDB's ingredient names.
SYNONYMS = {
    "ground beef": ["Minced Beef", "Lean Minced Beef"], "hamburger": ["Minced Beef"], "ground pork": ["Minced Pork", "Ground Pork"],
    "ground turkey": ["Turkey Mince"], "ground chicken": ["Chicken"], "hot dogs": ["Sausages"], "wieners": ["Sausages"],
    "chicken breast": ["Chicken Breast", "Chicken Breasts"], "chicken thighs": ["Chicken Thighs"], "chicken": ["Chicken", "Chicken Breast", "Chicken Thighs"],
    "cheese": ["Cheese", "Cheddar Cheese"], "shredded cheese": ["Cheddar Cheese", "Cheese"], "cheddar": ["Cheddar Cheese"],
    "mozzarella": ["Mozzarella", "Mozzarella Balls"], "parmesan": ["Parmesan", "Parmesan Cheese"], "pasta": ["Penne Pasta", "Spaghetti", "Pasta"],
    "noodles": ["Egg Noodles", "Rice Noodles"], "macaroni": ["Macaroni"], "potato": ["Potatoes"], "potatoes": ["Potatoes"],
    "sweet potato": ["Sweet Potatoes"], "egg": ["Eggs"], "eggs": ["Eggs"], "tomato": ["Tomatoes"], "tomatoes": ["Tomatoes", "Chopped Tomatoes"],
    "canned tomatoes": ["Chopped Tomatoes", "Tinned Tomatoes"], "pepper": ["Red Pepper", "Green Pepper"], "peppers": ["Red Pepper", "Green Pepper"],
    "bell pepper": ["Red Pepper", "Green Pepper"], "onion": ["Onion", "Onions"], "onions": ["Onions", "Onion"], "rice": ["Rice", "Basmati Rice"],
    "beans": ["Kidney Beans", "Black Beans"], "tortillas": ["Tortillas", "Flour Tortilla"], "sour cream": ["Sour Cream"], "salmon": ["Salmon"],
    "pork chops": ["Pork Chops"], "sausages": ["Sausages"], "bacon": ["Bacon"], "ham": ["Ham"], "shrimp": ["King Prawns", "Prawns"],
    "carrots": ["Carrots"], "carrot": ["Carrots"], "mushrooms": ["Mushrooms"], "broccoli": ["Broccoli"], "corn": ["Sweetcorn"],
    "peas": ["Peas"], "spinach": ["Spinach"], "zucchini": ["Courgettes"], "eggplant": ["Aubergine"], "cilantro": ["Coriander"],
    "ground beef lean": ["Lean Minced Beef"], "bread": ["Bread"], "milk": ["Milk"], "butter": ["Butter"], "flour": ["Plain Flour", "Flour"],
}

_cache: dict[str, tuple[float, object]] = {}


def _get(path: str, ttl: int):
    hit = _cache.get(path)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    r = httpx.get(f"{API}/{path}", timeout=15, headers={"User-Agent": "Mozilla/5.0 (family-planner)"})
    r.raise_for_status()
    value = r.json()
    _cache[path] = (time.time(), value)
    return value


def _ingredient_names() -> list[str]:
    return [i["strIngredient"] for i in (_get("list.php?i=list", WEEK).get("meals") or [])]


def their_names(ours: str) -> list[str]:
    """Up to three of TheMealDB's ingredient names for one of ours."""
    low = ours.strip().lower()
    if low in SYNONYMS:
        return SYNONYMS[low]
    names = _ingredient_names()
    exact = [n for n in names if n.lower() == low or n.lower() in (low + "s", low.rstrip("s"))]
    if exact:
        return exact[:3]
    words = [w.rstrip("s") for w in re.findall(r"[a-z]+", low) if len(w) > 2]
    close = [n for n in names if words and all(w in n.lower() for w in words)]
    return sorted(close, key=len)[:3]


def meal(mid: str) -> dict | None:
    m = (_get(f"lookup.php?i={quote(mid)}", WEEK).get("meals") or [None])[0]
    if not m:
        return None
    items = [{"qty": (m.get(f"strMeasure{i}") or "").strip(), "name": (m.get(f"strIngredient{i}") or "").strip()}
             for i in range(1, 21) if (m.get(f"strIngredient{i}") or "").strip()]
    return {"id": m["idMeal"], "name": m["strMeal"].strip(), "category": m.get("strCategory") or "", "area": m.get("strArea") or "",
            "image": m.get("strMealThumb") or "", "instructions": (m.get("strInstructions") or "").strip(),
            "youtube": m.get("strYoutube") or "", "source": m.get("strSource") or "", "items": items}


def find(picked: list[str], limit: int = 12, sides: bool = False) -> list[dict]:
    """Meals using the most of the picked ingredients, with their details. [] if TheMealDB can't be reached."""
    picked = [p for p in dict.fromkeys(p.strip() for p in picked) if p][:6]
    if not picked:
        return []
    try:
        mapped = {p: their_names(p) for p in picked}
    except Exception as exc:
        log.warning("TheMealDB ingredient list failed: %s", exc)
        return []

    def search(p):
        found = {}
        for name in mapped[p]:
            try:
                for m in _get(f"filter.php?i={quote(name.replace(' ', '_'))}", DAY).get("meals") or []:
                    found[m["idMeal"]] = m["strMeal"]
            except Exception as exc:
                log.warning("TheMealDB search %s failed: %s", name, exc)
        return p, found

    hits: dict[str, set[str]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for p, found in pool.map(search, picked):
            for mid in found:
                hits.setdefault(mid, set()).add(p)
    ranked = sorted(hits, key=lambda mid: -len(hits[mid]))[: limit * 2]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        details = [d for d in pool.map(lambda mid: _safe(meal, mid), ranked) if d]
    out = []
    for d in details:
        if not sides and d["category"] in NOT_SUPPER:
            continue
        d["uses"] = sorted(hits[d["id"]])
        out.append(d)
    out.sort(key=lambda d: (-len(d["uses"]), len(d["items"])))
    return out[:limit]


def _safe(fn, *args):
    try:
        return fn(*args)
    except Exception as exc:
        log.warning("TheMealDB lookup failed: %s", exc)
        return None


EMOJI = {"Beef": "🥩", "Chicken": "🍗", "Pork": "🥓", "Seafood": "🐟", "Pasta": "🍝", "Vegetarian": "🥗", "Vegan": "🥗",
         "Breakfast": "🍳", "Lamb": "🍖", "Goat": "🍖", "Dessert": "🍰", "Side": "🥔", "Starter": "🥟"}
