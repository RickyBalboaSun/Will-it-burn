# App changelog




## 4.5 – 8 Nov 2026
- **Model 1.3.0 (provisional):** a clean clear sky now starts at 50, not 25, and keeps the "Clear: simple glow" verdict up to 74. Three of three clear-ish skies were rated far above the forecast. To be rechecked at about 15 ratings.
- **One-tap rating:** Dull, Some colour, Good, Great or On fire. Exact score, note and photo are optional under "Add detail".
- **Ratings shared anonymously** to Netlify Forms (rating, forecast inputs, time, area rounded to ~1 km). Off switch in More. Unsent ratings retry on the next visit.
- **Nudges:** a "Rate it" banner at the top of Today after the event; "Add to calendar" also adds a short "Rate the sunset" reminder afterwards.
- **Viewpoints near you** (Spots): named viewpoints, beaches, cliffs and peaks from OpenStreetMap (Overpass), scored for the same event, ranked with a terrain check of the view towards the sun, with directions. Falls back to the old area scan where nothing is mapped.
- **Log tab removed** from the bar. Ratings, past-date checks and logging settings are in a hidden Developer view: tap the model version in the footer five times.

## 4.4 – 8 Nov 2026
- Renamed to **Sunscore: Sunrise & Sunset** ("Will it burn?" stays as the tagline). New app icon and mark.
- The main tab is now **Today** (it covers sunrises too), and rating has moved to the bottom of it.
- GitHub logging is now off unless a repository is set in More, so testers never post to a private repo. "Copy for Claude" is the main way to send a rating, from the rating card or any Log entry.

## 4.3.2 – 7 Nov 2026
- Maps work again: switched to OpenStreetMap tiles (CARTO started requiring an API key).
- Every Log entry now has its own "Log on GitHub" button, marked once sent; clearer guidance on where rating happens.
- Nearby scan no longer calls a poor spot "good" when every spot scores the same.

## 2026-11-07 – v4.3.1
- Terrain check is safer at cliff-edge viewpoints: terrain cells are ~90 m across, so you're treated as at least as high as the ground 150 m towards the sun, and nothing closer than 300 m counts as a ridge. The note now says trees and buildings aren't included.

## 2026-11-07 – v4.3
- **Terrain check**: the app samples the ground height along the sun's direction (up to 80 km) and works out the real horizon, allowing for the Earth's curve. If hills or ridges are in the way it says so (in the location details), adds "Sun goes behind the hills" to When to watch, and draws the ridge in the window view. The nearby scan notes which places have hills towards the sun and which have an open horizon.

## 2026-11-07 – v4.2
- **Log it on GitHub**: after rating, one tap opens a ready-made issue in your data repository; attach the photo and submit. A GitHub job adds it to the log, saves the photo, replies with the entry number and closes the issue. (Repository set in More → Logging.)
- **On-location check**: when you rate, the app notes how far you are from the spot and how long after sunset, and marks the entry "✓ on location" when you're there.
- **Photo check**: add your photo when rating and the app reads its date and GPS on the phone (nothing is uploaded), e.g. "photo taken 17:31 (11 min after sunset), 9 m from the spot". Many phones strip this when sharing; the app says so when it's missing.

## 2026-11-07 – v4.1
- **New layout**: Tonight · Spots · Log · More tabs; the main screen keeps only the answer, the week, what to look for and when to watch.
- **Window view** (the visual predictor): a cartoon of the view facing the sun, drawn from the forecast (cloud in each layer, the light path, the sun's real height), with a time slider from 30 minutes before to 30 after.
- **Side slice** at the top of "Why this score": the clouds between you and the sun at 0–250 km, and whether the sunbeam gets through.
- **Mini sky stacks** in the week strip and the Spots list.
- One-line location (tap for details, elevation and notes); bigger rating buttons; stronger text contrast; the background is now a plain gradient (the pictures carry the clouds).

## 2026-11-07 – v4.0 (model 1.2.0)
- **The score is now the median of three weather models** (European ECMWF, American GFS, German ICON), each scored separately. The confidence range always includes the headline score, and "Why this score" says which model the breakdown comes from. One forecast request instead of two.
- **Honest labels**: a clear sky with nothing to light up now says "Clear: simple glow" instead of "Some colour possible".
- **Scale key** under the score: under 25 poor · 25–49 some colour · 50–74 worth going out · 75+ fire.
- Alerts, the nearby scan, saved spots and past dates all use the same three-model method.

## 2026-11-07 – v3.9
- **What's new** card, shown once after an update, so returning users can find new features.

## 2026-11-07 – v3.8
- **Your spots** on the main screen: once you've saved spots, each one's next score appears in a strip, so you can compare your regular places at a glance. Tap one to open it.

## 2026-11-07 – v3.7
- Tidier place names ("Swansea, Wales, United Kingdom" instead of the full official names), a shorter high-viewpoint note, and no more stray line breaks in the elevation.
- Verified against the real Open-Meteo API and the live site from GitHub's servers: main forecast, all three confidence models, past dates back to 2024, the 85-location nearby scan and place search all work as the app expects.

## 2026-11-07 – v3.6
- Nearby scan results now show real place names ("25 km north-west · near Panguitch").

## 2026-11-07 – v3.5
- **Cloud through the evening**: a chart in "Why this score" showing how mid, high and low cloud overhead, and low cloud along the light path, are forecast to change from 4 hours before sunset to 2 hours after. You can see whether cloud is clearing or building at the key moment.
- Cards now blur the sky behind them, so text is easier to read.

## 2026-11-07 – v3.4
- **How it works**: a diagram and plain-English explanation of the score, for anyone you share the app with (link at the bottom of the page).
- Accessibility: score changes are announced to screen readers; visible focus outlines for keyboard users.

## 2026-11-07 – v3.3
- **Elevation** shown in the location panel, with a caveat at high viewpoints (above 1,500 m): forecasts call cloud up to about 1.8 km above the ground "low", which the model treats as blocking, but from a rim or summit it can light up. (From the Bryce sunset, which scored 9 but rated 7/10.)

## 2026-11-07 – v3.2
- **Alerts** (Chrome on Android, with the app installed): get a notification when a sunset (or sunrise) at your chosen place is forecast to score 50, 60 or 75+. Your phone checks in the background a few times a day; no account or server. Sunset alerts arrive during the day; sunrise alerts the evening before. Once per event, never at night. "Send a test alert" checks it works.
- On phones that can't do background checks, the app says so and points to Add to calendar.

## 2026-11-07 – v3.1
- **What to look for**: tips matched to the forecast. Underlit clouds and when they peak, high wisps that stay lit longest, the Belt of Venus opposite the sun on clear evenings, sunbeams through broken cloud, rainbow chances with showers, a red sun disc in haze, and watching for a gap when the horizon is cloudy.

## 2026-11-07 – v3.0
- **Sky preview**: the background is drawn from the forecast. Wispy high cloud near the top, rafts of mid-level cloud, dark low cloud, and a cloud bank on the horizon if the light path is blocked. Clouds glow pink and orange when the sun can reach them and stay grey when it can't, so you can read the forecast at a glance.

## 2026-11-07 – v2.9
- **Opens instantly**: a forecast less than 15 minutes old is shown straight away; an older one is shown while the new one loads.
- **"Updated 5 min ago · Refresh"** under the score.
- Clearer message if the forecast service is busy.

## 2026-11-07 – v2.8
- **Times follow your phone's clock setting**: 24-hour (17:20) or 12-hour (5:20pm).
- **Add to calendar**: saves the viewing window (golden hour to afterglow) as a calendar event, with the score and a reminder 30 minutes before.
- **Which way?**: a live compass arrow pointing to where the sun will set or rise, using your phone's compass.

## 2026-11-07 – v2.7
- **Share this forecast**: makes a picture card (score, verdict, place, time) and opens your phone's share menu, ready for WhatsApp, Messages and so on. Phones without a share menu copy the text instead.

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
