# App changelog

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
