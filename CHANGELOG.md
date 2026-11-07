# App changelog

## 2026-11-07 – v2.6
- **Check a past date**: pick any date since 2022 and see what the app would have predicted, using Open-Meteo's archived forecasts. You can rate it too, so old sunset photos can go into the log.

## 2026-11-07 – v2.5
- **Find a better spot nearby**: scores 17 places in two rings around you (25 or 50 km) for the same sunset, shows them on a map, and says whether a short trip is worth it. Tap a place to switch to it.
- **Saved spots**: save your favourite viewpoints. They're listed on the place screen with their next score, so you can compare them at a glance.

## 2026-11-07 – v2.4
- **Light path map**: a map of exactly which sky is being judged. Your spot, the line towards the sun, and the five sample points coloured clear, some cloud or cloudy. Tap a point for its low, mid and high cloud. It only loads when opened, to save data.

## 2026-11-07 – v2.3
- **Forecast confidence**: the same sky is scored with three independent weather models (European ECMWF, American GFS, German ICON). If they agree, confidence is High; if they disagree, the app says to treat the score as a rough guess. Tap the pill for each model's score.

## 2026-11-07 – v2.2
- **Rate a sunset**: after sunset (or sunrise) a card asks how it was, with the 0–10 scale built in. Ratings and notes are saved on your phone.
- **Your sunset log**: every rating, with the app's prediction alongside.
- **Copy for Claude**: one tap copies the entry in the format the data log uses. Paste it to Claude with your photo.

## 2026-11-07 – v2.1
- **Installable**: add it to your home screen and it opens full-screen like an app, with its own sunset icon.
- **Works offline**: the app opens without signal, and shows the last forecast for that place (marked "Offline") if a new one can't be loaded. Useful at remote viewpoints.

## 2026-11-07 – v2
- **7-day outlook**: scores for the next seven sunsets (or sunrises), with the best evening marked. Tap a day to see its details.
- **Sunrise mode**: same model, facing east.
- **When to watch**: golden hour, sunset, the best-colour window and when the afterglow fades, plus which way to face.
- Code split into `js/model.js` (scoring, tested against the Python model on 400 cases) and `js/app.js` (screens).
- Automated browser tests on a simulated phone (`tests/smoke.py`).

## 2026-11-06 – v1
- One-screen score for the next sunset at your location or a searched place.
- Location panel with coordinates, GPS accuracy and map link.
