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

## Next (in order)
| # | Feature | Why | Notes |
|---|---|---|---|
| 12 | Share card | Tell friends "tonight's a 78" | Web Share API, image drawn on canvas |

## Later / needs more than a static site
- **Alerts** ("tonight looks great") – needs a server and push notifications.
- **Elevation-aware cloud layers** (hypothesis H1 in the data repo) – model change, needs evidence first.
- **Native app store release** – see the roadmap discussion; Expo rebuild.
- **Photo-based auto-rating** – vision model on user photos; needs an API key and privacy design.
- **Community ratings** – needs accounts and a backend.
