# Backlog

How features are prioritised: **value to someone deciding whether to go and watch tonight** × **confidence it works without a server or API keys** ÷ effort. Everything ships behind automated tests (Python/JS model parity + browser smoke tests on a simulated phone).

## Done
| # | Feature | Why |
|---|---|---|
| 1 | One-screen score with location check | The core answer, and proof it's the right place |
| 2 | 7-day outlook with "Best" evening | Plan ahead; no one wants to check every day |
| 3 | Sunrise mode | Same physics facing east; doubles the usefulness |
| 4 | When to watch: golden hour, best-colour window, afterglow | The best colour is often *after* sunset; people leave too early |
| 5 | Installable app + offline | Feels like a real app; works at remote viewpoints |
| 6 | Rate a sunset, log, copy for Claude | Feeds the data loop that improves the model |
| 7 | Forecast confidence from three weather models | Honest about uncertainty |
| 8 | Light path map | See exactly which sky is being judged |
| 9 | Saved spots | Compare your regular places at a glance |
| 10 | Find a better spot nearby | The best sunset within a short drive |
| 11 | Check a past date (and rate it) | Back-fill the log from old photos |
| 12 | Share card | Tell friends "tonight's a 78" |
| 13 | 24-hour clock, add to calendar, compass | Small things that make it feel finished |
| 14 | Instant start (forecast cache), last updated + refresh | Speed and fewer API calls |
| 15 | Sky preview drawn from the forecast | See the prediction before reading the number |
| 16 | What to look for | Turns a score into something to go and see |
| 17 | Background alerts (Android, installed app) | People act on a notification, not on an app they have to open |
| 18 | Elevation + high-viewpoint caveat | Honest about a known weakness (H1) |
| 19 | How it works explainer | For people you share it with |
| 20 | Cloud timeline chart | Is it clearing or building at sunset? |
| 21 | Nearby place names, tidy place names | Real names, not just distances |
| 22 | Your spots on the main screen | Compare regular places without switching |

## Next (in order)
| # | Feature | Why | Notes |
|---|---|---|---|

## Later / needs more than a static site
- **Alerts on iPhone** – iOS doesn't allow background checks for web apps; needs a server sending push messages, or the native app.
- **Elevation-aware cloud layers** (hypothesis H1 in the data repo) – model change, needs evidence first.
- **Native app store release** – see the roadmap discussion; Expo rebuild.
- **Photo-based auto-rating** – vision model on user photos; needs an API key and privacy design.
- **Community ratings** – needs accounts and a backend.


## Review of 4.6 (8 Nov 2026), awaiting Robin's decision

### UI before wider testing
1. One scale everywhere: Dull 0–24 · Some colour 25–49 · Good 50–74 · Great 75–89 · On fire 90–100 (verdicts, key, rating). Key becomes a thin coloured bar with a marker.
2. Calmer top of Today: location panel collapsed to one line (place, height, ⚠); detail on tap.
3. Rate banner: "Tonight's sunset has gone — how was it?", placed under the hero, not above it.
4. Local units: miles/feet and 12-hour time from the phone's locale (US testers).
5. Leaner hero: drop the key (see 1); confidence as one small line under the verdict.
6. Week strip: day, score and one weather icon; all 7 days fit.
7. Spots: auto-run viewpoints on opening, default 25 km, one-line description.
8. Polish: logo mark in header; contrast of faint text on orange; remove duplicate "How it works"; skeleton while loading.
9. First-open welcome card.

### Features
- Live sky check: NASA GIBS satellite cloud imagery on the light path map in the last 2 hours.
- Best spot tonight: score heat map across ~100 km.
- Daily nudge: optional notification at a chosen time with tonight's score and timing.
- Plan ahead: any place and day this week.
- Comfort at sunset: temperature, wind, "bring a jacket".
- Moon and blue hour times.
- "How we did": public accuracy page.
- Friends check-in (needs Firebase).
- Community tab (Robin's idea): anonymised photos pinned on a world map. Needs photo storage, moderation, EXIF stripping and rounded locations; pairs with friends check-in.

Suggested first batch: UI 1–6 and 9 plus the daily nudge, one upload.

### Community tab: decision and mockup (8 Nov 2026)
- Storage: Firebase (Cloud Storage + Firestore + anonymous sign-in), shared with the friends check-in. Needs the Blaze plan (card), expected £0; £1 budget alert; per-person upload limits.
- Flow: rate → "Add your photo to the map?" → consent → pending → automatic check + approval queue (Developer view) → on the map. Your photos page with delete / delete all / hide all.
- Mockup: https://claude.ai/artifact/FvoVXBx66w8AUWRAZtmGon
- Built in 4.7 (8 Nov, overnight): Community tab, add-photo flow, your photos, moderation queue; off until js/firebase-config.js is filled. Setup guide: https://claude.ai/artifact/DVL7D486fb2Qv2nRs8MXnf
- Not in v1 (later): automatic image screening (needs Cloud Functions + Vision), hide-all switch, clustering when many pins, App Check against abuse.

- Community speed later: once there are a few hundred photos, move thumbnails out of the photo records into their own collection so the map loads just the light records first (needs a rules re-paste). Consider defaulting the filter to "This week" while there are few photos.
- Compass (Robin, 9 Nov): the "N" on the compass doesn't point north. Drop or fix it, and make it clearer that the arrow points to the sunset (e.g. label the arrow "Sunset" / "Sunrise" with the direction, "West-south-west").
