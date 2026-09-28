"""Reads emails from the kids' teachers (Outlook .msg, .eml, a PDF, a photo or pasted text) and suggests what to
add to the planner: no-school days, special days, "Day N" numbers, a kid's gym/music days, to-dos, the teacher.

Nothing is added here. My page → Kids shows the suggestions, and the adult ticks what to keep (main.py applies them).
The files are kept in DATA_DIR/mail/<id>/ so they can be looked at again.
"""
import email
import email.policy
import hashlib
import io
import os
import re
import shutil
import struct
import subprocess
import tempfile
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from email.utils import parseaddr

import olefile
import pypdf

MONTHS = {m: i for i, names in enumerate([
    ("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"), ("may",), ("jun", "june"),
    ("jul", "july"), ("aug", "august"), ("sep", "sept", "september"), ("oct", "october"), ("nov", "november"),
    ("dec", "december")], start=1) for m in names}
MONTH_RE = "|".join(sorted(MONTHS, key=len, reverse=True))
WEEKDAY_RE = r"(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?"
# "Tuesday Sept 29 - Orange shirt day", "Oct. 8 - PL day, no school", "- Sept. 30: Truth & Reconciliation"
DATE_LINE = re.compile(rf"^\W*(?:{WEEKDAY_RE}\.?,?\s+)?(?P<mon>{MONTH_RE})\.?\s+(?P<day>\d{{1,2}})(?:st|nd|rd|th)?\b\s*[-–—:,]?\s*(?P<rest>.*)$", re.I)
CLOSED = re.compile(r"no school|pd day|pl day|professional (?:development|learning)|school (?:is )?closed|holiday", re.I)
TODO = re.compile(r"^\W*(?:please\s+)?(sign|send|bring|return|remember|complete|fill|pack|wear)\b.{8,}", re.I)
SPECIALS = [("buddy reading", "📖 Buddy Reading"), ("library", "📚 Library"), ("gym", "👟 Gym"), ("music", "🎵 Music"),
            ("art", "🎨 Art"), ("french", "🇫🇷 French"), ("drama", "🎭 Drama"), ("computer", "💻 Computers")]
PHOTO = (".jpg", ".jpeg", ".png", ".gif", ".heic", ".webp")
# School payment and permission-form sites; a line naming one always becomes a ticked 💳 to-do.
PAYMENT = re.compile(r"\b(?:rycor|school ?cash(?: online)?|schoolcashonline|myschoolbucks|parentpay|payschools|kevgroup|schoolpay|school ?money)\b", re.I)


def is_payment(text: str) -> bool:
    return bool(PAYMENT.search(text or ""))


# ---------------------------------------------------------------- reading the file

def read(name: str, data: bytes) -> dict:
    """-> {sender, sender_email, subject, sent (ISO or ""), body, attachments: [(name, bytes)]}"""
    low = name.lower()
    if low.endswith(".msg"):
        return _read_msg(data)
    if low.endswith(".eml"):
        return _read_eml(data)
    out = {"sender": "", "sender_email": "", "subject": name.rsplit(".", 1)[0], "sent": "", "body": "", "attachments": [(name, data)]}
    if low.endswith((".txt", ".text")):
        out.update(body=data.decode("utf-8", "replace"), attachments=[])
    elif not low.endswith((".pdf", *PHOTO)):
        raise ValueError("send an Outlook .msg, an .eml, a PDF, a photo or a text file")
    return out


def _read_msg(data: bytes) -> dict:
    """An Outlook .msg is an OLE file: each property is a stream named __substg1.0_<tag><type>."""
    ole = olefile.OleFileIO(io.BytesIO(data))

    def text(tag: str, prefix: str = "") -> str:
        for kind, enc in (("001F", "utf-16-le"), ("001E", "cp1252")):
            path = f"{prefix}__substg1.0_{tag}{kind}"
            if ole.exists(path):
                return ole.openstream(path).read().decode(enc, "replace").rstrip("\x00")
        return ""

    sent = ""
    try:  # PR_CLIENT_SUBMIT_TIME (0x0039, a FILETIME) from the top-level property stream
        props = ole.openstream("__properties_version1.0").read()
        for off in range(32, len(props) - 15, 16):
            tag, = struct.unpack_from("<I", props, off)
            if tag == 0x00390040:
                ft, = struct.unpack_from("<Q", props, off + 8)
                sent = (datetime(1601, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=ft // 10)).isoformat()
                break
    except Exception:
        pass

    attachments = []
    for entry in ole.listdir(streams=False, storages=True):
        if len(entry) == 1 and entry[0].startswith("__attach_version1.0_"):
            prefix = entry[0] + "/"
            fname = text("3707", prefix) or text("3704", prefix) or "attachment"
            if ole.exists(prefix + "__substg1.0_37010102"):
                attachments.append((fname, ole.openstream(prefix + "__substg1.0_37010102").read()))
    email_addr = text("5D01") or text("0C1F") or text("0065")
    return {"sender": text("0C1A") or text("0042"), "sender_email": email_addr if "@" in email_addr else "",
            "subject": text("0037"), "sent": sent, "body": text("1000"), "attachments": attachments}


def _read_eml(data: bytes) -> dict:
    msg = email.message_from_bytes(data, policy=email.policy.default)
    name, addr = parseaddr(str(msg.get("From", "")))
    body_part = msg.get_body(preferencelist=("plain", "html"))
    body = body_part.get_content() if body_part else ""
    if body_part is not None and body_part.get_content_type() == "text/html":
        body = re.sub(r"<[^>]+>", " ", body)
    try:
        sent = email.utils.parsedate_to_datetime(msg["Date"]).isoformat() if msg["Date"] else ""
    except Exception:
        sent = ""
    atts = [(p.get_filename() or "attachment", p.get_payload(decode=True) or b"") for p in msg.iter_attachments()]
    return {"sender": name, "sender_email": addr, "subject": str(msg.get("Subject", "")), "sent": sent, "body": body, "attachments": atts}


def pdf_text(data: bytes) -> str:
    try:
        return "\n".join(p.extract_text() or "" for p in pypdf.PdfReader(io.BytesIO(data)).pages)
    except Exception:
        return ""


# ---------------------------------------------------------------- OCR, for photos and scans with no text
# A PDF that already has text (typed, or OCR'd in Foxit) is read as it is. Only a photo, or a scan with no text
# layer, goes through Tesseract here (installed in the Docker image; skipped if it isn't there).

_ocr_cache: dict[str, str] = {}
OCR_PAGES = 6


def ocr_available() -> bool:
    return bool(shutil.which("tesseract"))


def _tesseract(image_path: str, *extra: str) -> str:
    r = subprocess.run(["tesseract", image_path, "stdout", "--psm", "3", "-l", "eng", *extra],
                       capture_output=True, text=True, timeout=120)
    return r.stdout


def _calendar_by_columns(image_path: str) -> str | None:
    """OCR reads a calendar grid in a jumbled order, so rebuild it column by column. Each cell's date number sits
    at the cell's top-left, so those numbers line up into the columns (the weekday headings are often too pale to
    read). Each column is then read top to bottom: "1 Day 3 Gym Terry Fox Walk 8 Day 1 PD Day - No School ...".
    None if it doesn't look like a grid."""
    rows = [l.split("\t") for l in _tesseract(image_path, "tsv").splitlines()[1:]]
    words = [{"left": int(r[6]), "top": int(r[7]), "h": int(r[9]), "t": r[11].strip()}
             for r in rows if len(r) == 12 and r[11].strip() and r[10] != "-1"]
    nums = sorted((w for w in words if re.fullmatch(r"\d{1,2}", w["t"]) and 1 <= int(w["t"]) <= 31), key=lambda w: w["left"])
    if len(nums) < 10:
        return None
    width = max(w["left"] for w in words) - min(w["left"] for w in words) or 1
    clusters: list[list[dict]] = [[nums[0]]]
    for w in nums[1:]:
        if w["left"] - clusters[-1][-1]["left"] > width / 20:
            clusters.append([])
        clusters[-1].append(w)
    clusters = [c for c in clusters if len(c) >= 2]
    if not 5 <= len(clusters) <= 7:
        return None
    pad = min(w["h"] for w in nums)
    edges = [min(w["left"] for w in c) - pad for c in clusters]
    top = min(w["top"] for w in nums) - pad
    cols: list[list[dict]] = [[] for _ in edges]
    for w in words:
        if w["top"] >= top:
            cols[max(0, sum(w["left"] >= e for e in edges) - 1)].append(w)
    out = []
    for col in cols:
        col.sort(key=lambda w: (w["top"], w["left"]))
        lines, cur, cur_top = [], [], None
        for w in col:
            if cur and abs(w["top"] - cur_top) > max(w["h"], 8) * 0.6:
                lines.append(" ".join(x["t"] for x in sorted(cur, key=lambda x: x["left"])))
                cur = []
            if not cur:
                cur_top = w["top"]
            cur.append(w)
        if cur:
            lines.append(" ".join(x["t"] for x in sorted(cur, key=lambda x: x["left"])))
        out.append("\n".join(lines))
    return "\n".join(out)


def _ocr_page(path: str) -> str:
    text = _tesseract(path)
    if _looks_like_calendar(fix_ocr(text)):
        return _calendar_by_columns(path) or text
    return text


def ocr(name: str, data: bytes) -> str:
    """The text in a photo or a scanned PDF, or "" when there's no OCR here."""
    if not ocr_available():
        return ""
    key = hashlib.sha1(data).hexdigest()
    if key in _ocr_cache:
        return _ocr_cache[key]
    text = ""
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in" + os.path.splitext(name.lower())[1])
        with open(src, "wb") as f:
            f.write(data)
        try:
            if name.lower().endswith(".pdf"):
                if shutil.which("pdftoppm"):
                    subprocess.run(["pdftoppm", "-r", "250", "-png", "-l", str(OCR_PAGES), src, os.path.join(tmp, "page")],
                                   capture_output=True, timeout=180)
                    text = "\n".join(_ocr_page(os.path.join(tmp, p)) for p in sorted(os.listdir(tmp)) if p.startswith("page"))
            else:
                text = _ocr_page(src)
        except (subprocess.SubprocessError, OSError):
            text = ""
    _ocr_cache[key] = text
    return text


# Letters OCR often reads in place of digits, inside dates and "Day N" only.
_DIGITS = str.maketrans({"l": "1", "I": "1", "i": "1", "|": "1", "!": "1", "O": "0", "o": "0", "S": "5", "s": "5",
                         "Z": "2", "z": "2", "B": "8", "g": "9"})


def fix_ocr(text: str) -> str:
    """"Day l" -> "Day 1", "Oct 1O" -> "Oct 10", "0ct" -> "Oct". Typed text passes through unchanged."""
    def digits(tok: str, lone_letter: bool) -> str | None:
        fixed = tok.translate(_DIGITS)
        return fixed if fixed.isdigit() and (any(c.isdigit() for c in tok) or lone_letter and len(tok) == 1) else None

    text = re.sub(r"\b0ct\b", "Oct", text)
    # "Day l" is always a misread 1; after a month a real digit is needed too, so "May I remind you" stays.
    text = re.sub(r"\b(Day)\s*([0-9lIi|!OoSsZzBg]{1,2})\b",
                  lambda m: f"{m[1]} {digits(m[2], True) or m[2]}", text)
    text = re.sub(rf"\b({MONTH_RE})(\.?\s+)([0-9lIi|!OoSsZzBg]{{1,2}})(?=\b|st|nd|rd|th)",
                  lambda m: f"{m[1]}{m[2]}{digits(m[3], False) or m[3]}", text, flags=re.I)
    return text


# ---------------------------------------------------------------- what's in it

def _year(month: int, day: int, near: date) -> date | None:
    best = None
    for y in (near.year - 1, near.year, near.year + 1):
        try:
            d = date(y, month, day)
        except ValueError:
            continue
        if best is None or abs((d - near).days) < abs((best - near).days):
            best = d
    return best


def _clean(title: str) -> str:
    title = re.sub(r"\s+", " ", title).strip(" -–—:,.;")
    return title[:1].upper() + title[1:] if title else ""


def suggestions(mail: dict, near: date) -> list[dict]:
    """Things to add: {kind: closed|event|day|task|specials|teacher, date?, title, day_number?, specials?, checked}."""
    items: list[dict] = []
    seen: set[tuple] = set()

    from_ocr = False

    def add(item: dict) -> None:
        key = (item["kind"], item.get("date"), item.get("title", "").lower()[:40], item.get("day_number"))
        if key not in seen:
            seen.add(key)
            items.append({"checked": True, **item, **({"ocr": True} if from_ocr else {})})

    texts = [(mail["body"], False)]
    for name, data in mail["attachments"]:
        low = name.lower()
        if low.endswith(".pdf"):
            t, was_ocr = pdf_text(data), False
            if len(t.strip()) < 40:  # a scan with no text layer
                t, was_ocr = ocr(name, data), True
        elif low.endswith(PHOTO):
            t, was_ocr = ocr(name, data), True
        else:
            continue
        t = fix_ocr(t)
        if _looks_like_calendar(t):
            from_ocr = was_ocr
            for item in _calendar(t, name, near):
                add(item)
            from_ocr = False
        else:
            texts.append((t, was_ocr))

    for text, from_ocr in texts:
        for line in _joined_lines(text):
            if len(line) > 240:
                continue
            m = DATE_LINE.match(line)
            if m:
                d = _year(MONTHS[m["mon"].lower().rstrip(".")], int(m["day"]), near)
                title = _clean(m["rest"])
                if d and title and PAYMENT.search(line):  # a payment or form due online, on that date
                    add({"kind": "task", "date": d.isoformat(), "title": f"💳 {title}"})
                elif d and title:
                    kind = "closed" if CLOSED.search(title) else "event"
                    add({"kind": kind, "date": d.isoformat(), "title": title})
            elif (TODO.match(line) or PAYMENT.search(line)) and not line.lower().startswith(("please see", "please let me know")):
                due = re.search(rf"\b(?:by|before|on)\s+(?:{WEEKDAY_RE},?\s+)?({MONTH_RE})\.?\s+(\d{{1,2}})\b", line, re.I)
                d = _year(MONTHS[due[1].lower()], int(due[2]), near) if due else None
                pay = bool(PAYMENT.search(line))  # school payments and permission forms: always worth a to-do
                add({"kind": "task", "title": ("💳 " if pay else "") + _clean(line.lstrip("-•* ")), "checked": pay,
                     **({"date": d.isoformat()} if d else {})})
    if mail.get("sender"):
        add({"kind": "teacher", "title": _teacher_name(mail["sender"]), "email": mail.get("sender_email", "")})
    return items


def _joined_lines(text: str) -> list[str]:
    """Puts wrapped lines back together ("Sept. 30 - Truth & Reconciliation" + "Day, no school"). A new item starts
    after a blank line, and at a line that starts with a date, a bullet or a to-do word."""
    out: list[str] = []
    joinable = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            joinable = False
            continue
        starts = DATE_LINE.match(line) or TODO.match(line) or line[:1] in "-•*–"
        if joinable and not starts and len(out[-1]) < 200:
            out[-1] = f"{out[-1]} {line}"
        else:
            out.append(line)
            joinable = True
    return out


def _teacher_name(sender: str) -> str:
    """ "Jane Smith" -> "Ms. Smith" is a guess the adult can change in the preview."""
    parts = sender.replace(",", " ").split()
    return f"Ms. {parts[-1]}" if len(parts) >= 2 else sender


def _looks_like_calendar(text: str) -> bool:
    return len(re.findall(r"\bDay\s*[1-9]\b", text)) >= 5


def _calendar(text: str, filename: str, near: date) -> list[dict]:
    """A class calendar ("8 Day 1 PD Day - No School ... 9 Day 2 Buddy Reading"): the Day number of each school
    day, the kid's specials for each Day, and anything else written in a cell."""
    month = None
    for m in re.finditer(rf"\b({MONTH_RE})\b", f"{filename} {text}", re.I):
        if len(m[1]) > 3:  # a full name like OCTOBER, not "Mar" inside a word
            month = MONTHS[m[1].lower()]
            break
    if not month:
        return []
    cells = list(re.finditer(r"(?<![\d:])([1-3]?\d)\s+Day\s*([1-9])\b", text))
    out, by_day = [], {}
    for i, c in enumerate(cells):
        d = _year(month, int(c[1]), near)
        if not d:
            continue
        n = int(c[2])
        out.append({"kind": "day", "date": d.isoformat(), "day_number": n, "title": f"Day {n}"})
        rest = text[c.end(): cells[i + 1].start() if i + 1 < len(cells) else len(text)]
        rest = re.split(r"\b[A-Z]{6,}\b", rest)[0]             # the big month title at the bottom
        # A bare number starts the next cell: a weekend, or a day off with no Day number ("12 Happy Thanksgiving!").
        parts = re.split(r"(?<!\S)([1-3]?\d)(?!\S)", rest)
        rest = parts[0]
        for num, cell in zip(parts[1::2], parts[2::2]):
            other = _year(month, int(num), near)
            words = _clean(cell)
            if other and len(words) >= 4:
                out.append({"kind": "closed" if CLOSED.search(words) else "event", "date": other.isoformat(), "title": words})
        found = []
        for key, label in SPECIALS:
            if re.search(rf"\b{key}\b", rest, re.I):
                found.append(label)
                rest = re.sub(rf"\b{key}\b", " ", rest, flags=re.I)
        if found:
            by_day.setdefault(n, Counter())[" · ".join(sorted(found, key=[l for _, l in SPECIALS].index))] += 1
        leftover = _clean(re.sub(r"\s*&\s*", " ", re.sub(r"\s+", " ", rest)))
        if len(leftover) >= 4:
            out.append({"kind": "closed" if CLOSED.search(leftover) else "event", "date": d.isoformat(), "title": leftover})
    if by_day:
        out.append({"kind": "specials", "title": "Gym, music and library days",
                    "specials": {str(n): c.most_common(1)[0][0] for n, c in sorted(by_day.items())}})
    return out
