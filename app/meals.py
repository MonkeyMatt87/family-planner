"""Meals: recipes, the week's suppers, the shared grocery list, what's in the house, and flyer deals (/meals).

- Recipes have ingredients, one per line ("2 lb ground beef"). The plan puts a recipe (or just a name) on a day.
- "Add the week to the list" puts each planned recipe's ingredients on the grocery list, skipping what's in the
  pantry or already on the list.
- Ticking an item on the list moves it to the pantry, so "What can we make?" knows what's in the house.
- Deals come from flyers.py for the stores the family picked.
Adults and phone-only sign-ins can use it (auth.member_allowed); the kids can't.
"""
import json
import re
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import db, flyers, recipe_ideas

router = APIRouter(prefix="/api/meals")

PLACES = ("fridge", "freezer", "cupboard", "other")
# Checked in this order, whole words only ("oil" isn't in "toilet"); the first match wins.
CATEGORIES = [
    ("🧻 Household", r"paper towels?|toilet paper|toilet|tissues?|soap|detergent|dish\w*|garbage bags?|foil|plastic wrap|"
                    r"cleaner|sponges?|bleach|laundry|batteries|light bulbs?"),
    ("💊 Health & baby", r"shampoo|conditioner|toothpaste|toothbrush\w*|deodorant|vitamins?|melatonin|tylenol|advil|motrin|"
                        r"medicine|diapers?|wipes|lotion|band-?aids?|bandages?|sunscreen|floss"),
    ("❄️ Frozen", r"frozen \w+|ice cream|fries|nuggets?|popsicles?|waffles?|freezies?"),
    ("🥫 Pantry", r"canned \w+|\w+ sauce|tomato paste|\w+ soup|\w+ broth|\w+ stock"),  # before meat and produce
    ("🥩 Meat & fish", r"beef|chicken|pork|turkey|ham|bacon|sausages?|steaks?|chops?|ground \w+|mince|salmon|fish|cod|tuna|"
                      r"shrimp|meatballs?|wings?|drumsticks?|thighs?|breasts?|roast|deli \w+|hot dogs?|wieners?|pepperoni"),
    ("🥛 Dairy & eggs", r"milk|cheese|butter|yogh?urt|cream|eggs?|sour cream|cheddar|mozzarella|parmesan"),
    ("🍞 Bakery", r"bread|buns?|rolls?|bagels?|tortillas?|wraps?|pitas?|naan|muffins?|croissants?|dough"),
    ("🍪 Snacks & drinks", r"\w+ juice|juice"),                          # before produce: "orange juice"
    ("🥦 Produce", r"apples?|bananas?|berries|\w+berries|grapes?|oranges?|lemons?|limes?|pears?|peach\w*|melons?|lettuce|"
                  r"spinach|kale|carrots?|potato\w*|onions?|garlic|bell peppers?|peppers|green peppers?|red peppers?|tomato\w*|"
                  r"cucumbers?|celery|broccoli|cauliflower|corn|mushrooms?|zucchini|squash|avocados?|cilantro|parsley|herbs?|"
                  r"salad|cabbage|green beans|peas|fruit|vegetables?|veggies"),
    ("🍪 Snacks & drinks", r"chips|cookies?|snacks?|granola|\w+ bars?|juice|pop|soda|water|drinks?|popcorn|candy|treats?|crackers?"),
    ("🥫 Pantry", r"pasta|spaghetti|macaroni|noodles?|rice|flour|sugar|oil|vinegar|\w+ sauce|sauce|salsa|soup|broth|stock|"
                 r"beans?|lentils?|canned \w+|cereal|oats?|oatmeal|peanut butter|jam|honey|syrup|spices?|seasoning|salt|"
                 r"pepper|black pepper|ketchup|mustard|mayo\w*|taco \w+|baking \w+|yeast|chocolate chips|coffee|tea|"
                 r"pancake mix|chili powder"),
]
# Things most kitchens have: not counted as missing for "What can we make?"
STAPLES = re.compile(r"^(salt|pepper|black pepper|salt and pepper|oil|olive oil|vegetable oil|water|sugar|flour|butter|"
                     r"garlic powder|onion powder|spices?|seasoning|cooking spray)$", re.I)
QTY = re.compile(r"^\s*((?:\d+[\d/.\s]*|½|¼|¾|⅓|a few|a|an|one|two|three|four|half)\s*"
                 r"(?:x\s*)?(?:cups?|c\.|tbsp|tablespoons?|tsp|teaspoons?|lbs?|pounds?|kg|g|grams?|oz|ounces?|ml|l|litres?|liters?|"
                 r"cans?|packs?|packages?|pkgs?|bags?|boxes?|jars?|bottles?|cloves?|heads?|bunch(?:es)?|slices?|pieces?|dozen)?\.?)\s+(?:of\s+)?",
                 re.I)


def category(name: str) -> str:
    low = name.lower()
    for label, pattern in CATEGORIES:
        if re.search(rf"\b(?:{pattern})\b", low):
            return label
    return "🛒 Other"


def split_qty(line: str) -> tuple[str, str]:
    """"2 lb ground beef" -> ("2 lb", "ground beef"); "milk" -> ("", "milk")."""
    line = re.sub(r"^\s*[-•*]\s*", "", line.strip())
    m = QTY.match(line)
    if m and m.end() < len(line):
        return m[1].strip(), line[m.end():].strip()
    return "", line


def _words(name: str) -> set[str]:
    stop = {"fresh", "large", "small", "medium", "lean", "extra", "chopped", "diced", "sliced", "shredded", "grated",
            "boneless", "skinless", "and", "or", "of", "the", "a", "to", "taste", "for", "with", "can", "cans"}
    return {_singular(w) for w in re.findall(r"[a-z]+", name.lower()) if len(w) > 2 and w not in stop}


def _singular(w: str) -> str:
    """tomatoes -> tomato, berries -> berry, eggs -> egg (good enough for matching food names)."""
    if w.endswith("oes") or w.endswith("ches") or w.endswith("shes"):
        return w[:-2]
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    return w[:-1] if w.endswith("s") and not w.endswith("ss") else w


def same_food(a: str, b: str) -> bool:
    """ "ground beef" ~ "Ground beef (lean)", "tomatoes" ~ "tomato"."""
    wa, wb = _words(a), _words(b)
    return bool(wa and wb) and (wa <= wb or wb <= wa)


# ---------------------------------------------------------------- starter recipes (the family changes these)

SEED_RECIPES = [
    ("🌮", "Tacos", 25, "ground beef\ntaco seasoning\ntaco shells\nshredded cheese\nlettuce\ntomatoes\nsour cream\nsalsa"),
    ("🍝", "Spaghetti and meat sauce", 30, "spaghetti\nground beef\npasta sauce\nonion\nparmesan"),
    ("🌶️", "Chili", 45, "ground beef\nkidney beans\ncanned tomatoes\nonion\nchili powder\nshredded cheese"),
    ("🥧", "Shepherd's pie", 60, "ground beef\npotatoes\ncorn\ncarrots\nonion\nbutter\nmilk"),
    ("🥡", "Chicken stir-fry", 25, "chicken breast\nfrozen stir-fry vegetables\nrice\nsoy sauce\ngarlic"),
    ("🍕", "Homemade pizza", 30, "pizza dough\npizza sauce\nmozzarella\npepperoni\nmushrooms"),
    ("🥞", "Breakfast for supper", 20, "eggs\nbacon\npancake mix\nmaple syrup\nmilk"),
    ("🫔", "Chicken fajitas", 25, "chicken breast\ntortillas\npeppers\nonion\nfajita seasoning\nsour cream\nshredded cheese"),
    ("🧀", "Mac and cheese with hot dogs", 20, "macaroni\ncheddar\nmilk\nbutter\nhot dogs"),
    ("🐟", "Baked salmon, rice and broccoli", 30, "salmon\nrice\nbroccoli\nlemon"),
    ("🥣", "Soup and grilled cheese", 20, "soup\nbread\ncheese slices\nbutter"),
    ("🍖", "Pork chops, potatoes and veggies", 40, "pork chops\npotatoes\ncarrots\npeas"),
]


def seed(conn) -> None:
    if conn.execute("SELECT 1 FROM settings WHERE key = 'recipes_seeded'").fetchone():
        return
    for emoji, name, minutes, items in SEED_RECIPES:
        rid = conn.execute("INSERT INTO recipes (name, emoji, minutes) VALUES (?, ?, ?)", (name, emoji, minutes)).lastrowid
        _save_items(conn, rid, items)
    conn.execute("INSERT INTO settings (key, value) VALUES ('recipes_seeded', '1')")


def _save_items(conn, rid: int, text: str) -> None:
    conn.execute("DELETE FROM recipe_items WHERE recipe_id = ?", (rid,))
    for i, line in enumerate(l for l in text.splitlines() if l.strip()):
        qty, name = split_qty(line)
        conn.execute("INSERT INTO recipe_items (recipe_id, name, qty, sort) VALUES (?, ?, ?, ?)", (rid, name[:80], qty[:30], i))


def _recipes(conn) -> list[dict]:
    recipes = db.rows(conn.execute("SELECT * FROM recipes ORDER BY name COLLATE NOCASE"))
    items = db.rows(conn.execute("SELECT * FROM recipe_items ORDER BY recipe_id, sort"))
    for r in recipes:
        r["items"] = [i for i in items if i["recipe_id"] == r["id"]]
    return recipes


# ---------------------------------------------------------------- recipes

class RecipeIn(BaseModel):
    name: str
    emoji: str = "🍽️"
    minutes: int | None = None
    ingredients: str = ""  # one per line
    notes: str = ""
    url: str = ""


@router.get("/recipes")
def list_recipes():
    with db.db() as conn:
        return _recipes(conn)


@router.post("/recipes")
def add_recipe(r: RecipeIn):
    if not r.name.strip():
        raise HTTPException(400, "give the recipe a name")
    with db.db() as conn:
        rid = conn.execute("INSERT INTO recipes (name, emoji, minutes, notes, url) VALUES (?, ?, ?, ?, ?)",
                           (r.name.strip()[:80], r.emoji.strip()[:8] or "🍽️", r.minutes, r.notes, r.url.strip())).lastrowid
        _save_items(conn, rid, r.ingredients)
    return {"id": rid}


@router.put("/recipes/{rid}")
def update_recipe(rid: int, r: RecipeIn):
    with db.db() as conn:
        if not conn.execute("UPDATE recipes SET name = ?, emoji = ?, minutes = ?, notes = ?, url = ? WHERE id = ?",
                            (r.name.strip()[:80], r.emoji.strip()[:8] or "🍽️", r.minutes, r.notes, r.url.strip(), rid)).rowcount:
            raise HTTPException(404, "no such recipe")
        _save_items(conn, rid, r.ingredients)
    return {"ok": True}


@router.delete("/recipes/{rid}")
def delete_recipe(rid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM recipes WHERE id = ?", (rid,))
    return {"ok": True}


# ---------------------------------------------------------------- the week's suppers

class PlanIn(BaseModel):
    recipe_id: int | None = None
    title: str = ""  # a supper that isn't a recipe ("Leftovers", "Takeout")
    notes: str = ""


def _day(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(400, "bad date")


@router.get("/plan")
def get_plan(start: str, days: int = 7):
    s = _day(start)
    with db.db() as conn:
        rows = {r["date"]: r for r in db.rows(conn.execute(
            "SELECT m.*, r.name AS recipe, r.emoji FROM meal_plan m LEFT JOIN recipes r ON r.id = m.recipe_id "
            "WHERE m.date >= ? AND m.date < ?", (s.isoformat(), (s + timedelta(days=min(days, 31))).isoformat())))}
    return [{"date": (s + timedelta(days=i)).isoformat(), **(rows.get((s + timedelta(days=i)).isoformat()) or {})}
            for i in range(min(days, 31))]


@router.put("/plan/{day}")
def set_plan(day: str, p: PlanIn):
    d = _day(day)
    with db.db() as conn:
        if p.recipe_id is None and not p.title.strip():
            conn.execute("DELETE FROM meal_plan WHERE date = ?", (d.isoformat(),))
        else:
            conn.execute("INSERT INTO meal_plan (date, recipe_id, title, notes) VALUES (?, ?, ?, ?) "
                         "ON CONFLICT(date) DO UPDATE SET recipe_id = excluded.recipe_id, title = excluded.title, notes = excluded.notes",
                         (d.isoformat(), p.recipe_id, p.title.strip()[:80], p.notes.strip()[:200]))
    return {"ok": True}


def supper_titles(conn, start: date, end: date) -> dict[str, str]:
    """For the calendar and the wall screen: {"2026-09-28": "🌮 Tacos"}."""
    out = {}
    for r in conn.execute("SELECT m.date, m.title, r.name, r.emoji FROM meal_plan m LEFT JOIN recipes r ON r.id = m.recipe_id "
                          "WHERE m.date >= ? AND m.date < ?", (start.isoformat(), end.isoformat())):
        out[r["date"]] = f"{r['emoji'] or '🍽️'} {r['name']}" if r["name"] else f"🍽️ {r['title']}"
    return out


class RangeIn(BaseModel):
    start: str
    days: int = 7


@router.post("/plan/to-list")
def plan_to_list(body: RangeIn):
    """Put the planned recipes' ingredients on the grocery list, minus what's in the house or already on the list."""
    s = _day(body.start)
    added, skipped = [], []
    with db.db() as conn:
        plan = db.rows(conn.execute(
            "SELECT m.date, r.id, r.name FROM meal_plan m JOIN recipes r ON r.id = m.recipe_id WHERE m.date >= ? AND m.date < ?",
            (s.isoformat(), (s + timedelta(days=min(body.days, 31))).isoformat())))
        pantry = [r["name"] for r in conn.execute("SELECT name FROM pantry")]
        listed = [r["name"] for r in conn.execute("SELECT name FROM grocery WHERE done = 0")]
        for p in plan:
            day = date.fromisoformat(p["date"]).strftime("%a")
            for it in conn.execute("SELECT name, qty FROM recipe_items WHERE recipe_id = ?", (p["id"],)):
                name = it["name"]
                if STAPLES.match(name) or any(same_food(name, x) for x in pantry):
                    skipped.append(name)
                    continue
                if any(same_food(name, x) for x in listed):
                    continue
                conn.execute("INSERT INTO grocery (name, qty, category, source) VALUES (?, ?, ?, ?)",
                             (name, it["qty"], category(name), f"{p['name']} ({day})"))
                listed.append(name)
                added.append(name)
    return {"added": added, "have": sorted(set(skipped))}


# ---------------------------------------------------------------- grocery list (shared)

class ItemsIn(BaseModel):
    text: str  # one item per line
    source: str = ""


class GroceryEdit(BaseModel):
    name: str | None = None
    qty: str | None = None
    done: bool | None = None
    store: str | None = None


@router.get("/list")
def get_list():
    with db.db() as conn:
        return db.rows(conn.execute(
            "SELECT * FROM grocery WHERE done = 0 OR done_at >= datetime('now', '-12 hours') ORDER BY done, category, name COLLATE NOCASE"))


@router.post("/list")
def add_to_list(body: ItemsIn):
    added = []
    with db.db() as conn:
        for line in body.text.splitlines():
            qty, name = split_qty(line)
            if name:
                conn.execute("INSERT INTO grocery (name, qty, category, source) VALUES (?, ?, ?, ?)",
                             (name[:80], qty[:30], category(name), body.source[:80]))
                added.append(name)
    return {"added": added}


@router.put("/list/{gid}")
def edit_item(gid: int, e: GroceryEdit):
    with db.db() as conn:
        row = conn.execute("SELECT * FROM grocery WHERE id = ?", (gid,)).fetchone()
        if not row:
            raise HTTPException(404, "no such item")
        if e.name is not None and e.name.strip():
            conn.execute("UPDATE grocery SET name = ?, category = ? WHERE id = ?", (e.name.strip()[:80], category(e.name), gid))
        if e.qty is not None:
            conn.execute("UPDATE grocery SET qty = ? WHERE id = ?", (e.qty.strip()[:30], gid))
        if e.store is not None:
            conn.execute("UPDATE grocery SET store = ? WHERE id = ?", (e.store.strip()[:40], gid))
        if e.done is not None:
            conn.execute("UPDATE grocery SET done = ?, done_at = CASE WHEN ? THEN datetime('now') END WHERE id = ?",
                         (int(e.done), int(e.done), gid))
            if e.done and db.get_setting(conn, "grocery_to_pantry", "1") == "1":
                # Bought: now it's in the house (unticking takes it back out).
                if not any(same_food(row["name"], r["name"]) for r in conn.execute("SELECT name FROM pantry")):
                    conn.execute("INSERT INTO pantry (name, qty, place, from_list) VALUES (?, ?, ?, ?)",
                                 (row["name"], row["qty"], _place(row["name"]), gid))
            elif not e.done:
                conn.execute("DELETE FROM pantry WHERE from_list = ?", (gid,))
    return {"ok": True}


@router.delete("/list/{gid}")
def delete_item(gid: int):
    with db.db() as conn:
        conn.execute("DELETE FROM grocery WHERE id = ?", (gid,))
    return {"ok": True}


@router.post("/list/clear")
def clear_done():
    with db.db() as conn:
        n = conn.execute("DELETE FROM grocery WHERE done = 1").rowcount
    return {"cleared": n}


def _place(name: str) -> str:
    c = category(name)
    return "freezer" if c.startswith("❄️") else "fridge" if c.startswith(("🥩", "🥛", "🥦")) else "cupboard"


# ---------------------------------------------------------------- pantry (what's in the house)

class PantryIn(BaseModel):
    text: str
    place: str = ""


class PantryEdit(BaseModel):
    name: str | None = None
    qty: str | None = None
    place: str | None = None


@router.get("/pantry")
def get_pantry():
    with db.db() as conn:
        return db.rows(conn.execute("SELECT * FROM pantry ORDER BY place, name COLLATE NOCASE"))


@router.post("/pantry")
def add_pantry(body: PantryIn):
    added = []
    with db.db() as conn:
        for line in body.text.splitlines():
            qty, name = split_qty(line)
            if name:
                place = body.place if body.place in PLACES else _place(name)
                conn.execute("INSERT INTO pantry (name, qty, place) VALUES (?, ?, ?)", (name[:80], qty[:30], place))
                added.append(name)
    return {"added": added}


@router.put("/pantry/{pid}")
def edit_pantry(pid: int, e: PantryEdit):
    with db.db() as conn:
        for col in ("name", "qty", "place"):
            v = getattr(e, col)
            if v is not None and (col != "place" or v in PLACES):
                conn.execute(f"UPDATE pantry SET {col} = ? WHERE id = ?", (v.strip()[:80], pid))
    return {"ok": True}


@router.delete("/pantry/{pid}")
def use_up(pid: int, to_list: bool = False):
    """Used up. With to_list, it goes back on the grocery list."""
    with db.db() as conn:
        row = conn.execute("SELECT * FROM pantry WHERE id = ?", (pid,)).fetchone()
        conn.execute("DELETE FROM pantry WHERE id = ?", (pid,))
        if row and to_list:
            conn.execute("INSERT INTO grocery (name, qty, category, source) VALUES (?, '', ?, 'ran out')", (row["name"], category(row["name"])))
    return {"ok": True}


# ---------------------------------------------------------------- what can we make?

@router.get("/ideas")
def ideas():
    """Recipes ranked by how much of them is already in the house; what's missing; which missing things are on sale."""
    with db.db() as conn:
        pantry = [r["name"] for r in conn.execute("SELECT name FROM pantry")]
        recipes = _recipes(conn)
        fs = flyers.settings(conn)
    out = []
    for r in recipes:
        needed = [i for i in r["items"] if not STAPLES.match(i["name"])]
        if not needed:
            continue
        have = [i["name"] for i in needed if any(same_food(i["name"], p) for p in pantry)]
        missing = [i["name"] for i in needed if i["name"] not in have]
        out.append({"id": r["id"], "name": r["name"], "emoji": r["emoji"], "minutes": r["minutes"],
                    "have": have, "missing": missing, "score": len(have) / len(needed)})
    out.sort(key=lambda r: (-r["score"], len(r["missing"]), r["name"]))
    return {"ideas": out, "pantry_count": len(pantry), "stores": fs["stores"]}


# ---------------------------------------------------------------- cook with what we have (our recipes + TheMealDB)

COMMON = ["chicken breast", "ground beef", "pork chops", "sausages", "bacon", "ham", "salmon", "eggs", "potatoes", "rice",
          "pasta", "cheese", "tortillas", "onion", "peppers", "tomatoes", "carrots", "broccoli", "mushrooms", "beans"]


@router.get("/cook/ingredients")
def cook_ingredients():
    """What to offer on the picker: what's in the house first, then common suppers' main ingredients."""
    with db.db() as conn:
        pantry = [r["name"] for r in conn.execute("SELECT name FROM pantry ORDER BY added DESC")]
    house = list(dict.fromkeys(p for p in pantry if not STAPLES.match(p)))
    return {"house": house, "common": [c for c in COMMON if not any(same_food(c, h) for h in house)]}


class CookIn(BaseModel):
    have: list[str]
    sides: bool = False


def _have_missing(items: list[dict], have: list[str]) -> tuple[list[str], list[str]]:
    needed = [i["name"] for i in items if not STAPLES.match(i["name"])]
    got = [n for n in needed if any(same_food(n, h) for h in have)]
    return got, [n for n in needed if n not in got]


@router.post("/cook")
def cook(body: CookIn):
    """Suppers using the picked ingredients: our recipes first, then more from TheMealDB."""
    picked = [h.strip() for h in body.have if h.strip()]
    if not picked:
        raise HTTPException(400, "pick at least one thing to cook with")
    with db.db() as conn:
        pantry = [r["name"] for r in conn.execute("SELECT name FROM pantry")]
        recipes = _recipes(conn)
    have = picked + pantry
    ours = []
    for r in recipes:
        uses = [p for p in picked if any(same_food(p, i["name"]) for i in r["items"])]
        if uses:
            got, missing = _have_missing(r["items"], have)
            ours.append({"id": r["id"], "name": r["name"], "emoji": r["emoji"], "uses": uses, "have": got, "missing": missing})
    ours.sort(key=lambda r: (-len(r["uses"]), len(r["missing"])))
    more = []
    for m in recipe_ideas.find(picked, sides=body.sides):
        got, missing = _have_missing(m["items"], have)
        more.append({"id": m["id"], "name": m["name"], "image": m["image"], "category": m["category"], "area": m["area"],
                     "uses": m["uses"], "have": got, "missing": missing})
    return {"ours": ours, "more": more, "picked": picked}


@router.get("/cook/meal/{mid}")
def cook_meal(mid: str, picked: str = ""):
    """One meal's ingredients (ticked if they're in the house or picked) and how to make it."""
    m = recipe_ideas.meal(mid)
    if not m:
        raise HTTPException(404, "that meal isn't there any more")
    with db.db() as conn:
        have = [r["name"] for r in conn.execute("SELECT name FROM pantry")] + [p for p in picked.split(",") if p.strip()]
    for i in m["items"]:
        i["have"] = bool(STAPLES.match(i["name"])) or any(same_food(i["name"], h) for h in have)
    return m


@router.post("/cook/meal/{mid}/save")
def save_meal(mid: str):
    """Keep one of TheMealDB's meals as our own recipe (then it can go on the plan and the list)."""
    m = recipe_ideas.meal(mid)
    if not m:
        raise HTTPException(404, "that meal isn't there any more")
    with db.db() as conn:
        found = conn.execute("SELECT id FROM recipes WHERE name = ?", (m["name"],)).fetchone()
        if found:
            return {"id": found["id"], "existing": True}
        rid = conn.execute("INSERT INTO recipes (name, emoji, notes, url) VALUES (?, ?, ?, ?)",
                           (m["name"][:80], recipe_ideas.EMOJI.get(m["category"], "🍽️"), m["instructions"][:8000],
                            m["source"] or m["youtube"] or f"https://www.themealdb.com/meal/{m['id']}")).lastrowid
        _save_items(conn, rid, "\n".join(f"{i['qty']} {i['name']}".strip() for i in m["items"]))
    return {"id": rid, "existing": False}


# ---------------------------------------------------------------- flyers

class FlyerSettingsIn(BaseModel):
    postal: str | None = None
    stores: list[str] | None = None
    watch: list[str] | None = None


@router.get("/flyers/settings")
def flyer_settings():
    with db.db() as conn:
        s = flyers.settings(conn)
    if not s["postal"]:
        return {**s, "available": [], "error": "Put in your postal or ZIP code below to see the flyers near you."}
    try:
        available = flyers.stores(s["postal"])
    except Exception as exc:
        available, s["error"] = [], f"couldn't reach Flipp ({exc.__class__.__name__})"
    return {**s, "available": available}


@router.put("/flyers/settings")
def save_flyer_settings(body: FlyerSettingsIn):
    with db.db() as conn:
        def put(k, v):
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, v))
        if body.postal is not None:
            postal = re.sub(r"\s+", "", body.postal).upper()
            if not re.fullmatch(r"[A-Z]\d[A-Z]\d[A-Z]\d|\d{5}", postal):
                raise HTTPException(400, "that doesn't look like a postal or ZIP code")
            put("flyer_postal", postal)
        if body.stores is not None:
            put("flyer_stores", json.dumps([s.strip() for s in body.stores if s.strip()][:30]))
        if body.watch is not None:
            put("flyer_watch", json.dumps([w.strip() for w in body.watch if w.strip()][:40]))
    return {"ok": True}


@router.get("/flyers/search")
def flyer_search(q: str, all_stores: bool = False):
    with db.db() as conn:
        s = flyers.settings(conn)
    return flyers.search(q, s["postal"], [] if all_stores else s["stores"], 40)


@router.get("/flyers/deals")
def flyer_deals():
    """Best prices for what's on the grocery list and the watch list, at the chosen stores."""
    with db.db() as conn:
        s = flyers.settings(conn)
        listed = [r["name"] for r in conn.execute("SELECT name FROM grocery WHERE done = 0")]
    found = flyers.deals(listed + s["watch"], s["postal"], s["stores"])
    return {"list": {n: found.get(n, []) for n in listed}, "watch": {n: found.get(n, []) for n in s["watch"]},
            "stores": s["stores"]}


@router.get("/flyers/store")
def flyer_store(name: str):
    with db.db() as conn:
        s = flyers.settings(conn)
    if not s["postal"]:
        raise HTTPException(400, "put in your postal or ZIP code first (Meals → Deals)")
    return flyers.store_flyer(name, s["postal"])
