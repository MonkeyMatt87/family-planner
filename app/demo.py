"""Fills an empty planner with a made-up family, to try it out or take screenshots:

    docker exec family-planner python -m app.demo          (family PIN: 2468)

Only runs on a planner that hasn't been set up yet. To start over for real afterwards, stop the planner and
delete data/planner.db.
"""
import random
import sys
from datetime import date, timedelta

from . import auth, db

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
                     "holiday_country": "CA", "holiday_subdiv": "NS", "temp_unit": "celsius", "lunch_auto": "0"}.items():
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, v))

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
