# Will It Burn?

Predicts how good tonight's sunset (or tomorrow's sunrise) will be, as a score from 0 to 100.

**Live app:** https://rickybalboasun.github.io/Will-it-burn/

It samples Open-Meteo's cloud forecast overhead (the "canvas" that lights up) and 75–250 km towards the sun (the "light path" that has to be clear), then combines six factors: canvas, light path, low cloud, overcast, rain and air clarity.

## Development
- `js/model.js`: scoring model, kept identical to the Python model (`tests/parity-fixtures.json`).
- `js/app.js`, `index.html`, `css/app.css`: the app.
- Tests: `node --test tests/*.test.mjs` and `python3 tests/smoke.py` (needs Playwright + Chrome).
- See `BACKLOG.md` and `CHANGELOG.md`.

Forecast data: [Open-Meteo](https://open-meteo.com) (CC BY 4.0).
