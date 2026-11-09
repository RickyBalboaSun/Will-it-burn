"""Browser smoke tests with mocked APIs and a simulated phone.

Usage:  python3 tests/smoke.py [--shots DIR]
Serves the repo over HTTP, mocks Open-Meteo / geocoding / reverse geocoding,
and drives the app in headless Chrome. Exits non-zero on any failure.
"""
import json, os, sys, threading, time, functools, http.server, socketserver, argparse
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument("--shots", default=None); args, _ = ap.parse_known_args()

NOW = int(time.time())
OFFSET = -25200  # UTC-7
LOCAL_MIDNIGHT = (NOW + OFFSET) // 86400 * 86400 - OFFSET
DAILY_MID = [55, 10, 80, 30, 0, 60, 45, 20]


def forecast_body(qs):
    lats = qs["latitude"][0].split(",")
    days = int(qs.get("forecast_days", ["8"])[0])
    start = LOCAL_MIDNIGHT
    if "start_date" in qs:  # past date: use that day
        y, m, d = map(int, qs["start_date"][0].split("-"))
        import calendar
        start = calendar.timegm((y, m, d, 0, 0, 0)) - OFFSET
        days = 2
    hours = days * 24
    times = [start + h * 3600 for h in range(hours)]
    sunsets = [start + d * 86400 + 17 * 3600 + 20 * 60 for d in range(days)]
    sunrises = [start + d * 86400 + 7 * 3600 for d in range(days)]
    models = qs.get("models", [""])[0]
    out = []
    for i, lat in enumerate(lats):
        far = (i % 5) >= 2
        jitter = 0 if i < 5 else int(abs(float(lat)) * 1000) % 40 - 20   # vary batched spots
        mid = [max(0, min(100, DAILY_MID[(h // 24) % 8] + jitter)) if not far else 5 for h in range(hours)]
        base = {"cloud_cover": [min(100, m + 10) for m in mid], "cloud_cover_low": [0] * hours,
                "cloud_cover_mid": mid, "cloud_cover_high": [10] * hours, "visibility": [40000] * hours,
                "relative_humidity_2m": [60] * hours, "precipitation_probability": [0] * hours, "precipitation": [0.0] * hours}
        hourly, daily = {"time": times}, {"time": []}
        if models:   # like Open-Meteo: every hourly AND daily key suffixed per model, no plain "sunset"
            for k, mname in enumerate(models.split(",")):
                for var, vals in base.items():
                    hourly[f"{var}_{mname}"] = [min(100, v + 15 * k) if var == "cloud_cover_mid" else v for v in vals]
                daily[f"sunset_{mname}"] = sunsets; daily[f"sunrise_{mname}"] = sunrises
        else:
            hourly.update(base); daily.update(sunset=sunsets, sunrise=sunrises)
        out.append({"utc_offset_seconds": OFFSET, "elevation": 2400 if float(lat) > 37 and float(lat) < 38 else 20, "hourly": hourly, "daily": daily})
    return out if len(out) > 1 else out[0]



FAKE_BACKEND = """
(() => {
  const now = Date.now(), t = Math.floor(now / 1000) - 3600;
  const svg = c => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="15" fill="#4a2f5e"/><rect y="15" width="40" height="15" fill="' + c + '"/></svg>');
  const db = [
    { id: "p1", uid: "u-other", status: "approved", path: "photos/u-other/p1", kind: "sunset", date: "2026-11-08", t, band: "On fire", bandLo: 90, predicted: 50, place: "Near Kayenta", lat: 36.73, lon: -110.25, createdAt: now - 1500000 },
    { id: "p2", uid: "u-other", status: "approved", path: "photos/u-other/p2", kind: "sunset", date: "2026-11-08", t, band: "Good", bandLo: 50, predicted: 41, place: "Near Swansea", lat: 51.62, lon: -3.94, createdAt: now - 9000000 },
    { id: "p3", uid: "u-other", status: "approved", path: "photos/u-other/p3", kind: "sunrise", date: "2026-11-08", t, band: "Great", bandLo: 75, predicted: 60, place: "Near Lisbon", lat: 38.72, lon: -9.14, createdAt: now - 7000000 },
  ];
  window.__FAKE_DB = db; window.__FAKE_REPORTS = [];
  window.__SUNSCORE_FAKE_BACKEND = async () => ({
    uid: "u-me", isAdmin: () => true,
    async upload({ id, full, thumb, meta }) { window.__FAKE_UPLOAD = { fullSize: full.size, thumbSize: thumb.size, fullType: full.type };
      db.push({ ...meta, id, uid: "u-me", status: "pending", path: "photos/u-me/" + id, createdAt: Date.now() }); },
    async feed() { return db.filter(p => p.status === "approved").sort((a, b) => b.createdAt - a.createdAt); },
    async mine() { return db.filter(p => p.uid === "u-me"); },
    async pending() { return db.filter(p => p.status === "pending"); },
    async reports() { return window.__FAKE_REPORTS; },
    async setStatus(id, status) { db.find(p => p.id === id).status = status; },
    async remove(p) { db.splice(db.indexOf(db.find(x => x.id === p.id)), 1); },
    async report(id, reason) { window.__FAKE_REPORTS.push({ photo: id, reason }); },
    async url(p) { return svg(p.band === "On fire" ? "#f0532c" : "#ffa552"); },
  });
})();
"""

AQ_CALLS = []
NOMINATIM = [
    {"lat": "37.05", "lon": "-110.18", "name": "John Ford's Point", "type": "viewpoint", "category": "tourism"},
    {"lat": "37.02", "lon": "-110.25", "name": "Artist's Point", "type": "viewpoint", "category": "tourism"},
]


def handle(route):
    u = urlparse(route.request.url); qs = parse_qs(u.query)
    if "/v1/elevation" in u.path:
        lats = qs["latitude"][0].split(",")
        # a 200 m ridge 2 km towards the sun from the Bryce test spot
        body = {"elevation": [2400 + (200 if i == 7 else 0) for i in range(len(lats))]}
        route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(body)); return
    if "air-quality-api" in u.netloc:
        # clean desert air: aerosol optical depth 0.04 all week
        t0 = int(NOW) - 2 * 86400
        AQ_CALLS.append(u.query)
        body = {"hourly": {"time": [t0 + h * 3600 for h in range(24 * 9)], "aerosol_optical_depth": [0.04] * (24 * 9)}}
        route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(body)); return
    if "bigdatacloud" in u.netloc:
        body = {"locality": "Bryce Canyon City", "city": "Bryce Canyon City", "principalSubdivision": "Utah [US-UT]", "countryName": "United States of America (the)", "countryCode": "US"}
    elif "geocoding" in u.netloc:
        body = {"results": [{"name": "Mumbles", "latitude": 51.57, "longitude": -4.0, "admin1": "Wales", "country": "United Kingdom"}]}
    else:
        body = forecast_body(qs)
    route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(body))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/mock/forecast"):
            body = json.dumps(forecast_body(parse_qs(urlparse(self.path).query))).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body); return
        return super().do_GET()


def serve():
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


import base64
TILE = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk2PS/HgAFJQJVOyJ0rAAAAABJRU5ErkJggg==")
LEAFLET = os.environ.get("LEAFLET_DIST", "/tmp/leaflet/package/dist")
PHOTO = os.environ.get("TEST_PHOTO", "/tmp/test-photo.jpg")


def make_test_photo():
    """A JPEG with camera metadata: taken 17:31 local today (11 min after the mock sunset), a few metres from the spot."""
    try:
        from PIL import Image
    except ImportError:
        return
    im = Image.new("RGB", (320, 240), (220, 110, 90)); exif = im.getexif()
    exif.get_ifd(0x8769)[0x9003] = time.strftime("%Y:%m:%d", time.gmtime(LOCAL_MIDNIGHT - OFFSET)) + " 17:31:00"
    exif.get_ifd(0x8825).update({1: "N", 2: (37.0, 36.0, 35.2), 3: "W", 4: (112.0, 9.0, 42.0)})
    im.save(PHOTO, exif=exif)
FAILS = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: FAILS.append(msg)


def logs_count(pg):
    return pg.evaluate("(JSON.parse(localStorage.getItem('wib-log') || '[]')).length")


def main():
    make_test_photo()
    httpd = serve(); base = f"http://127.0.0.1:{httpd.server_address[1]}/"
    with sync_playwright() as p:
        chrome = os.environ.get("CHROME_PATH", "/usr/bin/google-chrome")
        b = p.chromium.launch(executable_path=chrome if os.path.exists(chrome) else None, args=["--no-sandbox"])
        errors = []
        posted = []
        overpass_data = {"elements": []}

        def overpass_route(route):
            if overpass_data.get("down"):
                route.fulfill(status=504, body="busy"); return
            route.fulfill(status=200, body=json.dumps(overpass_data), content_type="application/json")

        def form_post(route):
            if route.request.method == "POST":
                posted.append(parse_qs(route.request.post_data or ""))
                route.fulfill(status=200, body="ok")
            else:
                route.continue_()

        def open_dev(pg):
            if pg.is_hidden("#devCard"):
                for _ in range(5): pg.click("#modelVersion")
            pg.click("#devOpen"); pg.wait_for_timeout(100)

        def new_page(geo=True):
            kw = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True, locale="en-GB")
            if geo: kw.update(geolocation={"latitude": 37.6097, "longitude": -112.1617, "accuracy": 12}, permissions=["geolocation"])
            ctx = b.new_context(**kw)
            ctx.route("**/*open-meteo.com/**", handle); ctx.route("**/*bigdatacloud.net/**", handle)
            ctx.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, body="", content_type="text/css"))
            ctx.route("**/fonts.gstatic.com/**", lambda r: r.abort())
            ctx.route("**/cdnjs.cloudflare.com/ajax/libs/leaflet/**", lambda r: r.fulfill(status=200,
                path=f"{LEAFLET}/leaflet.css" if r.request.url.endswith(".css") else f"{LEAFLET}/leaflet.js",
                content_type="text/css" if r.request.url.endswith(".css") else "application/javascript"))
            ctx.route("**/tile.openstreetmap.org/**", lambda r: r.fulfill(status=200, body=TILE, content_type="image/png"))
            ctx.route(lambda u: urlparse(u).path == "/", form_post)
            ctx.route("**/api/interpreter*", overpass_route); ctx.route("**/*nominatim.openstreetmap.org/**", lambda r: r.fulfill(status=200, content_type="application/json",
                body=json.dumps(NOMINATIM if overpass_data.get("down") and "q=viewpoint" in r.request.url else [])))
            pg = ctx.new_page()
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("console", lambda m: m.type == "error" and "Failed to load resource" not in m.text and errors.append(m.text))
            return ctx, pg

        def shot(pg, name, full=False):
            if args.shots:
                os.makedirs(args.shots, exist_ok=True); pg.screenshot(path=f"{args.shots}/{name}.png", full_page=full)

        print("GPS flow")
        ctx, pg = new_page()
        pg.goto(base); pg.wait_for_selector("#result:not([hidden])", timeout=10000); pg.wait_for_timeout(800)
        check(pg.inner_text("#locName") == "Near Bryce Canyon City", "reverse-geocoded place name")
        pg.click("#locToggle")
        check(pg.inner_text("#locSub").startswith("Utah, United States\n"), "tidy region and country: " + pg.inner_text("#locSub").split("\n")[0])
        check(pg.inner_text("#score").isdigit(), "score shown")
        check("2,400 m" in pg.inner_text("#locElev") and not pg.is_hidden("#elevWarn") and not pg.is_hidden("#locFlag"), "elevation on the location line, note in details: " + pg.inner_text("#elevWarn")[:60])
        check(pg.query_selector("#scene svg") is not None and pg.query_selector("#slice svg") is not None, "window view and side slice drawn")
        pg.wait_for_function("!document.getElementById('terrainNote').hidden", timeout=8000)
        check("Hills or ridges" in pg.inner_text("#terrainNote") and "2 km away" in pg.inner_text("#terrainNote"), "terrain note: " + pg.inner_text("#terrainNote")[:90])
        check("Sun goes behind the hills" in pg.inner_text("#times"), "viewing times include when the sun goes behind the hills")
        lab0 = pg.inner_text("#sliderLabel")
        pg.eval_on_selector("#timeSlider", "e => { e.value = '-20'; e.dispatchEvent(new Event('input')); }")
        check("20 min before sunset" in pg.inner_text("#sliderLabel") and pg.inner_text("#sliderLabel") != lab0, "time slider updates the scene: " + pg.inner_text("#sliderLabel"))
        pg.eval_on_selector("#timeSlider", "e => { e.value = '10'; e.dispatchEvent(new Event('input')); }")
        check(len(pg.query_selector_all(".day .ms")) >= 6, "mini sky stacks in the week strip")
        shot(pg, "20-tonight"); shot(pg, "20-tonight-full", True)
        days = pg.query_selector_all(".day")
        check(len(days) >= 6, f"week strip has {len(days)} days")
        check(pg.inner_text("#times").count(":") >= 3, "viewing times shown")
        check(len(pg.query_selector_all(".tip")) >= 1, "look-for tips: " + " | ".join(t.inner_text().split("\n")[0] for t in pg.query_selector_all(".tip")))
        pg.wait_for_selector("#conf:not([hidden])", timeout=8000)
        check("confidence" in pg.inner_text("#conf"), "confidence pill: " + pg.inner_text("#conf"))
        import re as _re
        rng = [int(x) for x in _re.findall(r"\d+", pg.inner_text("#conf"))]
        check(min(rng) <= int(pg.inner_text("#score")) <= max(rng), f"headline {pg.inner_text('#score')} sits inside the model range {rng}")
        pg.click("#conf"); pg.wait_for_timeout(300)
        pg.wait_for_timeout(200)
        blank = pg.evaluate("(() => { const c = document.getElementById('timeline'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0; for (let i=3;i<d.length;i+=4) if (d[i]) n++; return n; })()")
        check(blank > 500, f"cloud timeline drawn ({blank} pixels)")
        check("European" in pg.inner_text("#confDetail") and "German" in pg.inner_text("#confDetail"), "per-model scores in details")
        pg.click("#mapCard summary"); pg.wait_for_selector(".leaflet-interactive", timeout=8000); pg.wait_for_timeout(400)
        check(len(pg.query_selector_all("path.leaflet-interactive")) >= 6, "map shows the light path and 5 sample points")
        pg.query_selector_all("path.leaflet-interactive")[-1].click(force=True); pg.wait_for_timeout(200)
        check("Low" in (pg.inner_text(".leaflet-popup-content") if pg.query_selector(".leaflet-popup-content") else ""), "tapping a point shows its cloud cover")
        pg.eval_on_selector("#mapCard", "e => e.scrollIntoView()"); shot(pg, "05-map")
        shot(pg, "01-home"); shot(pg, "01-home-full", True)
        first = pg.inner_text("#score")
        days[2].click(); pg.wait_for_timeout(200)
        sel = pg.query_selector_all(".day")[2]
        check("on" in (sel.get_attribute("class") or ""), "selected day highlighted")
        check(pg.inner_text("#score") == sel.query_selector(".s").inner_text(), "hero shows the selected day's score")
        print("How it works")
        pg.click("#howBtn"); pg.wait_for_timeout(200)
        check(pg.evaluate("document.getElementById('how').open"), "explainer opens")
        shot(pg, "12-how")
        pg.click("#how .how-close"); pg.wait_for_timeout(100)
        check(not pg.evaluate("document.getElementById('how').open"), "explainer closes")

        print("Calendar + compass")
        with pg.expect_download() as dl: pg.click("#calBtn")
        ics = open(dl.value.path()).read()
        check("BEGIN:VEVENT" in ics and "DTSTART:" in ics and "/100" in ics, "calendar file has the event")
        pg.context.grant_permissions(["accelerometer", "gyroscope", "magnetometer"])
        pg.click("#compassBtn"); pg.wait_for_timeout(100)
        check(not pg.is_hidden("#compassBox"), "compass shows" + ("" if not pg.is_hidden("#compassBox") else " | btn=" + pg.inner_text("#compassBtn") + " msg=" + pg.inner_text("#timesMsg")))
        pg.evaluate("""() => { const e = new Event('deviceorientationabsolute'); Object.assign(e, { absolute: true, alpha: 90 });
                         window.dispatchEvent(e); const f = new Event('deviceorientation'); Object.assign(f, { absolute: true, alpha: 90 }); window.dispatchEvent(f); }""")
        pg.wait_for_timeout(400)
        ang = pg.evaluate("getComputedStyle(document.getElementById('needle')).transform")
        txt = pg.inner_text("#compassText")
        import math
        try:
            a, bb = [float(x) for x in ang.split("(")[1].split(",")[:2]]; deg = math.degrees(math.atan2(bb, a))
        except Exception: deg = 999
        check(abs(deg - (-22)) < 3, f"needle points the way to turn ({deg:.0f}°)")
        check("Turn" in txt or "That way" in txt, "compass reacts to heading: " + txt)
        pg.eval_on_selector("#compassBox", "e => e.scrollIntoView({block:'center'})"); shot(pg, "10-compass")
        pg.click("#compassBtn")

        print("Nearby scan + saved spots")
        pg.click(".tabbar button[data-go='spots']")
        check(not pg.is_hidden("#mySpotsEmpty"), "spots tab explains how to save a spot")
        pg.click(".radius[data-r='50']"); pg.click("#scanBtn")
        pg.wait_for_selector(".near-item", timeout=10000); pg.wait_for_timeout(500)
        check(len(pg.query_selector_all(".near-item")) == 6, "nearby scan lists top 6 places")
        check("No mapped viewpoints" in pg.inner_text("#nearStatus"), "no viewpoints: falls back to the area scan: " + pg.inner_text("#nearStatus"))
        check(len(pg.query_selector_all("#nearMap path.leaflet-interactive")) == 17, "17 places on the scan map")
        pg.eval_on_selector("#nearCard", "e => e.scrollIntoView()"); shot(pg, "06-nearby")
        pg.wait_for_function("document.querySelector('.near-item[data-place]')", timeout=5000)
        check("near Bryce Canyon City" in pg.inner_text("#nearList"), "nearby places get real names")
        target = [b for b in pg.query_selector_all(".near-item") if b.get_attribute("data-name") != "Here"][0]
        tname = target.get_attribute("data-name")
        target.click(); pg.wait_for_selector("#result:not([hidden])"); pg.wait_for_timeout(300)
        check("Near Bryce Canyon City" == pg.inner_text("#locName") and tname in pg.inner_text("#locSub"), f"tapping a nearby place switches to it ({tname})")
        tname = "Near Bryce Canyon City"
        check(not pg.is_hidden("#tab-tonight"), "tapping a nearby place returns to Tonight")
        if pg.is_hidden("#locMore"): pg.click("#locToggle")
        pg.click("#saveSpot"); check("Saved" in pg.inner_text("#saveSpot"), "spot saved")
        pg.click("#placeBtn"); pg.click("#gpsBtn"); pg.wait_for_selector("#result:not([hidden])")
        pg.click(".tabbar button[data-go='spots']")
        pg.wait_for_function("document.getElementById('ms0') && /\\d/.test(document.getElementById('ms0').textContent)", timeout=8000)
        check(pg.is_hidden("#mySpotsEmpty") and pg.query_selector("#mySpots .ms") is not None, "saved spot listed with score and mini stack: " + pg.inner_text("#mySpots").replace("\n", " "))
        shot(pg, "21-spots", True)
        pg.click(".spot-item"); pg.wait_for_selector("#result:not([hidden])"); pg.wait_for_timeout(300)
        check(pg.inner_text("#locName") == "Near Bryce Canyon City" and not pg.is_hidden("#tab-tonight"), "tapping a saved spot opens it on Tonight")
        pg.click("#placeBtn"); pg.wait_for_selector("#spots:not([hidden])")
        pg.wait_for_function("document.querySelector('#spotScore0') && /\\d/.test(document.querySelector('#spotScore0').textContent)", timeout=8000)
        check(True, "saved spot listed with a score: " + pg.inner_text("#spotList").replace("\n", " "))
        shot(pg, "07-spots")
        pg.click(".spot-row"); pg.wait_for_selector("#result:not([hidden])")
        if pg.is_hidden("#locMore"): pg.click("#locToggle")
        pg.click("#saveSpot"); check("Save this spot" in pg.inner_text("#saveSpot"), "spot removed")
        pg.click("#placeBtn"); pg.wait_for_selector("#picker:not([hidden])"); pg.click("#gpsBtn"); pg.wait_for_selector("#result:not([hidden])")

        print("Viewpoints from OpenStreetMap")
        overpass_data["elements"] = [
            {"type": "node", "lat": 37.6227, "lon": -112.1661, "tags": {"tourism": "viewpoint", "name": "Sunset Point"}},
            {"type": "way", "center": {"lat": 37.6150, "lon": -112.1705}, "tags": {"tourism": "viewpoint", "name": "Inspiration Point"}},
            {"type": "node", "lat": 37.5470, "lon": -112.2380, "tags": {"tourism": "viewpoint", "name": "Paria View"}},
            {"type": "node", "lat": 37.70, "lon": -112.20, "tags": {"natural": "peak", "name": "Boat Mesa", "ele": "2650"}},
        ]
        pg.click(".tabbar button[data-go='spots']"); pg.click(".radius[data-r='25']"); pg.click("#scanBtn")
        pg.wait_for_selector(".vp .near-item", timeout=20000); pg.wait_for_timeout(300)
        names = [b.get_attribute("data-name") for b in pg.query_selector_all(".vp .near-item")]
        check(sorted(names) == ["Boat Mesa", "Inspiration Point", "Paria View", "Sunset Point"], "real viewpoints listed: " + ", ".join(names))
        check("Best bet:" in pg.inner_text("#nearStatus"), "headline names the best viewpoint: " + pg.inner_text("#nearStatus"))
        check("Peak · 2650 m" in pg.inner_text("#nearList"), "kind and height shown")
        href = pg.get_attribute(".vp-go", "href")
        check(href.startswith("https://www.google.com/maps/dir/?api=1&destination="), "directions link")
        check(any(w in pg.inner_text("#nearList") for w in ("open horizon", "hills")), "horizon check shown for each place")
        pg.eval_on_selector("#nearCard", "e => e.scrollIntoView()"); shot(pg, "06b-viewpoints")
        pg.click(".vp .near-item[data-name='Paria View']"); pg.wait_for_selector("#result:not([hidden])"); pg.wait_for_timeout(300)
        check(pg.inner_text("#locName") == "Paria View" and not pg.is_hidden("#tab-tonight"), "tapping a viewpoint opens it by name")
        print("Viewpoints when Overpass is down")
        overpass_data["down"] = True
        pg.click(".tabbar button[data-go='spots']"); pg.click("#scanBtn")
        pg.wait_for_function("document.querySelector('#nearStatus').textContent.includes('Best bet')", timeout=30000)
        names = [b.get_attribute("data-name") for b in pg.query_selector_all(".vp .near-item")]
        check("John Ford's Point" in names and "Artist's Point" in names, "falls back to OSM search: " + ", ".join(names))
        overpass_data["down"] = False
        overpass_data["elements"] = []
        pg.click(".tabbar button[data-go='tonight']")
        pg.click("#placeBtn"); pg.wait_for_selector("#picker:not([hidden])"); pg.click("#gpsBtn"); pg.wait_for_selector("#result:not([hidden])")

        pg.click("#kindSunrise"); pg.wait_for_selector("#result:not([hidden])"); pg.wait_for_timeout(300)
        check("sunrise" in pg.inner_text("#when").lower(), "sunrise mode")
        shot(pg, "02-sunrise", True)
        pg.click("#kindSunset"); pg.wait_for_selector("#result:not([hidden])")
        print("Installable app + offline")
        m = pg.evaluate("fetch('manifest.webmanifest').then(r => r.json())")
        check(m.get("display") == "standalone" and len(m.get("icons", [])) >= 2, "manifest valid")
        pg.wait_for_function("navigator.serviceWorker.getRegistration().then(r => !!r)", timeout=8000)
        check(True, "service worker registered")
        check("Updated" in pg.inner_text("#updated"), "shows when the forecast was updated: " + pg.inner_text("#updated"))
        calls = []
        pg.context.unroute("**/*open-meteo.com/**")
        pg.context.route("**/*open-meteo.com/**", lambda r: (calls.append(r.request.url), handle(r)))
        pg.reload(); pg.wait_for_selector("#result:not([hidden])", timeout=15000); pg.wait_for_timeout(500)
        check(not any("forecast_days=8" in c for c in calls), "fresh forecast reused from cache (no new forecast request)")
        pg.evaluate("() => { const c = JSON.parse(localStorage.getItem('wib-cache')); c.forEach(x => x.at -= 3600000); localStorage.setItem('wib-cache', JSON.stringify(c)); }")
        pg.context.unroute("**/*open-meteo.com/**")
        pg.context.route("**/*open-meteo.com/**", lambda r: r.abort())
        pg.reload(); pg.wait_for_selector("#result:not([hidden])", timeout=15000); pg.wait_for_timeout(500)
        check(not pg.is_hidden("#offline") and "Offline" in pg.inner_text("#offline"), "offline fallback shows last forecast: " + pg.inner_text("#offline"))
        shot(pg, "03-offline")
        pg.context.unroute("**/*open-meteo.com/**"); pg.context.route("**/*open-meteo.com/**", handle)
        pg.click("#refreshBtn"); pg.wait_for_timeout(800)
        check(pg.is_hidden("#offline") and "Updated just now" in pg.inner_text("#updated"), "refresh when back online")
        extra = os.environ.get("SMOKE_EXTRA")
        if extra:
            exec(open(extra).read(), {"pg": pg, "check": check, "shot": shot, "base": base, "new_page": new_page})
        ctx.close()

        print("Background alerts")
        ctx, pg = new_page()
        pg.goto(base); pg.wait_for_selector("#result:not([hidden])", timeout=10000)
        pg.evaluate("navigator.serviceWorker.ready"); pg.wait_for_timeout(500)
        r = pg.evaluate("navigator.serviceWorker.ready.then(reg => new Promise(res => { const ch = new MessageChannel(); ch.port1.onmessage = e => res(e.data); reg.active.postMessage({type:'ping'}, [ch.port2]); }))")
        check(r.get("module") is True, "module service worker running")
        pg.context.grant_permissions(["notifications"], origin=base.rstrip("/"))
        cdp = pg.context.new_cdp_session(pg)
        cdp.send("Browser.grantPermissions", {"origin": base.rstrip("/"), "permissions": ["notifications", "periodicBackgroundSync"]})
        pg.click(".tabbar button[data-go='more']"); pg.wait_for_timeout(300)
        pg.click("#alertOn"); pg.wait_for_timeout(600)
        check("Install the app" in pg.inner_text("#alertStatus"), "not installed: explains how to install first")
        # simulate an installed app (headless Chrome never grants background sync to an uninstalled page)
        pg.evaluate("""() => {
          const q = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = d => d.name === 'periodic-background-sync' ? Promise.resolve({ state: 'granted' }) : q(d);
          const tags = new Set();
          PeriodicSyncManager.prototype.register = async t => { tags.add(t); };
          PeriodicSyncManager.prototype.unregister = async t => { tags.delete(t); };
          PeriodicSyncManager.prototype.getTags = async () => [...tags];
        }""")
        pg.select_option("#alertThreshold", "50"); pg.click("#alertOn"); pg.wait_for_timeout(800)
        check("On:" in pg.inner_text("#alertStatus"), "alerts turned on: " + pg.inner_text("#alertStatus")[:90])
        tags = pg.evaluate("navigator.serviceWorker.ready.then(r => r.periodicSync.getTags())")
        check("wib-alert" in tags, "background check registered")
        pg.evaluate("""async (api) => { const c = await caches.open('wib-config'); const url = new URL('__alert-config', (await navigator.serviceWorker.ready).scope).href;
                       const cfg = await (await c.match(url)).json(); cfg.testApi = api; await c.put(url, new Response(JSON.stringify(cfg))); }""", base + "mock/forecast")
        pg.click("#alertTest"); pg.wait_for_function("document.getElementById('alertStatus').textContent.includes('Test alert sent') || document.getElementById('alertStatus').textContent.includes('finished') || document.getElementById('alertStatus').textContent.includes('Couldn')", timeout=15000)
        check("Test alert sent" in pg.inner_text("#alertStatus"), "test alert: " + pg.inner_text("#alertStatus"))
        notes = pg.evaluate("navigator.serviceWorker.ready.then(r => r.getNotifications()).then(n => n.map(x => x.title + ' | ' + x.body))")
        check(len(notes) == 1 and "/100" in notes[0], "notification shown: " + (notes[0] if notes else "none"))
        pg.eval_on_selector("#alertCard", "e => e.scrollIntoView()"); shot(pg, "11-alerts")
        pg.click("#alertOff"); pg.wait_for_timeout(500)
        tags = pg.evaluate("navigator.serviceWorker.ready.then(r => r.periodicSync.getTags())")
        check("wib-alert" not in tags and "off" in pg.inner_text("#alertStatus"), "alerts turned off")

        ctx.close()

        print("Rating flow (clock fixed at 17:45, 25 min after sunset)")
        ctx, pg = new_page()
        pg.clock.install(time=LOCAL_MIDNIGHT + 17 * 3600 + 45 * 60)
        pg.goto(base); pg.wait_for_selector("#result:not([hidden])", timeout=10000)
        check(len(AQ_CALLS) > 0 and "aerosol_optical_depth" in AQ_CALLS[0], "haze forecast requested with the weather")
        check(not pg.is_hidden("#rateCard"), "rating card shown after sunset")
        check(not pg.is_hidden("#rateBanner") and "Rate it" in pg.inner_text("#rateBanner"), "rate banner at the top after sunset")
        check("tonight" in pg.inner_text("#rateTitle").lower(), "asks about tonight")
        pg.click("#rateMore summary")
        pg.click("#rateSave"); check("first" in pg.inner_text("#rateMsg"), "must pick before saving")
        pg.click("#quick button[data-n='8']"); pg.wait_for_function("document.getElementById('rateMsg').textContent.includes('The app said')", timeout=8000)
        check("Sent: Great (75–89)" in pg.inner_text("#rateMsg") and "Claude" not in pg.inner_text("#rateCard") and "GitHub" not in pg.inner_text("#rateCard") and "The app said" in pg.inner_text("#rateMsg") and "on" in (pg.get_attribute("#quick button[data-n='8']", "class") or ""), "one tap saves: " + pg.inner_text("#rateMsg"))
        check(not pg.is_hidden("#commOffer"), "Add photo offered after rating (real Firebase config, no test backend)")
        check(logs_count(pg) == 1, "one-tap rating is in the log")
        pg.wait_for_timeout(300)
        sent = [json.loads(x["entry"][0]) for x in posted if x.get("form-name") == ["rating"]]
        check(len(sent) >= 1 and sent[-1]["rating"] == 8 and sent[-1]["band"] == "75-89" and sent[-1]["lat"] == round(sent[-1]["lat"], 2) and "place" not in sent[-1],
              "rating shared anonymously: " + (json.dumps(sent[-1])[:120] if sent else "nothing posted"))
        check(sent and sent[-1]["inputs"].get("aod") == 0.04 and sent[-1]["inputs"].get("elevation") is not None, "haze and altitude go into the score and the shared rating: " + (json.dumps(sent[-1]["inputs"]) if sent else ""))
        check(pg.is_hidden("#rateBanner"), "banner gone once rated")
        check(pg.query_selector("#scale") is None, "no 0-10 scale")
        pg.fill("#rateNotes", "Pink underlit altocumulus, peaked 10 min after sunset")
        if os.path.exists(PHOTO):
            pg.set_input_files("#ratePhoto", PHOTO)
            pg.wait_for_function("document.getElementById('photoMeta').textContent.includes('Photo taken') || document.getElementById('photoMeta').textContent.includes('no time')", timeout=8000)
            check("Photo taken 17:31 (11 min after sunset)" in pg.inner_text("#photoMeta") and "m from the spot" in pg.inner_text("#photoMeta"), "photo time and place read: " + pg.inner_text("#photoMeta"))
        pg.click("#rateSave"); pg.wait_for_function("document.getElementById('rateMsg').textContent.includes('with your note')", timeout=10000)
        check(pg.evaluate("JSON.parse(localStorage.getItem('wib-log'))[0].onLocation") is True, "rated on location (stored): " + pg.inner_text("#rateMsg"))
        check(pg.is_hidden("#rateLog"), "GitHub logging off by default")
        pg.click(".tabbar button[data-go='more']"); open_dev(pg); pg.fill("#logRepo", "RickyBalboaSun/will-it-burn-data"); pg.click("#logRepoSave")
        pg.click(".tabbar button[data-go='tonight']")
        check(not pg.is_hidden("#rateLog"), "GitHub button appears once a repository is set")
        href = pg.get_attribute("#rateLog", "href")
        check(href.startswith("https://github.com/RickyBalboaSun/will-it-burn-data/issues/new?title=") and "will-it-burn-log%20v1" in href and "rating%3A%208" in href, "Log it opens a pre-filled GitHub issue")
        check(not pg.eval_on_selector("#logCard", "e => e.hidden") and "(1)" in pg.eval_on_selector("#logCount", "e => e.textContent"), "log has 1 entry")
        check(pg.query_selector("#rateCopy") is None, "no Copy entry button")
        shot(pg, "04-rating")
        pg.reload(); pg.wait_for_selector("#result:not([hidden])")
        check(pg.text_content("#rateSave") == "Update note" and "on" in (pg.get_attribute("#quick button[data-n='8']", "class") or ""), "rating remembered after reload")
        open_dev(pg); shot(pg, "22-log", True)
        pg.click(".log-item .del"); pg.wait_for_timeout(100)
        check(pg.is_hidden("#logCard") and not pg.is_hidden("#logEmpty"), "deleting the only entry shows the empty state")
        ctx.close()

        print("Share")
        ctx, pg = new_page()
        pg.add_init_script("""
          navigator.canShare = () => true;
          navigator.share = async (data) => {
            const f = data.files && data.files[0];
            window.__shared = { text: data.text, img: f ? await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }) : null };
          };""")
        pg.goto(base); pg.wait_for_selector("#result:not([hidden])", timeout=10000)
        pg.click("#shareBtn"); pg.wait_for_function("window.__shared", timeout=8000)
        shared = pg.evaluate("window.__shared")
        check(shared["img"] and shared["img"].startswith("data:image/png"), "share sends a picture")
        check("/100" in shared["text"], "share text: " + shared["text"])
        if args.shots:
            import base64 as b64; open(f"{args.shots}/09-share.png", "wb").write(b64.b64decode(shared["img"].split(",")[1]))
        ctx.close()
        ctx, pg = new_page()
        pg.goto(base); pg.wait_for_selector("#result:not([hidden])", timeout=10000)
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        pg.evaluate("delete Navigator.prototype.share; delete Navigator.prototype.canShare")
        pg.click("#shareBtn"); pg.wait_for_timeout(800)
        check("Copied" in pg.inner_text("#shareMsg"), "without share support it copies the text instead")
        ctx.close()

        print("Past date")
        ctx, pg = new_page()
        pg.goto(base); pg.wait_for_selector("#result:not([hidden])", timeout=10000)
        open_dev(pg); pg.fill("#pastDate", "2026-10-20"); pg.click("#pastGo")
        pg.wait_for_selector("#pastBar:not([hidden])", timeout=10000); pg.wait_for_timeout(300)
        check("20 Oct" in pg.inner_text("#when"), "hero shows the past date: " + pg.inner_text("#when"))
        check(pg.is_hidden("#weekCard") and pg.is_hidden("#nearCard"), "forecast-only cards hidden")
        check(not pg.is_hidden("#rateCard") and "20 oct" in pg.inner_text("#rateTitle").lower(), "can rate the past date: " + pg.inner_text("#rateTitle"))
        pg.click("#quick button[data-n='6']"); pg.wait_for_timeout(300)
        check("(1)" in pg.eval_on_selector("#logCount", "e => e.textContent"), "past rating logged")
        shot(pg, "08-past")
        pg.click("#pastBack"); pg.wait_for_timeout(200)
        check(not pg.is_hidden("#weekCard") and pg.is_hidden("#pastBar"), "back to the forecast")
        open_dev(pg)
        pg.fill("#pastDate", "2099-01-01"); pg.click("#pastGo")
        check("earlier" in pg.inner_text("#pastStatus"), "future date rejected")
        ctx.close()

        print("Community (fake Firebase)")
        ctx, pg = new_page()
        pg.add_init_script(FAKE_BACKEND)
        pg.clock.install(time=LOCAL_MIDNIGHT + 17 * 3600 + 45 * 60)
        pg.goto(base); pg.wait_for_selector("#result:not([hidden])", timeout=10000)
        check(not pg.is_hidden("#tabCommunityBtn"), "Community tab shown when Firebase is configured")
        pg.click("#quick button[data-n='8']"); pg.wait_for_function("document.getElementById('rateMsg').textContent.includes('The app said')", timeout=8000)
        check(not pg.is_hidden("#commOffer"), "offer to add a photo after rating")
        pg.click("#commOfferBtn"); pg.wait_for_selector("#composer[open]")
        check("on" in (pg.get_attribute("#compBands button[data-band='Great']", "class") or ""), "composer starts from your rating")
        pg.click("#compPost"); check("Choose a photo" in pg.inner_text("#compMsg"), "needs a photo")
        if os.path.exists(PHOTO):
            pg.set_input_files("#compFile", PHOTO)
            pg.click("#compPost"); check("Tick the box" in pg.inner_text("#compMsg"), "needs consent")
            pg.check("#compConsent"); shot(pg, "25-composer")
            pg.click("#compPost"); pg.wait_for_function("document.getElementById('compMsg').textContent.includes('Thanks')", timeout=15000)
            up = pg.evaluate("window.__FAKE_UPLOAD"); mine = pg.evaluate("window.__FAKE_DB.find(p => p.uid === 'u-me')")
            check(up and up["fullType"] == "image/jpeg" and up["thumbSize"] <= up["fullSize"], f"photo shrunk to JPEG with a thumbnail: {up}")
            check(mine and mine["status"] == "pending" and mine["lat"] == round(mine["lat"], 2) and mine["band"] == "Great" and mine["place"],
                  f"stored as pending, location rounded: {mine and {k: mine[k] for k in ('lat','lon','band','place','status')}}")
            pg.wait_for_timeout(2700)
        big = pg.evaluate("""async () => { const C = await import('./js/community.js');
          const c = document.createElement('canvas'); c.width = 4000; c.height = 3000; c.getContext('2d').fillRect(0, 0, 10, 10);
          const blob = await new Promise(r => c.toBlob(r, 'image/png')); const f = new File([blob], 'x.png', { type: 'image/png' });
          const a = await C.shrink(f, 1600, 0.82), t = await C.shrink(f, 320, 0.72);
          return [a.w, a.h, t.w, t.h, a.blob.type, C.roundLL(37.61234), C.roundLL(-112.16789)]; }""")
        check(big == [1600, 1200, 320, 240, "image/jpeg", 37.61, -112.17], f"large photos shrink to 1600 px and a 320 px thumbnail: {big}")
        fit = pg.evaluate("""async () => { const C = await import('./js/community.js');
          const c = document.createElement('canvas'); c.width = 4000; c.height = 3000; const g = c.getContext('2d'); const d = g.createImageData(4000, 3000);
          for (let i = 0; i < d.data.length; i++) d.data[i] = (i % 4 === 3) ? 255 : Math.random() * 255; g.putImageData(d, 0, 0);
          const blob = await new Promise(r => c.toBlob(r, 'image/png')); const f = new File([blob], 'n.png', { type: 'image/png' });
          const a = await C.shrinkTo(f, 1280, 0.8, 560000), t = await C.shrinkTo(f, 240, 0.65, 30000);
          return [a.blob.size, t.blob.size, a.w, t.w]; }""")
        check(fit[0] <= 560000 and fit[1] <= 30000 and fit[3] <= 240, f"even a hard-to-compress photo fits the database size cap: {fit}")
        pg.click(".tabbar button[data-go='community']"); pg.wait_for_selector(".cpin", timeout=10000); pg.wait_for_timeout(400)
        check(len(pg.query_selector_all(".cpin")) == 2 and len(pg.query_selector_all(".comm-card")) == 2, "map shows approved sunsets only (2)")
        shot(pg, "24-community")
        pg.click("#commSunrise"); pg.wait_for_timeout(400)
        check(len(pg.query_selector_all(".comm-card")) == 1, "sunrise filter")
        pg.click("#commSunset"); pg.click("#commFire"); pg.wait_for_timeout(400)
        check(len(pg.query_selector_all(".comm-card")) == 1, "on-fire filter")
        pg.click("#commFire"); pg.wait_for_timeout(300)
        pg.click(".comm-card[data-id='p1']"); pg.wait_for_selector("#photoView[open]")
        check("Near Kayenta" in pg.inner_text("#pvPlace") and "On fire" in pg.inner_text("#pvBand") and "50" in pg.inner_text("#pvForecast"), "photo view")
        shot(pg, "26-photo")
        pg.click("#pvReport"); pg.wait_for_timeout(200)
        check(pg.evaluate("window.__FAKE_REPORTS.length") == 1, "report sent")
        pg.click("#pvForecastBtn"); pg.wait_for_selector("#result:not([hidden])"); pg.wait_for_timeout(300)
        check(pg.inner_text("#locName") == "Near Kayenta", "see the forecast at a shared photo's place")
        if os.path.exists(PHOTO):
            pg.click(".tabbar button[data-go='more']"); pg.wait_for_selector(".mp-row", timeout=8000)
            check("Being checked" in pg.inner_text("#myPhotos"), "your photos: pending")
            open_dev(pg); pg.wait_for_selector("#modQueue .mq-row", timeout=8000)
            pg.click("#modQueue button[data-act='approved']"); pg.wait_for_timeout(300)
            check(pg.evaluate("window.__FAKE_DB.find(p => p.uid === 'u-me').status") == "approved", "admin approves")
            pg.click(".tabbar button[data-go='community']"); pg.wait_for_timeout(600)
            check(len(pg.query_selector_all(".cpin")) == 3, "approved photo appears on the map")
            pg.click(".tabbar button[data-go='more']"); pg.wait_for_selector(".mp-del", timeout=8000)
            pg.click(".mp-del"); pg.wait_for_timeout(400)
            check(pg.evaluate("window.__FAKE_DB.filter(p => p.uid === 'u-me').length") == 0, "delete your photo")
        ctx.close()

        print("Install and invite")
        ctx, pg = new_page()
        pg.goto(base + "?install=1"); pg.wait_for_selector("#result:not([hidden])", timeout=10000)
        check(pg.is_hidden("#installBar"), "no install bar until the browser offers it")
        pg.evaluate("""() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__prompted = true; };
          e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); }""")
        check(not pg.is_hidden("#installBar"), "install bar appears when the browser allows install")
        shot(pg, "23-install")
        pg.click("#installBtn"); pg.wait_for_timeout(200)
        check(pg.evaluate("window.__prompted === true") and pg.is_hidden("#installBar"), "one tap opens the install prompt")
        pg.evaluate("""() => { const e = new Event('beforeinstallprompt'); e.prompt = () => {}; e.userChoice = Promise.resolve({}); window.dispatchEvent(e); }""")
        pg.click("#installX"); check(pg.is_hidden("#installBar"), "install bar can be dismissed")
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        pg.click(".tabbar button[data-go='more']"); pg.click("#shareApp"); pg.wait_for_timeout(300)
        check("?install=1" in pg.inner_text("#shareAppMsg"), "invite link copied: " + pg.inner_text("#shareAppMsg"))
        ctx.close()

        print("What's new")
        ctx, pg = new_page()
        pg.goto(base); pg.wait_for_selector("#result:not([hidden])", timeout=10000); pg.wait_for_timeout(1500)
        check(not pg.evaluate("document.getElementById('whatsNew').open"), "first-time visitor: no what's-new")
        pg.evaluate("localStorage.setItem('wib-release', JSON.stringify('1.0'))")
        pg.reload(); pg.wait_for_selector("#result:not([hidden])"); pg.wait_for_timeout(1600)
        check(pg.evaluate("document.getElementById('whatsNew').open"), "returning user sees what's new once")
        shot(pg, "14-whatsnew")
        pg.click("#whatsNew .btn"); pg.reload(); pg.wait_for_selector("#result:not([hidden])"); pg.wait_for_timeout(1600)
        check(not pg.evaluate("document.getElementById('whatsNew').open"), "not shown again")
        ctx.close()

        print("Search flow (GPS denied)")
        ctx, pg = new_page(geo=False)
        pg.goto(base); pg.wait_for_selector("#picker:not([hidden])", timeout=20000)
        pg.fill("#q", "Mumbles"); pg.click("button[type=submit]"); pg.wait_for_selector(".results button")
        pg.click(".results button"); pg.wait_for_selector("#result:not([hidden])")
        check(pg.inner_text("#locName") == "Mumbles", "searched place shown")
        pg.reload(); pg.wait_for_selector("#result:not([hidden])", timeout=10000)
        check(pg.inner_text("#locName") == "Mumbles", "searched place remembered after reload")
        ctx.close()

        check(not errors, "no page errors" + (f": {errors[:3]}" if errors else ""))
        b.close()
    httpd.shutdown()
    print("PASS" if not FAILS else f"FAILED: {len(FAILS)}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
