// Community tab: anonymised sunset and sunrise photos on a world map.
// Hidden unless js/firebase-config.js has a config (or a test backend is injected).
import { FIREBASE_CONFIG } from "./firebase-config.js";
import { createBackend } from "./community-backend.js";

const DAY = 86400000;
const DAILY_LIMIT = 5;
const BAND_COLOURS = { "Dull": "#6f6a85", "Some colour": "#ffd9a0", "Good": "#ffa552", "Great": "#f57a3c", "On fire": "#f0532c" };

export function enabled() { return !!(FIREBASE_CONFIG || window.__SUNSCORE_FAKE_BACKEND); }

/** Shrink a photo with a canvas. Re-encoding drops every hidden detail (EXIF: camera, time, GPS). */
export async function shrink(file, maxSide, quality) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    src = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = URL.createObjectURL(file); });
  }
  const w0 = src.width, h0 = src.height, k = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(src, 0, 0, w, h);
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", quality));
  return { blob, w, h };
}
/** Shrink until the JPEG fits under maxBytes (photos live inside database records, which cap at 1 MB). */
export async function shrinkTo(file, maxSide, quality, maxBytes) {
  let r = await shrink(file, maxSide, quality);
  for (const [side, q] of [[maxSide, quality - 0.15], [Math.round(maxSide * 0.8), quality - 0.2], [Math.round(maxSide * 0.6), 0.6]]) {
    if (r.blob.size <= maxBytes) break;
    r = await shrink(file, side, q);
  }
  return r;
}
/** About 1 km: two decimal places. */
export const roundLL = v => Math.round(v * 100) / 100;

export function initCommunity(ctx) {
  const { $, esc, store, state } = ctx;
  let backend = null, backendP = null, feedCache = null, map = null, layer = null;
  let kind = "all", period = "week", fireOnly = false, composerEvent = null, composerFile = null;

  if (!enabled()) return { enabled: false, offerAfterRating() {}, renderMine() {}, renderQueue() {}, renderTab() {}, warm() {} };
  $("tabCommunityBtn").hidden = false;

  async function ensure() {
    if (backend) return backend;
    if (!backendP) backendP = createBackend(FIREBASE_CONFIG).then(b => (backend = b)).catch(e => { backendP = null; throw e; });
    return backendP;
  }
  const say = (el, text) => { $(el).textContent = text; };
  const ago = ms => {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 60 ? `${Math.max(1, m)} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  const dateText = p => new Date(p.date + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

  /* ---------- the map tab ---------- */
  const BAND_RANK = { "On fire": 4, "Great": 3, "Good": 2, "Some colour": 1, "Dull": 0 };
  function filtered(list) {
    const now = Date.now();
    const out = list.filter(p => (kind === "all" || p.kind === kind)
      && (period === "best" ? BAND_RANK[p.band] >= 3 : period === "tonight" ? p.t * 1000 > now - 20 * 3600000 : p.t * 1000 > now - 7 * DAY)
      && (!fireOnly || p.band === "On fire"));
    // best ever: On fire first, then Great, newest first within each; capped so the map stays light
    return period === "best" ? out.sort((a, b) => BAND_RANK[b.band] - BAND_RANK[a.band] || b.createdAt - a.createdAt).slice(0, 60) : out;
  }
  const kindWord = { all: "skies", sunset: "sunsets", sunrise: "sunrises" };
  async function renderTab(force = false) {
    say("commStatus", feedCache && !force ? "" : "Loading skies…");
    const mapP = baseMap();                       // map and tiles start straight away, alongside the photos
    let b;
    try { b = await ensure(); } catch { say("commStatus", "Couldn't reach the community right now. Try again in a minute."); return; }
    try { if (force || !feedCache) feedCache = await b.feed(); }
    catch { say("commStatus", "Couldn't load photos right now."); return; }
    const list = filtered(feedCache);
    $("commCount").textContent = list.length ? `${list.length} ${list.length === 1 ? "sky" : "skies"}` : "";
    $("commStripTitle").textContent = `${{ tonight: "Latest", week: "This week", best: "Best ever" }[period]}: ${kindWord[kind]} around the world`;
    say("commStatus", list.length ? "" : `No ${period === "best" ? "Great or On fire " : ""}${kind === "all" ? "" : kind + " "}photos here yet. Rate a sky at the bottom of Today and add your photo to be the first.`);
    $("commStrip").innerHTML = list.slice(0, 24).map(p => `
      <button class="comm-card" data-id="${esc(p.id)}">
        <img alt="" data-id="${esc(p.id)}" loading="lazy">
        <span class="cc-place">${esc(p.place || "Somewhere")}</span>
        <span class="cc-meta"><i style="background:${BAND_COLOURS[p.band] || "#ffa552"}"></i>${p.kind === "sunrise" ? "Sunrise" : "Sunset"} · ${esc(p.band)} · ${ago(p.createdAt)}</span>
      </button>`).join("");
    for (const img of $("commStrip").querySelectorAll("img[data-id]")) {
      const p = list.find(x => x.id === img.dataset.id);
      if (p) b.url(p, true).then(u => { img.src = u; }).catch(() => {});
    }
    await mapP; await drawPins(list, b);
  }
  async function baseMap() {
    let L; try { L = await ctx.loadLeaflet(); } catch { return null; }
    if (!map) {
      map = L.map("commMap", { zoomControl: false, worldCopyJump: true });
      L.tileLayer(ctx.TILE_URL, { maxZoom: 18, className: "dark-tiles", attribution: ctx.TILE_ATTR }).addTo(map);
      map.setView(state.place ? [state.place.lat, state.place.lon] : [20, 0], 3);
    }
    setTimeout(() => map.invalidateSize(), 60);
    return L;
  }
  async function drawPins(list, b) {
    const L = window.L; if (!L || !map) return;
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(map);
    for (const p of list) {
      const icon = L.divIcon({ className: "cpin", iconSize: [46, 46], iconAnchor: [23, 23],
        html: `<span class="cpin-ring" style="border-color:${BAND_COLOURS[p.band] || "#ffa552"}"><img alt="${esc(p.band)} ${esc(p.kind)}"></span>` });
      const m = L.marker([p.lat, p.lon], { icon, keyboard: true, title: `${p.place || ""}: ${p.band}` }).addTo(layer);
      m.on("click", () => openPhoto(p));
      const fill = () => b.url(p, true).then(u => { const im = m.getElement() && m.getElement().querySelector("img"); if (im) im.src = u; }).catch(() => {});
      m.on("add", fill); fill();
    }
    const here = state.place ? [state.place.lat, state.place.lon] : [20, 0];
    if (list.length) map.fitBounds(L.latLngBounds([...list.map(p => [p.lat, p.lon]), here]).pad(0.2), { maxZoom: 8 });
    else map.setView(here, 3);
    setTimeout(() => map.invalidateSize(), 60);
  }
  /** Fetch the map and Firebase code in the background, so the tab opens quickly later. */
  function warm() {
    const c = navigator.connection;
    if (c && (c.saveData || /2g/.test(c.effectiveType || ""))) return;
    ctx.loadLeaflet().catch(() => {});
    ensure().then(b => b.feed()).then(f => { if (!feedCache) feedCache = f; }).catch(() => {});
  }
  $("commStrip").addEventListener("click", ev => {
    const c = ev.target.closest(".comm-card"); if (!c || !feedCache) return;
    const p = feedCache.find(x => x.id === c.dataset.id); if (p) openPhoto(p);
  });
  const KINDS = [["commAll", "all"], ["commSunset", "sunset"], ["commSunrise", "sunrise"]];
  for (const [id, k] of KINDS) {
    $(id).addEventListener("click", () => { kind = k; for (const [i2, k2] of KINDS) $(i2).classList.toggle("on", k2 === k); renderTab(); });
  }
  const PERIODS = [["commTonight", "tonight"], ["commWeek", "week"], ["commBest", "best"]];
  for (const [id, p] of PERIODS) {
    $(id).addEventListener("click", () => { period = p; for (const [i2, p2] of PERIODS) $(i2).classList.toggle("on", p2 === p); renderTab(); });
  }
  $("commFire").addEventListener("click", () => { fireOnly = !fireOnly; $("commFire").classList.toggle("on", fireOnly); renderTab(); });
  $("commAdd").addEventListener("click", () => openComposer(null));

  /* ---------- one photo ---------- */
  let viewing = null;
  async function openPhoto(p) {
    viewing = p;
    $("pvImg").removeAttribute("src");
    $("pvBand").innerHTML = `<i style="background:${BAND_COLOURS[p.band] || "#ffa552"}"></i>Rated ${esc(p.band)}`;
    $("pvPlace").textContent = p.place || "Somewhere";
    $("pvWhen").textContent = `${p.kind === "sunset" ? "Sunset" : "Sunrise"} · ${dateText(p)} · ${ago(p.createdAt)}`;
    $("pvForecast").innerHTML = p.predicted != null ? `Sunscore said <b>${p.predicted}</b> · ${esc(ctx.bandFor(p.predicted).name)}` : "–";
    $("pvGo").href = ctx.directionsUrl(p);
    $("pvMsg").textContent = "";
    $("pvReport").disabled = false;
    $("photoView").showModal();
    try { $("pvImg").src = await (await ensure()).url(p, false); } catch { /* keep blank */ }
  }
  $("pvClose").addEventListener("click", () => $("photoView").close());
  $("pvForecastBtn").addEventListener("click", () => {
    if (!viewing) return;
    $("photoView").close();
    ctx.run({ name: viewing.place || "Shared sky", label: viewing.place || "Shared sky", detail: "", lat: viewing.lat, lon: viewing.lon });
    ctx.showTab("tonight");
  });
  $("pvReport").addEventListener("click", async () => {
    if (!viewing) return;
    try { await (await ensure()).report(viewing.id, "user report"); $("pvMsg").textContent = "Thanks. We'll take a look."; $("pvReport").disabled = true; }
    catch { $("pvMsg").textContent = "Couldn't send the report. Try again later."; }
  });

  /* ---------- add your photo ---------- */
  function offerAfterRating(entry) {
    $("commOffer").hidden = false;
    $("commOfferBtn").onclick = () => openComposer(entry);
  }
  function openComposer(entry) {
    const ev = entry || ctx.currentEvent();
    if (!ev) { alertMsg("There's no recent sunset or sunrise here to add a photo for."); return; }
    composerEvent = ev; composerFile = null;
    $("compPreview").hidden = true; $("compPreview").removeAttribute("src");
    $("compFile").value = ""; $("compConsent").checked = false; $("compMsg").textContent = "";
    $("compPickText").textContent = "Choose a photo";
    $("compWhat").textContent = `${ev.kind === "sunset" ? "Sunset" : "Sunrise"} · ${dateText(ev)}`;
    setBand(ev.rating != null ? ctx.bandFor(ev.rating * 10).name : null);
    $("compPost").disabled = false;
    $("composer").showModal();
  }
  function alertMsg(t) { $("commStatus").textContent = t; }
  let compBand = null;
  function setBand(name) {
    compBand = name;
    for (const b of $("compBands").querySelectorAll("button")) {
      const on = b.dataset.band === name; b.classList.toggle("on", on); b.setAttribute("aria-checked", on);
    }
  }
  $("compBands").addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) setBand(b.dataset.band); });
  $("compFile").addEventListener("change", () => {
    composerFile = $("compFile").files[0] || null;
    if (!composerFile) return;
    $("compPreview").src = URL.createObjectURL(composerFile); $("compPreview").hidden = false;
    $("compPickText").textContent = "Change photo";
  });
  $("compCancel").addEventListener("click", () => $("composer").close());
  $("compPost").addEventListener("click", async () => {
    const msg = t => { $("compMsg").textContent = t; };
    if (!composerFile) return msg("Choose a photo first.");
    if (!compBand) return msg("Tap how colourful it was.");
    if (!$("compConsent").checked) return msg("Tick the box to confirm it's your photo and can be shown publicly.");
    const today = new Date().toISOString().slice(0, 10), count = store.get("wib-posts", {});
    if ((count[today] || 0) >= DAILY_LIMIT) return msg(`You can add up to ${DAILY_LIMIT} photos a day.`);
    $("compPost").disabled = true; msg("Preparing your photo…");
    try {
      const [full, thumb] = await Promise.all([shrinkTo(composerFile, 1280, 0.8, 560000), shrinkTo(composerFile, 240, 0.65, 30000)]);
      const p = state.place, lat = roundLL(p.lat), lon = roundLL(p.lon);
      let place = p.label && /^near /i.test(p.label) ? p.label : null;
      if (!place) { try { const n = await ctx.reverseName(lat, lon); place = n ? `Near ${n}` : null; } catch { place = null; } }
      const band = ctx.BANDS.find(b => b.name === compBand);
      const meta = { kind: composerEvent.kind, date: composerEvent.date, t: composerEvent.t, band: band.name, bandLo: band.lo,
        predicted: composerEvent.predicted ?? null, place: place || "Somewhere", lat, lon, w: full.w, h: full.h, model: ctx.M.MODEL_VERSION };
      msg("Uploading…");
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await (await ensure()).upload({ id, full: full.blob, thumb: thumb.blob, meta });
      count[today] = (count[today] || 0) + 1; store.set("wib-posts", { [today]: count[today] });
      msg("Thanks! It'll appear on the map once it's checked, usually within a few minutes.");
      $("commOffer").hidden = true;
      renderMine();
      setTimeout(() => { if ($("composer").open) $("composer").close(); }, 2500);
    } catch {
      $("compPost").disabled = false;
      msg("Couldn't upload right now. Check your connection and try again.");
    }
  });

  /* ---------- your photos (More) ---------- */
  async function renderMine() {
    $("myPhotosCard").hidden = false;
    let b, list;
    try { b = await ensure(); list = await b.mine(); } catch { $("myPhotos").innerHTML = '<div class="note">Couldn\'t load your photos right now.</div>'; return; }
    $("myPhotosSummary").textContent = list.length
      ? `${list.length} shared · ${list.filter(p => p.status === "approved").length} on the map` : "You haven't shared a photo yet.";
    $("myPhotosAll").hidden = !list.length;
    $("myPhotos").innerHTML = list.map(p => `
      <div class="mp-row">
        <img alt="" data-id="${esc(p.id)}">
        <span><b>${esc(p.place || "Somewhere")}</b><br><small>${p.kind === "sunset" ? "Sunset" : "Sunrise"} · ${dateText(p)}</small><br>
        <small class="mp-${esc(p.status)}">${p.status === "approved" ? "On the map" : p.status === "rejected" ? "Not shown" : "Being checked"}</small></span>
        <button class="mp-del" data-id="${esc(p.id)}" aria-label="Delete this photo">Delete</button>
      </div>`).join("");
    for (const img of $("myPhotos").querySelectorAll("img[data-id]")) {
      const p = list.find(x => x.id === img.dataset.id);
      b.url(p, true).then(u => { img.src = u; }).catch(() => {});
    }
    $("myPhotos").onclick = async ev => {
      const d = ev.target.closest(".mp-del"); if (!d) return;
      const p = list.find(x => x.id === d.dataset.id); if (!p) return;
      d.disabled = true; d.textContent = "Deleting…";
      try { await b.remove(p); feedCache = null; renderMine(); } catch { d.disabled = false; d.textContent = "Delete"; }
    };
    $("myPhotosAll").onclick = async () => {
      if (!$("myPhotosAll").dataset.sure) { $("myPhotosAll").dataset.sure = "1"; $("myPhotosAll").textContent = "Tap again to delete all"; return; }
      delete $("myPhotosAll").dataset.sure; $("myPhotosAll").textContent = "Deleting…";
      for (const p of list) { try { await b.remove(p); } catch { /* carry on */ } }
      $("myPhotosAll").textContent = "Delete all my photos"; feedCache = null; renderMine();
    };
  }

  /* ---------- moderation (Developer view) ---------- */
  async function renderQueue() {
    $("modCard").hidden = false;
    let b; try { b = await ensure(); } catch { $("modQueue").textContent = "Couldn't reach Firebase."; return; }
    let me; try { me = b.whoami ? await b.whoami() : { uid: b.uid, admin: b.isAdmin() }; } catch { $("modQueue").textContent = "Couldn't sign in to Firebase."; return; }
    $("modUid").textContent = `This phone's user ID: ${me.uid}${me.admin ? " (admin)" : " (not an admin yet)"}`;
    if (!me.admin) { $("modQueue").innerHTML = '<div class="note">Add this ID as a document in the "admins" collection to approve photos.</div>'; return; }
    let list, reports;
    try { [list, reports] = await Promise.all([b.pending(), b.reports()]); } catch { $("modQueue").textContent = "Couldn't load the queue."; return; }
    const reported = new Set(reports.map(r => r.photo));
    $("modQueue").innerHTML = (list.length ? "" : '<div class="note">Nothing waiting.</div>') + list.map(p => `
      <div class="mq-row">
        <img alt="" data-id="${esc(p.id)}">
        <span><b>${esc(p.place)}</b> · ${esc(p.band)}${reported.has(p.id) ? " · reported" : ""}<br><small>${p.kind} ${esc(p.date)} · ${ago(p.createdAt)}</small></span>
        <span class="mq-actions"><button class="btn small" data-act="approved" data-id="${esc(p.id)}">Approve</button>
        <button class="btn small ghost" data-act="rejected" data-id="${esc(p.id)}">Reject</button></span>
      </div>`).join("") + (reports.length ? `<div class="note">${reports.length} report(s) on live photos. Reject from the map to remove.</div>` : "");
    for (const img of $("modQueue").querySelectorAll("img[data-id]")) {
      const p = list.find(x => x.id === img.dataset.id);
      b.url(p, false).then(u => { img.src = u; }).catch(() => {});
    }
    $("modQueue").onclick = async ev => {
      const btn = ev.target.closest("button[data-act]"); if (!btn) return;
      btn.disabled = true;
      try { await b.setStatus(btn.dataset.id, btn.dataset.act); feedCache = null; renderQueue(); } catch { btn.disabled = false; }
    };
  }

  return { enabled: true, offerAfterRating, renderMine, renderQueue, renderTab, warm };
}
