"""SQLite storage. One file, created on first start, lives in DATA_DIR (a Docker volume)."""
import os
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = DATA_DIR / "planner.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    color   TEXT NOT NULL,
    is_kid  INTEGER NOT NULL DEFAULT 0,
    sort    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    person_id  INTEGER REFERENCES people(id) ON DELETE SET NULL,
    category   TEXT NOT NULL DEFAULT 'other',
    due_date   TEXT,
    notes      TEXT NOT NULL DEFAULT '',
    done       INTEGER NOT NULL DEFAULT 0,
    done_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shift_templates (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time   TEXT NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shifts (
    id         INTEGER PRIMARY KEY,
    person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time   TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT 'Work',
    notes      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS shifts_date ON shifts(date);

CREATE TABLE IF NOT EXISTS lunch_menu (
    date TEXT PRIMARY KEY,
    menu TEXT NOT NULL DEFAULT '',
    no_school INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lunch_plan (
    date      TEXT NOT NULL,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    choice    TEXT NOT NULL,
    PRIMARY KEY (date, person_id)
);

CREATE TABLE IF NOT EXISTS lunch_default (
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    weekday   INTEGER NOT NULL,
    choice    TEXT NOT NULL,
    PRIMARY KEY (person_id, weekday)
);

-- Dishes a kid likes: on days the school menu serves one, they buy; other days they pack.
CREATE TABLE IF NOT EXISTS lunch_like (
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    dish      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendars (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    url       TEXT NOT NULL,
    person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    color     TEXT
);

-- Kids' daily chores ("Brush my teeth"); ticked off by the kids on their page, reset each day.
CREATE TABLE IF NOT EXISTS chores (
    id          INTEGER PRIMARY KEY,
    person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    school_days INTEGER NOT NULL DEFAULT 0,   -- 1 = only on school days
    sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chore_done (
    chore_id INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
    date     TEXT NOT NULL,
    PRIMARY KEY (chore_id, date)
);

-- From teachers' emails (school_mail.py) and Settings: kind is closed / maybe / event / day (rotation number).
CREATE TABLE IF NOT EXISTS school_dates (
    date       TEXT NOT NULL,
    title      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    day_number INTEGER,
    source     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS school_dates_date ON school_dates(date);

-- Kids' phones that turned on the morning summary (Web Push subscriptions).
CREATE TABLE IF NOT EXISTS push_subs (
    id        INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    endpoint  TEXT NOT NULL UNIQUE,
    p256dh    TEXT NOT NULL,
    auth      TEXT NOT NULL,
    created   TEXT NOT NULL
);

-- Bills (adults only): repeat is none / weekly / biweekly / monthly / yearly, counted from due_date.
CREATE TABLE IF NOT EXISTS bills (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    amount   TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL,
    repeat   TEXT NOT NULL DEFAULT 'monthly',
    notes    TEXT NOT NULL DEFAULT '',
    active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bill_paid (
    bill_id  INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    due_date TEXT NOT NULL,
    paid_at  TEXT NOT NULL,
    PRIMARY KEY (bill_id, due_date)
);

-- Face ID sign-in: one row per phone (public key only; the private key never leaves the phone).
CREATE TABLE IF NOT EXISTS passkeys (
    id         TEXT PRIMARY KEY,
    public_key BLOB NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    name       TEXT NOT NULL DEFAULT '',
    created    TEXT NOT NULL,
    last_used  TEXT
);

-- Appointments typed into the planner (Google events stay in Google). No person = the whole family.
CREATE TABLE IF NOT EXISTS appointments (
    id         INTEGER PRIMARY KEY,
    person_id  INTEGER REFERENCES people(id) ON DELETE SET NULL,
    date       TEXT NOT NULL,
    start_time TEXT,             -- NULL = all day
    end_time   TEXT,
    title      TEXT NOT NULL,
    location   TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    added_by   INTEGER,          -- the phone sign-in that added it, if any
    google_id    TEXT NOT NULL DEFAULT '',  -- its copy in the Google calendar (see gcal.py)
    google_state TEXT NOT NULL DEFAULT '',  -- ok, pending (not copied yet), delete (to remove from Google)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS appointments_date ON appointments(date);

-- Names given to devices on the Homelab tab (the scan only knows MAC, IP and maker).
CREATE TABLE IF NOT EXISTS device_names (
    mac  TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

-- Emails from the kids' teachers, uploaded on My page → Kids (the files are in DATA_DIR/mail/<id>/).
CREATE TABLE IF NOT EXISTS teacher_mail (
    id         INTEGER PRIMARY KEY,
    person_id  INTEGER REFERENCES people(id) ON DELETE CASCADE,
    sender     TEXT NOT NULL DEFAULT '',
    sender_email TEXT NOT NULL DEFAULT '',
    subject    TEXT NOT NULL DEFAULT '',
    sent       TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    files      TEXT NOT NULL DEFAULT '[]',  -- JSON list of file names, in order
    applied    TEXT NOT NULL DEFAULT '',    -- when its suggestions were added
    created    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Rewards the kids save their stars (flowers, coins) for. No person = either kid. The adults choose them.
CREATE TABLE IF NOT EXISTS rewards (
    id        INTEGER PRIMARY KEY,
    person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
    title     TEXT NOT NULL,
    cost      INTEGER NOT NULL,
    sort      INTEGER NOT NULL DEFAULT 0
);

-- Rewards given: their cost comes off the kid's saved stars.
CREATE TABLE IF NOT EXISTS reward_log (
    id        INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    title     TEXT NOT NULL,
    cost      INTEGER NOT NULL,
    at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every notification sent (for Admin → Overview and Notifications). Trimmed to the last 500.
CREATE TABLE IF NOT EXISTS push_log (
    id        INTEGER PRIMARY KEY,
    person_id INTEGER,
    title     TEXT NOT NULL,
    body      TEXT NOT NULL DEFAULT '',
    phones    INTEGER NOT NULL DEFAULT 0,
    at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Meals (/meals): recipes and their ingredients, the week's suppers, the grocery list, what's in the house.
CREATE TABLE IF NOT EXISTS recipes (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    emoji   TEXT NOT NULL DEFAULT '🍽️',
    minutes INTEGER,
    notes   TEXT NOT NULL DEFAULT '',
    url     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS recipe_items (
    id        INTEGER PRIMARY KEY,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    qty       TEXT NOT NULL DEFAULT '',
    sort      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meal_plan (
    date      TEXT PRIMARY KEY,               -- one supper a day
    recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
    title     TEXT NOT NULL DEFAULT '',       -- when it isn't a recipe ("Leftovers")
    notes     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS grocery (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    qty      TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    store    TEXT NOT NULL DEFAULT '',
    source   TEXT NOT NULL DEFAULT '',        -- "Tacos (Tue)", "ran out"
    done     INTEGER NOT NULL DEFAULT 0,
    done_at  TEXT,
    created  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pantry (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    qty       TEXT NOT NULL DEFAULT '',
    place     TEXT NOT NULL DEFAULT 'cupboard', -- fridge, freezer, cupboard, other
    from_list INTEGER,                           -- the grocery item that brought it in
    added     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Medicine: each belongs to someone; times = reminder times (JSON list); spacing rules come from the package.
CREATE TABLE IF NOT EXISTS meds (
    id          INTEGER PRIMARY KEY,
    person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    dose        TEXT NOT NULL DEFAULT '',
    times       TEXT NOT NULL DEFAULT '[]',
    min_hours   REAL,                 -- at least this long between doses
    max_per_day INTEGER,
    notes       TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1
);

-- The medicine cabinet: a medicine entered once; meds has a row for each person who takes it.
CREATE TABLE IF NOT EXISTS med_catalog (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'med',
    dose        TEXT NOT NULL DEFAULT '',   -- the usual amount (each person can have their own)
    times       TEXT NOT NULL DEFAULT '[]',
    min_hours   REAL,
    max_per_day INTEGER,
    notes       TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1
);

-- Every dose taken or given.
CREATE TABLE IF NOT EXISTS med_log (
    id        INTEGER PRIMARY KEY,
    med_id    INTEGER NOT NULL REFERENCES meds(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL,
    dose      TEXT NOT NULL DEFAULT '',
    at        TEXT NOT NULL,          -- local time, YYYY-MM-DDTHH:MM
    slot      TEXT NOT NULL DEFAULT '', -- the reminder time it was for ("08:00"), if any
    by_person INTEGER,                -- who gave it
    note      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS med_log_at ON med_log(at);

-- Symptoms noted for the doctor (cough, wheeze, fever...): kinds is a comma list, temp in °C.
CREATE TABLE IF NOT EXISTS symptoms (
    id        INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    at        TEXT NOT NULL,
    kinds     TEXT NOT NULL DEFAULT '',
    severity  TEXT NOT NULL DEFAULT '',   -- mild, moderate, bad
    temp      REAL,
    note      TEXT NOT NULL DEFAULT '',
    by_person INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

SEED_CHORES = [
    ("🎒 Ready for school on time", 1),
    ("🪥 Brush my teeth", 0),
    ("👕 Pick up my clothes", 0),
    ("🛏️ Clean my room", 0),
]

# chores.school_days: 0 = every day/night, 1 = school days (for bedtime and homework: school tomorrow),
# 2 = the other nights (weekends and nights before a day off).
# School nights: get ready at 6:30, story at 7:00, in bed by 7:30. Other nights it's 8:00.
SEED_BEDTIME = [
    ("18:30", "🛁 Get ready for bed (pyjamas, teeth)"),
    ("19:00", "📖 Story time"),
    ("19:15", "🛏️ In bed by 7:30"),
]

SEED_BEDTIME_WEEKEND = [
    ("19:30", "🛁 Get ready for bed (pyjamas, teeth)"),
    ("19:45", "📖 Story time"),
    ("20:00", "🛏️ In bed by 8:00"),
]

# Homework and reading, shown after school. (title, school_days)
SEED_HOMEWORK = [("📖 Read for 20 minutes", 0), ("📝 Homework", 1)]

SEED_TEMPLATES = [
    ("Day", "07:00", "15:00", 1),
    ("Evening", "15:00", "23:00", 2),
    ("Night", "23:00", "07:00", 3),
]


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(SCHEMA)
        # Columns added after the first release.
        for table, column, ddl in (
            ("people", "aliases", "TEXT NOT NULL DEFAULT ''"),  # other names in calendar titles ("Dad, Mom")
            ("people", "icon", "TEXT NOT NULL DEFAULT ''"),     # emoji shown by the name
            ("passkeys", "role", "TEXT NOT NULL DEFAULT 'adult'"),  # 'kid' passkeys only open the kids' page
            ("people", "theme", "TEXT NOT NULL DEFAULT ''"),        # kids' page look: island / power
            ("people", "birthday", "TEXT NOT NULL DEFAULT ''"),     # YYYY-MM-DD, for countdowns
            ("tasks", "added_by", "INTEGER"),                       # set when a kid added it themselves
            ("people", "pin_hash", "TEXT NOT NULL DEFAULT ''"),     # their own PIN (optional)
            ("people", "access", "TEXT NOT NULL DEFAULT 'full'"),   # full, or phone = /mobile + own shifts
            ("chores", "routine", "TEXT NOT NULL DEFAULT 'day'"),   # day, or bedtime (the evening checklist)
            ("chores", "at", "TEXT NOT NULL DEFAULT ''"),           # HH:MM: a bedtime step's reminder time
            ("people", "teacher", "TEXT NOT NULL DEFAULT ''"),      # a kid's teacher ("Ms. Smith")
            ("people", "teacher_email", "TEXT NOT NULL DEFAULT ''"),
            ("people", "class_notes", "TEXT NOT NULL DEFAULT ''"),  # codes and standing reminders from the teacher
            ("people", "specials", "TEXT NOT NULL DEFAULT ''"),     # JSON {"1": "🎵 Music", ...}: what each school Day has
            ("meds", "kind", "TEXT NOT NULL DEFAULT 'med'"),        # med, or puffer (an inhaler: doses are puffs)
            ("meds", "puffs_left", "INTEGER"),                      # a puffer's counter, if the family keeps it
            ("med_log", "puffs", "INTEGER"),
            ("meds", "catalog_id", "INTEGER"),                      # its entry in the medicine cabinet (med_catalog)
            ("people", "page_tabs", "TEXT NOT NULL DEFAULT ''"),    # JSON list of the tabs their page shows ('' = all)
        ):
            if column not in {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        # People are added on the first-run setup screen (/setup), not here.
        # Planners set up before v1.1 get the bedtime and homework routines once, for the kids they have.
        if not conn.execute("SELECT 1 FROM settings WHERE key = 'routines_seeded'").fetchone():
            for kid in conn.execute("SELECT id FROM people WHERE is_kid = 1").fetchall():
                if not conn.execute("SELECT 1 FROM chores WHERE person_id = ? AND routine != 'day'", (kid["id"],)).fetchone():
                    seed_routines(conn, kid["id"])
            conn.execute("INSERT INTO settings (key, value) VALUES ('routines_seeded', '1')")
        if not conn.execute("SELECT 1 FROM shift_templates LIMIT 1").fetchone():
            conn.executemany(
                "INSERT INTO shift_templates (name, start_time, end_time, sort) VALUES (?, ?, ?, ?)", SEED_TEMPLATES
            )
        # Secret used in the calendar-feed URLs the iPhones subscribe to.
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('feed_token', ?)", (secrets.token_urlsafe(24),)
        )


def seed_chores(conn, kid_id: int) -> None:
    """A new kid starts with a few everyday chores, a bedtime routine and homework (all changed in Settings → Kids)."""
    conn.executemany("INSERT INTO chores (person_id, title, school_days, sort) VALUES (?, ?, ?, ?)",
                     [(kid_id, title, school_only, i) for i, (title, school_only) in enumerate(SEED_CHORES)])
    seed_routines(conn, kid_id)


def seed_routines(conn, kid_id: int) -> None:
    conn.executemany("INSERT INTO chores (person_id, title, school_days, sort, routine, at) VALUES (?, ?, ?, ?, 'bedtime', ?)",
                     [(kid_id, title, 1, 100 + i, at) for i, (at, title) in enumerate(SEED_BEDTIME)]
                     + [(kid_id, title, 2, 110 + i, at) for i, (at, title) in enumerate(SEED_BEDTIME_WEEKEND)])
    conn.executemany("INSERT INTO chores (person_id, title, school_days, sort, routine) VALUES (?, ?, ?, ?, 'homework')",
                     [(kid_id, title, days, 50 + i) for i, (title, days) in enumerate(SEED_HOMEWORK)])


def is_set_up(conn) -> bool:
    return conn.execute("SELECT 1 FROM people LIMIT 1").fetchone() is not None


def rows(cursor) -> list[dict]:
    return [dict(r) for r in cursor.fetchall()]


def get_setting(conn, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default
