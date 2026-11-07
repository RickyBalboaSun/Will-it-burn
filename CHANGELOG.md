# App changelog

## 2026-11-07 – v2
- **7-day outlook**: scores for the next seven sunsets (or sunrises), with the best evening marked. Tap a day to see its details.
- **Sunrise mode**: same model, facing east.
- **When to watch**: golden hour, sunset, the best-colour window and when the afterglow fades, plus which way to face.
- Code split into `js/model.js` (scoring, tested against the Python model on 400 cases) and `js/app.js` (screens).
- Automated browser tests on a simulated phone (`tests/smoke.py`).

## 2026-11-06 – v1
- One-screen score for the next sunset at your location or a searched place.
- Location panel with coordinates, GPS accuracy and map link.
