# Changelog

## v1.2.0 (2026-09-28)

- What to wear from the forecast (coat, snow gear, raincoat, wind, sun) on the kids' pages, in their 7 am
  notification, on My page and in the 8 pm check
- Kids' money: a weekly allowance (optionally only if they earned enough stars), cashing in stars, gifts and
  spending, with the balance on their page
- House page (`/house`): car and house upkeep with reminders (oil change, tires, filters, alarms, gutters…),
  contacts with tap-to-call, and a printable sitter sheet (numbers, bedtimes, medicine, notes)
- Emergency numbers for your country are added to Contacts (911, 999, 112, 000…)

## v1.1.0 (2026-09-28)

- Bedtime routine (school nights and weekends) and homework & reading checklists, with phone reminders
- Rewards: the kids save their stars for rewards the adults choose
- Teacher emails: upload or paste them, review what was found (no-school days, events, Day numbers,
  gym/music/library days, to-dos, school payments, the teacher) and add the ticked items; OCR for scans
- Meals: supper plan, grocery list, what's in the house, recipes, cook with what we have, flyer deals
- Medicine: cabinet, reminders, dose spacing and daily limits, puffers, symptoms, doctor report (print and CSV)
- Adults' notifications: the 8 pm check, medicine given, homelab alerts; each adult picks their topics
- Admin page with an overview; choose which tabs each adult's page shows
- Nightly database backups (kept 14 days), with download and "back up now"
- The planner image now includes Tesseract and Poppler for reading scans (a larger image)
- Upgrading from v1.0.0: existing kids get the default bedtime and homework routines once

## v1.0.0 (2026-09-27)

First public release.

- First-run setup screen (family, town, holidays, family PIN), home network only
- Wall display, phone app, kids' pages, My page (`/me`) with an optional Homelab tab
- Tasks, appointments, lunch planner, work shifts (tap or type), bills, chores
- Google Calendar: read with iCal links, and copy appointments back with a service account
- Calendar feeds for shifts, tasks, and bill and reminder alerts
- Family PIN, a PIN for each person, and Face ID / fingerprint passkeys; kid and phone-only sign-ins
- Holidays for about 250 countries (the `holidays` library), optional Day 1–N school rotation
- One-line Proxmox installer, a Debian/Ubuntu installer, Docker Compose profiles
  (tunnel, https, homelab), a demo family (`python -m app.demo`)
