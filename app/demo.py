"""Fills an empty planner with a made-up family, to try it out or take screenshots:

    docker exec family-planner python -m app.demo          (family PIN: 2468)

Only runs on a planner that hasn't been set up yet. To start over for real afterwards, stop the planner and
delete data/planner.db.
"""
import json
import random
import sys
from datetime import date, timedelta

from . import auth, db, meals

PEOPLE = [("Alex", "#f07a1a", 0, "💻"), ("Sam", "#8e5bd6", 0, "🩺"), ("Maya", "#e0529c", 1, ""), ("Leo", "#2e9e5b", 1, "")]
MENU = ["Chicken wrap", "Pasta with meat sauce", "Pizza day", "Tacos", "Mac & cheese", "Turkey sandwich",
        "Chicken nuggets", "Pancakes", "Chili & rice", "Grilled cheese"]


def main() -> None:
    db.init()
    with db.db() as conn:
        if db.is_set_up(conn):
            sys.exit("This planner already has people in it; the demo only fills an empty one.")
        ids = {}
        for i, (name, color, kid, icon) in enumerate(PEOPLE, start=1):
            ids[name] = conn.execute("INSERT INTO people (name, color, is_kid, sort, icon, theme) VALUES (?, ?, ?, ?, ?, ?)",
                                     (name, color, kid, i, icon, {"Maya": "island", "Leo": "power"}.get(name, ""))).lastrowid
            if kid:
                db.seed_chores(conn, ids[name])
        conn.execute("UPDATE people SET birthday = ? WHERE id = ?", ((date.today() + timedelta(days=12)).replace(year=2016).isoformat(), ids["Maya"]))
        for k, v in {"family_name": "The Rivera Family", "latitude": "44.6488", "longitude": "-63.5752",
                     "holiday_country": "CA", "holiday_subdiv": "NS", "temp_unit": "celsius", "lunch_auto": "0",
                     "school_rotation": "6", "flyer_postal": "B3H1A1"}.items():
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, v))
        specials = {"Maya": {"1": "👟 Gym", "3": "🎵 Music", "4": "👟 Gym", "6": "📚 Library"},
                    "Leo": {"2": "👟 Gym", "5": "🎵 Music · 📚 Library"}}
        for name, days in specials.items():
            conn.execute("UPDATE people SET specials = ?, teacher = ? WHERE id = ?",
                         (json.dumps(days), {"Maya": "Ms. Chen", "Leo": "Mr. Okafor"}[name], ids[name]))

        # Rewards, the medicine cabinet and the grocery list, so every tab has something in it.
        for title, cost in [("🎬 Pick Friday's movie", 15), ("🍦 Ice cream trip", 30), ("🕹️ An extra hour of games", 25)]:
            conn.execute("INSERT INTO rewards (title, cost) VALUES (?, ?)", (title, cost))
        cabinet = [("Children's ibuprofen", "med", "7.5 mL", 6, 4, ["Maya", "Leo"]), ("Allergy tablet", "med", "1 tablet", None, None, ["Sam"])]
        for name, kind, dose, every, most, takers in cabinet:
            cid = conn.execute("INSERT INTO med_catalog (name, kind, dose, min_hours, max_per_day, times) VALUES (?, ?, ?, ?, ?, ?)",
                               (name, kind, dose, every, most, "[]" if every else '["08:00"]')).lastrowid
            for who in takers:
                conn.execute("INSERT INTO meds (person_id, name, kind, dose, times, min_hours, max_per_day, catalog_id) "
                             "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                             (ids[who], name, kind, dose, "[]" if every else '["08:00"]', every, most, cid))
        conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)",
                     (f"money_{ids['Maya']}", json.dumps({"weekly": 500, "payday": 5, "need_stars": 15, "star_cents": 25})))
        conn.execute("INSERT INTO money_log (person_id, cents, kind, note, at) VALUES (?, 1000, 'gift', 'Birthday money from Nan', ?)",
                     (ids["Maya"], f"{date.today() - timedelta(days=3)}T10:00"))
        conn.executemany("INSERT INTO contacts (name, role, grp, phone, sitter) VALUES (?, ?, ?, ?, ?)", [
            ("Alex", "Dad (cell)", "family", "902-555-0141", 1), ("Sam", "Mom (cell)", "family", "902-555-0172", 1),
            ("Dr. Singh", "Family doctor", "health", "902-555-0199", 1), ("Jordan", "Babysitter", "sitters", "902-555-0123", 0)])
        conn.executemany("INSERT INTO settings (key, value) VALUES (?, ?)", [
            ("sitter_address", "12 Harbour View Rd"), ("sitter_notes", "Wi-Fi: RiveraHome\nFirst-aid kit: hall closet\nNo screens after 7")])
        for name, cat in [("Milk", "🥛 Dairy & eggs"), ("Bananas", "🥦 Produce"), ("Bread", "🍞 Bakery"), ("Chicken thighs", "🥩 Meat & fish")]:
            conn.execute("INSERT INTO grocery (name, category) VALUES (?, ?)", (name, cat))
        meals.seed(conn)
        recipes = [r["id"] for r in conn.execute("SELECT id FROM recipes ORDER BY id LIMIT 5")]
        for i, rid in enumerate(recipes):
            conn.execute("INSERT OR REPLACE INTO meal_plan (date, recipe_id) VALUES (?, ?)", ((date.today() + timedelta(days=i)).isoformat(), rid))

        t = date.today()
        tasks = [("Science fair poster", "Maya", "project", 4), ("Reading log", "Leo", "school", 1),
                 ("Permission slip for the field trip", "Leo", "school", 2), ("Pay the water bill", "Alex", "errand", 3),
                 ("Buy birthday present for Nora", "Sam", "errand", 5), ("Practice spelling words", "Maya", "school", None),
                 ("Clean out the garage", None, "chore", 9)]
        for title, who, cat, days in tasks:
            conn.execute("INSERT INTO tasks (title, person_id, category, due_date) VALUES (?, ?, ?, ?)",
                         (title, ids.get(who), cat, (t + timedelta(days=days)).isoformat() if days is not None else None))
        appts = [("Dentist", "Maya", 1, "10:30", "11:15", "Main Street Dental"), ("Soccer practice", "Leo", 2, "18:00", "19:00", "Community field"),
                 ("Parent-teacher night", None, 3, "18:30", "20:00", "School gym"), ("Eye exam", "Alex", 6, "09:00", None, ""),
                 ("Swimming lessons", "Maya", 5, "17:00", "17:45", "Aquatic centre"), ("Grandma's birthday dinner", None, 7, None, None, "")]
        for title, who, days, start, end, where in appts:
            conn.execute("INSERT INTO appointments (title, person_id, date, start_time, end_time, location) VALUES (?, ?, ?, ?, ?, ?)",
                         (title, ids.get(who), (t + timedelta(days=days)).isoformat(), start, end, where))
        for i in range(-3, 21):
            d = t + timedelta(days=i)
            if d.weekday() < 5:
                conn.execute("INSERT INTO shifts (person_id, date, start_time, end_time, label) VALUES (?, ?, ?, ?, ?)",
                             (ids["Alex"], d.isoformat(), "08:30", "17:00", "Work"))
            if d.weekday() in (0, 2, 3, 5):
                conn.execute("INSERT INTO shifts (person_id, date, start_time, end_time, label) VALUES (?, ?, ?, ?, ?)",
                             (ids["Sam"], d.isoformat(), "07:00", "15:00", random.choice(["Clinic", "Hospital"])))
            if d.weekday() < 5:
                conn.execute("INSERT OR REPLACE INTO lunch_menu (date, menu) VALUES (?, ?)", (d.isoformat(), MENU[i % len(MENU)]))
                conn.execute("INSERT OR REPLACE INTO lunch_plan (date, person_id, choice) VALUES (?, ?, ?)",
                             (d.isoformat(), ids["Maya"], "buy" if i % 3 == 0 else "pack"))
                conn.execute("INSERT OR REPLACE INTO lunch_plan (date, person_id, choice) VALUES (?, ?, ?)",
                             (d.isoformat(), ids["Leo"], "pack"))
    auth.set_password("2468")
    print("Demo family added: Alex, Sam, Maya and Leo. Family PIN: 2468. Open http://<server>:8080")


if __name__ == "__main__":
    main()
