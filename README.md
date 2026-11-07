# Will It Burn?

Predicts how good tonight's sunset (or tomorrow's sunrise) will be, as a score from 0 to 100.

**Live app:** https://rickybalboasun.github.io/Will-it-burn/ (install it from your browser's menu)

## How it scores
It samples Open-Meteo's cloud forecast overhead (the "canvas" that lights up) and 75–250 km towards the sun (the "light path" that must be clear), then multiplies six factors: canvas, light path, low cloud, overcast, rain and air clarity. Model version is shown in the footer; see `CHANGELOG.md`.

## Features
- Score for the next sunset or sunrise, 7-day outlook with the best day marked
- Sky preview drawn from the forecast; "what to look for" tips
- When to watch (golden hour, best-colour window, afterglow), compass, add to calendar
- Forecast confidence from ECMWF, GFS and ICON
- Light path map; find a better spot nearby (17-place scan); saved spots
- Rate a sunset, local log, copy for Claude; check and rate past dates
- Background alerts (Chrome on Android, installed app); share card; offline

## Development
- `js/model.js` – scoring and astronomy (pure functions), kept identical to the Python model in the private data repo via `tests/parity-fixtures.json`
- `js/app.js`, `index.html`, `css/app.css` – the app; `sw.js` – module service worker (offline + alerts), `sw-classic.js` fallback
- Tests: `node --test tests/*.test.mjs` and `python3 tests/smoke.py` (Playwright, mocked APIs, simulated phone). Run on every push/PR by `.github/workflows/test.yml`.
- `BACKLOG.md`, `CHANGELOG.md`

Forecast data: [Open-Meteo](https://open-meteo.com) (CC BY 4.0, non-commercial use). Maps: © OpenStreetMap contributors © CARTO. Place names: BigDataCloud.
