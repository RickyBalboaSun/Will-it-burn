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
        hourly = {"time": times}
        if models:
            for k, (mname) in enumerate(models.split(",")):
                for var, vals in base.items():
                    hourly[f"{var}_{mname}"] = [min(100, v + 15 * k) if var == "cloud_cover_mid" else v for v in vals]
        else:
            hourly.update(base)
        out.append({"utc_offset_seconds": OFFSET, "elevation": 2400 if float(lat) > 37 and float(lat) < 38 else 20, "hourly": hourly, "daily": {"time": [], "sunset": sunsets, "sunrise": sunrises}})
    return out if len(out) > 1 else out[0]


def handle(route):
    u = urlparse(route.request.url); qs = parse_qs(u.query)
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
FAILS = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: FAILS.append(msg)


def main():
    httpd = serve(); base = f"http://127.0.0.1:{httpd.server_address[1]}/"
    with sync_playwright() as p:
        chrome = os.environ.get("CHROME_PATH", "/usr/bin/google-chrome")
        b = p.chromium.launch(executable_path=chrome if os.path.exists(chrome) else None, args=["--no-sandbox"])
        errors = []

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
            ctx.route("**/*basemaps.cartocdn.com/**", lambda r: r.fulfill(status=200, body=TILE, content_type="image/png"))
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
        check(pg.inner_text("#locSub").startswith("Utah, United States\n"), "tidy region and country: " + pg.inner_text("#locSub").split("\n")[0])
        check(pg.inner_text("#score").isdigit(), "score shown")
        check("2,400 m" in pg.inner_text("#locSub").replace("\xa0", " ") and not pg.is_hidden("#elevWarn"), "high-altitude note: " + pg.inner_text("#elevWarn")[:80])
        days = pg.query_selector_all(".day")
        check(len(days) >= 6, f"week strip has {len(days)} days")
        check(pg.inner_text("#times").count(":") >= 3, "viewing times shown")
        check(len(pg.query_selector_all(".tip")) >= 1, "look-for tips: " + " | ".join(t.inner_text().split("\n")[0] for t in pg.query_selector_all(".tip")))
        pg.wait_for_selector("#conf:not([hidden])", timeout=8000)
        check("confidence" in pg.inner_text("#conf"), "confidence pill: " + pg.inner_text("#conf"))
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
        pg.click("#nearCard summary"); pg.click(".radius[data-r='50']"); pg.click("#scanBtn")
        pg.wait_for_selector(".near-item", timeout=10000); pg.wait_for_timeout(500)
        check(len(pg.query_selector_all(".near-item")) == 6, "nearby scan lists top 6 places")
        check(pg.inner_text("#nearStatus") != "", "scan verdict: " + pg.inner_text("#nearStatus"))
        check(len(pg.query_selector_all("#nearMap path.leaflet-interactive")) == 17, "17 places on the scan map")
        pg.eval_on_selector("#nearCard", "e => e.scrollIntoView()"); shot(pg, "06-nearby")
        pg.wait_for_function("document.querySelector('.near-item[data-place]')", timeout=5000)
        check("near Bryce Canyon City" in pg.inner_text("#nearList"), "nearby places get real names")
        target = [b for b in pg.query_selector_all(".near-item") if b.get_attribute("data-name") != "Here"][0]
        tname = target.get_attribute("data-name")
        target.click(); pg.wait_for_selector("#result:not([hidden])"); pg.wait_for_timeout(300)
        check("Near Bryce Canyon City" == pg.inner_text("#locName") and tname in pg.inner_text("#locSub"), f"tapping a nearby place switches to it ({tname})")
        tname = "Near Bryce Canyon City"
        pg.click("#saveSpot"); check("Saved" in pg.inner_text("#saveSpot"), "spot saved")
        pg.click("#placeBtn"); pg.click("#gpsBtn"); pg.wait_for_selector("#result:not([hidden])")
        pg.wait_for_function("document.getElementById('ms0') && /\\d/.test(document.getElementById('ms0').textContent)", timeout=8000)
        check(not pg.is_hidden("#mySpotsCard"), "your spots shown on the main screen: " + pg.inner_text("#mySpots").replace("\n", " "))
        pg.click(".spotchip"); pg.wait_for_selector("#result:not([hidden])"); pg.wait_for_timeout(300)
        check(pg.inner_text("#locName") == "Near Bryce Canyon City" and "25 km" in pg.inner_text("#locSub"), "tapping a spot chip opens it")
        pg.click("#placeBtn"); pg.wait_for_selector("#spots:not([hidden])")
        pg.wait_for_function("document.querySelector('#spotScore0') && /\\d/.test(document.querySelector('#spotScore0').textContent)", timeout=8000)
        check(True, "saved spot listed with a score: " + pg.inner_text("#spotList").replace("\n", " "))
        shot(pg, "07-spots")
        pg.click(".spot-row"); pg.wait_for_selector("#result:not([hidden])")
        check(tname in pg.inner_text("#locName"), "opening a saved spot")
        pg.click("#saveSpot"); check("Save this spot" in pg.inner_text("#saveSpot"), "spot removed")
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
        check(not any("forecast_days=8" in c and "models" not in c for c in calls), "fresh forecast reused from cache (no new forecast request)")
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
        pg.click("#alertCard summary"); pg.wait_for_timeout(300)
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

        print("Rating flow (clock fixed at 9pm, after sunset)")
        ctx, pg = new_page()
        pg.clock.install(time=LOCAL_MIDNIGHT + 21 * 3600)
        pg.goto(base); pg.wait_for_selector("#result:not([hidden])", timeout=10000)
        check(not pg.is_hidden("#rateCard"), "rating card shown after sunset")
        check("tonight" in pg.inner_text("#rateTitle").lower(), "asks about tonight")
        pg.click("#rateSave"); check("first" in pg.inner_text("#rateMsg"), "must pick a number before saving")
        pg.click("#scale button[data-n='7']")
        check("Strong colour" in pg.inner_text("#rubric"), "rubric text for 7")
        pg.fill("#rateNotes", "Pink underlit altocumulus, peaked 10 min after sunset")
        pg.click("#rateSave")
        check(not pg.is_hidden("#rateCopy"), "copy button appears after saving")
        check(not pg.is_hidden("#logCard") and "(1)" in pg.inner_text("#logCount"), "log shows 1 entry")
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        pg.click("#rateCopy"); pg.wait_for_timeout(200)
        clip = pg.evaluate("navigator.clipboard.readText()")
        check("My rating: 7/10" in clip and "App score:" in clip and "Pink underlit" in clip, "copied text has rating, score and notes")
        print("    " + clip.replace("\n", "\n    "))
        shot(pg, "04-rating")
        pg.reload(); pg.wait_for_selector("#result:not([hidden])")
        check(pg.inner_text("#rateSave") == "Update rating" and "on" in (pg.get_attribute("#scale button[data-n='7']", "class") or ""), "rating remembered after reload")
        pg.click("#logCard summary"); pg.click(".log-item .del"); pg.wait_for_timeout(100)
        check(pg.is_hidden("#logCard"), "deleting the only entry hides the log")
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
        pg.click("#pastCard summary"); pg.fill("#pastDate", "2026-10-20"); pg.click("#pastGo")
        pg.wait_for_selector("#pastBar:not([hidden])", timeout=10000); pg.wait_for_timeout(300)
        check("20 Oct" in pg.inner_text("#when"), "hero shows the past date: " + pg.inner_text("#when"))
        check(pg.is_hidden("#weekCard") and pg.is_hidden("#nearCard"), "forecast-only cards hidden")
        check(not pg.is_hidden("#rateCard") and "20 oct" in pg.inner_text("#rateTitle").lower(), "can rate the past date: " + pg.inner_text("#rateTitle"))
        pg.click("#scale button[data-n='6']"); pg.click("#rateSave")
        check("(1)" in pg.inner_text("#logCount"), "past rating logged")
        shot(pg, "08-past")
        pg.click("#pastBack"); pg.wait_for_timeout(200)
        check(not pg.is_hidden("#weekCard") and pg.is_hidden("#pastBar"), "back to the forecast")
        pg.click("#pastCard summary") if not pg.eval_on_selector("#pastCard", "e => e.open") else None
        pg.fill("#pastDate", "2099-01-01"); pg.click("#pastGo")
        check("earlier" in pg.inner_text("#pastStatus"), "future date rejected")
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
