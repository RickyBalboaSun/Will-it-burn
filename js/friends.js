// Friends and scoring: invite and follow links, a friends feed, fire reactions, chase points,
// badges and a monthly friends leaderboard. Lives alongside the Community tab and shares its backend.
//
// Points: each photo you share earns the forecast score for that sky, once it has been checked
// (approved). How you rate the sky never changes your points, so ratings stay honest for the model.

const BADGES = [
  ["first-sky", "First sky", "Rate your first sky"],
  ["first-photo", "First photo", "Share a photo"],
  ["first-sunrise", "First sunrise", "Share a sunrise"],
  ["five-places", "Five places", "Photos from 5 places"],
  ["ninety", "Caught a 90+", "Photo of a 90+ forecast"],
  ["four-months", "Four months", "Rate a sky 4 months running"],
  ["both-ends", "Both ends", "Sunrise and sunset in one day"],
  ["ten-photos", "Ten photos", "Share 10 photos"],
];
const NAME_COLOURS = ["#ffd166", "#ff8f7a", "#b9a4ff", "#9ad0ff", "#7ee08a", "#ffa552"];
const FLAME = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.5 1.5 1.5 2 2 2 0-3-.5-5 1-7.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

/* ---------- pure helpers (unit-tested) ---------- */
/** Local "2026-11" for a time in ms. */
export const monthKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
export const prevMonthKey = ms => { const d = new Date(ms); d.setDate(1); d.setMonth(d.getMonth() - 1); return monthKey(d.getTime()); };
/** Chase points: forecast scores of checked photos, optionally only those posted in one month. */
export function points(photos, month = null) {
  return photos.filter(p => p.status === "approved" && p.predicted != null && (!month || monthKey(p.createdAt) === month))
    .reduce((s, p) => s + Math.round(p.predicted), 0);
}
/** Months in a row (ending this month or last) with at least one rated sky. */
export function monthStreak(log, now = Date.now()) {
  const months = new Set(log.map(e => monthKey(e.t * 1000)));
  let key = monthKey(now), n = 0;
  if (!months.has(key)) key = prevMonthKey(now);
  let d = new Date(key + "-15T12:00:00");
  while (months.has(monthKey(d.getTime()))) { n++; d.setMonth(d.getMonth() - 1); }
  return n;
}
/** Which badges are earned, from the ratings log and your photos. */
export function earnedBadges(log, mine, now = Date.now()) {
  const days = {};
  for (const e of log) (days[e.date] = days[e.date] || new Set()).add(e.kind);
  const places = new Set(mine.map(p => p.place).filter(Boolean));
  return new Set([
    log.length >= 1 && "first-sky",
    mine.length >= 1 && "first-photo",
    mine.some(p => p.kind === "sunrise") && "first-sunrise",
    places.size >= 5 && "five-places",
    mine.some(p => (p.predicted || 0) >= 90) && "ninety",
    monthStreak(log, now) >= 4 && "four-months",
    Object.values(days).some(s => s.size === 2) && "both-ends",
    mine.length >= 10 && "ten-photos",
  ].filter(Boolean));
}
/** Leaderboard rows for a month: [{uid, name, pts, photos}], highest first. */
export function leaderboard(people, month) {
  return people.map(p => ({ ...p, pts: points(p.list, month),
    photos: p.list.filter(x => x.status === "approved" && monthKey(x.createdAt) === month).length }))
    .sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name));
}

/* ---------- UI ---------- */
export function initFriends(ctx) {
  const { $, esc, store, ensure, openPhoto, ago, bandColour, logAll, showTab } = ctx;
  let links = { following: [], followers: [] }, names = {}, myName = "", loaded = null;
  const friendPhotos = new Map();
  const colour = uid => NAME_COLOURS[[...uid].reduce((s, c) => s + c.charCodeAt(0), 0) % NAME_COLOURS.length];
  const avatar = (name, uid) => `<span class="av" style="background:${colour(uid)}" aria-hidden="true">${esc((name || "?").trim().charAt(0).toUpperCase() || "?")}</span>`;
  const nameOf = uid => names[uid] || "A friend";
  const msg = (id, t) => { $(id).textContent = t; };
  const base = () => location.origin + location.pathname.replace(/index\.html$/, "");

  async function load(force = false) {
    if (loaded && !force) return loaded;
    loaded = (async () => {
      const b = await ensure();
      const [l, prof] = await Promise.all([b.links(), b.profile()]);
      links = l; myName = prof.name || "";
      const everyone = [...new Set([...l.following, ...l.followers])];
      names = everyone.length ? await b.names(everyone) : {};
      await Promise.all(l.following.map(async u => { try { friendPhotos.set(u, await b.photosOf(u)); } catch { friendPhotos.set(u, []); } }));
      saveWorkerConfig().catch(() => {});
      return b;
    })().catch(e => { loaded = null; throw e; });
    return loaded;
  }
  const allFriendPhotos = () => [...friendPhotos.entries()].flatMap(([uid, list]) => list.map(p => ({ ...p, uid })))
    .sort((a, b) => b.createdAt - a.createdAt);

  /* ----- new-photo dot on the Community tab ----- */
  async function refreshDot() {
    try { await load(); } catch { return; }
    const seen = store.get("wib-friends-seen", 0), latest = allFriendPhotos()[0];
    const fresh = !!(latest && latest.createdAt > seen);
    $("commFriendsDot").hidden = !fresh; $("tabCommDot").hidden = !fresh;
  }

  /* ----- Friends view inside Community ----- */
  async function renderFeed() {
    $("friendFeed").innerHTML = '<div class="note">Loading your friends…</div>';
    let b; try { b = await load(true); } catch { $("friendFeed").innerHTML = '<div class="note">Couldn\'t load your friends right now.</div>'; return; }
    const list = allFriendPhotos();
    if (list[0]) store.set("wib-friends-seen", list[0].createdAt);
    $("commFriendsDot").hidden = true; $("tabCommDot").hidden = true;
    renderBoard(b).catch(() => {});
    if (!links.following.length) {
      $("friendFeed").innerHTML = '<div class="note">No friends yet. Invite someone and you\'ll see each other\'s sunsets and sunrises here.</div>';
      return;
    }
    if (!list.length) { $("friendFeed").innerHTML = '<div class="note">Your friends haven\'t shared a photo yet.</div>'; return; }
    $("friendFeed").innerHTML = list.slice(0, 30).map(p => `
      <article class="ff-card">
        <button class="ff-img" data-id="${esc(p.id)}" aria-label="Open ${esc(nameOf(p.uid))}'s photo"><img alt="" data-id="${esc(p.id)}"></button>
        <div class="ff-body">
          <div class="ff-top"><div><b>${esc(nameOf(p.uid))}</b><br><small>${esc(p.place || "Somewhere")}</small><br>
            <small><i class="dot" style="background:${bandColour(p.band)}"></i>${p.kind === "sunset" ? "Sunset" : "Sunrise"} · ${esc(p.band)} · ${ago(p.createdAt)}</small></div>
            <button class="fire" data-id="${esc(p.id)}" aria-label="Send fire" aria-pressed="false">${FLAME}<span>…</span></button></div>
          ${p.status === "approved" ? "" : '<span class="ff-pending">Friends only until it is checked</span>'}
        </div>
      </article>`).join("");
    for (const img of $("friendFeed").querySelectorAll("img[data-id]")) {
      const p = list.find(x => x.id === img.dataset.id); b.url(p, true).then(u => { img.src = u; }).catch(() => {});
    }
    const me = (await b.whoami()).uid;
    for (const btn of $("friendFeed").querySelectorAll(".fire")) {
      b.fires(btn.dataset.id).then(who => setFire(btn, who.length, who.includes(me))).catch(() => setFire(btn, 0, false));
    }
    $("friendFeed").onclick = async ev => {
      const f = ev.target.closest(".fire");
      if (f) {
        const on = f.getAttribute("aria-pressed") !== "true", n = Number(f.dataset.n || 0);
        setFire(f, n + (on ? 1 : -1), on);
        try { await b.fire(f.dataset.id, on); } catch { setFire(f, n, !on); }
        return;
      }
      const im = ev.target.closest(".ff-img");
      if (im) { const p = list.find(x => x.id === im.dataset.id); if (p) openPhoto(p, nameOf(p.uid)); }
    };
  }
  function setFire(btn, n, mine) {
    btn.dataset.n = n; btn.setAttribute("aria-pressed", mine ? "true" : "false");
    btn.classList.toggle("on", mine); btn.querySelector("span").textContent = String(Math.max(0, n));
  }

  async function renderBoard(b) {
    const now = Date.now(), month = monthKey(now), last = prevMonthKey(now);
    const mine = await b.mine(), me = (await b.whoami()).uid;
    const people = [{ uid: me, name: "You", list: mine, me: true },
      ...links.following.map(u => ({ uid: u, name: nameOf(u), list: friendPhotos.get(u) || [] }))];
    const rows = leaderboard(people, month);
    $("lbList").innerHTML = rows.map((r, i) => `
      <div class="lb-row${r.me ? " me" : ""}"><span class="lb-rank">${i + 1}</span>${avatar(r.me ? myName || "You" : r.name, r.uid)}
        <span class="lb-name"><b>${esc(r.name)}</b><br><small>${r.photos} photo${r.photos === 1 ? "" : "s"}</small></span><span class="lb-pts">${r.pts}</span></div>`).join("");
    const prev = leaderboard(people, last).filter(r => r.pts > 0);
    $("lbLast").textContent = prev.length ? `Last month: ${prev[0].me ? "you" : prev[0].name} won with ${prev[0].pts} points.` : "";
  }

  /* ----- More: friends card ----- */
  async function renderCard() {
    $("friendsCard").hidden = false;
    let b; try { b = await load(true); } catch { msg("friendsMsg", "Couldn't load your friends right now."); return; }
    $("nickInput").value = myName;
    let reqs = []; try { reqs = await b.requests(); } catch { /* none */ }
    $("reqList").innerHTML = reqs.length ? `<h3 class="sub">Requests</h3>` + reqs.map(r => `
      <div class="fr-row">${avatar(r.name, r.follower)}<span class="fr-name"><b>${esc(r.name || "Someone")}</b><br><small>Wants to follow you</small></span>
        <span class="fr-actions"><button class="btn small" data-acc="${esc(r.id)}">Accept</button><button class="btn small ghost" data-dec="${esc(r.id)}">Decline</button></span></div>`).join("") : "";
    $("reqList").onclick = async ev => {
      const a = ev.target.closest("[data-acc]"), d = ev.target.closest("[data-dec]"), id = (a || d) && (a || d).dataset[a ? "acc" : "dec"];
      const r = reqs.find(x => x.id === id); if (!r) return;
      try { a ? await b.approve(r) : await b.decline(r); } catch { msg("friendsMsg", "Couldn't do that right now. Try again."); }
      renderCard();
    };
    const everyone = [...new Set([...links.following, ...links.followers])];
    $("friendList").innerHTML = everyone.length ? everyone.map(u => {
      const a = links.following.includes(u), c = links.followers.includes(u);
      const rel = a && c ? "Friends" : a ? "You follow" : "Follows you";
      const pts = a ? `${points(friendPhotos.get(u) || [], monthKey(Date.now()))} this month` : "";
      return `<div class="fr-row">${avatar(names[u], u)}<span class="fr-name"><b>${esc(nameOf(u))}</b><br><small>${rel}${pts ? " · " + pts : ""}</small></span>
        <button class="linkbtn" data-rm="${esc(u)}">Remove</button></div>`;
    }).join("") : '<div class="note">No friends yet.</div>';
    $("friendList").onclick = async ev => {
      const r = ev.target.closest("[data-rm]"); if (!r) return;
      if (!r.dataset.sure) { r.dataset.sure = "1"; r.textContent = "Tap to confirm"; return; }
      try { await b.unfriend(r.dataset.rm); } catch { /* ignore */ }
      renderCard();
    };
    try { $("googleLink").hidden = b.googleLinked(); $("googleDone").hidden = !b.googleLinked(); } catch { /* fake backend */ }
    renderAlertsState();
  }
  async function needName() {
    const n = $("nickInput").value.trim();
    if (!n) { msg("friendsMsg", "Add a nickname first, so friends know who you are."); $("nickInput").focus(); return null; }
    if (n !== myName) { await (await ensure()).setName(n.slice(0, 24)); myName = n.slice(0, 24); }
    return myName;
  }
  $("nickSave").addEventListener("click", async () => {
    try { if (await needName()) msg("friendsMsg", "Saved. Only your friends see it."); } catch { msg("friendsMsg", "Couldn't save right now."); }
  });
  async function shareLink(kind) {
    try {
      if (!(await needName())) return;
      const code = await (await ensure()).inviteCode(kind);
      const url = `${base()}?${kind === "friend" ? "f" : "follow"}=${code}`;
      const text = kind === "friend" ? `Be my friend on Sunscore and we'll see each other's sunsets and sunrises:` : `Follow my sunsets and sunrises on Sunscore:`;
      if (navigator.share) { try { await navigator.share({ title: "Sunscore", text, url }); msg("friendsMsg", "Link shared."); return; } catch (e) { if (e && e.name === "AbortError") return; } }
      try { await navigator.clipboard.writeText(`${text} ${url}`); msg("friendsMsg", "Link copied. Paste it into a message."); }
      catch { msg("friendsMsg", url); }
    } catch { msg("friendsMsg", "Couldn't make a link right now. Try again in a minute."); }
  }
  $("inviteFriend").addEventListener("click", () => shareLink("friend"));
  $("shareFollow").addEventListener("click", () => shareLink("follow"));
  $("friendsInvite2").addEventListener("click", () => { showTab("more"); setTimeout(() => $("friendsCard").scrollIntoView({ behavior: "smooth" }), 200); });
  $("googleLink").addEventListener("click", async () => {
    msg("googleMsg", "Opening Google…");
    try {
      const r = await (await ensure()).linkGoogle();
      msg("googleMsg", r === "switched" ? "Signed in to your existing Sunscore account." : "Done. Your friends and points now move with you.");
      $("googleLink").hidden = true; $("googleDone").hidden = false; load(true).catch(() => {});
    } catch (e) {
      msg("googleMsg", e && e.code === "auth/operation-not-allowed" ? "Google sign-in isn't switched on yet." : e && /popup/.test(e.code || "") ? "The sign-in window was closed. Try again." : "Couldn't sign in right now.");
    }
  });

  /* ----- invite links (?f=CODE or ?follow=CODE) ----- */
  async function handleInvite() {
    const q = new URLSearchParams(location.search), code = q.get("f") || q.get("follow");
    if (!code) return;
    history.replaceState(null, "", location.pathname);
    let b, inv;
    try { b = await ensure(); inv = await b.invite(code); } catch { inv = null; }
    if (!inv) return;
    const me = (await b.whoami()).uid;
    if (inv.uid === me) return;
    const friend = inv.kind === "friend", who = inv.name || "Someone";
    $("invTitle").textContent = friend ? `${who} invited you to be friends on Sunscore` : `Follow ${who} on Sunscore`;
    $("invText").textContent = friend ? "See each other's sunsets and sunrises, and get a nudge when one of you posts."
      : `${who} will be asked to accept. Then you'll see their sunsets and sunrises.`;
    $("invAccept").textContent = friend ? "Add friend" : "Ask to follow";
    try { $("invNick").value = (await b.profile()).name || ""; } catch { /* blank */ }
    msg("invMsg", "");
    $("inviteDlg").showModal();
    $("invAccept").onclick = async () => {
      const n = $("invNick").value.trim().slice(0, 24);
      if (!n) { msg("invMsg", "Add a nickname so they know who you are."); return; }
      $("invAccept").disabled = true;
      try {
        await b.setName(n); myName = n;
        if (friend) await b.acceptFriend(inv); else await b.requestFollow(inv, n);
        msg("invMsg", friend ? `You and ${who} are now friends.` : `Request sent to ${who}.`);
        loaded = null;
        setTimeout(() => { $("inviteDlg").close(); if (friend) { showTab("community"); ctx.selectFriends(); } }, 1400);
      } catch { $("invAccept").disabled = false; msg("invMsg", "Couldn't do that right now. Try again."); }
    };
  }
  $("invLater").addEventListener("click", () => $("inviteDlg").close());

  /* ----- Your score (More) ----- */
  async function renderScore() {
    $("scoreCard").hidden = false;
    let mine = [];
    try { mine = await (await ensure()).mine(); } catch { /* offline: ratings only */ }
    const log = logAll(), month = monthKey(Date.now());
    $("ptsTotal").textContent = points(mine);
    $("ptsMonth").textContent = `${points(mine, month)} this month`;
    const best = mine.filter(p => p.status === "approved").reduce((m, p) => Math.max(m, p.predicted || 0), 0);
    const streak = monthStreak(log);
    const stat = (v, l) => `<div class="stat"><b>${v}</b><small>${l}</small></div>`;
    $("statGrid").innerHTML = stat(log.length, "Skies rated") + stat(mine.length, "Photos shared")
      + stat(`${streak} month${streak === 1 ? "" : "s"}`, "In a row") + stat(best || "–", "Best catch");
    const got = earnedBadges(log, mine);
    $("badgeTitle").textContent = `Badges · ${got.size} of ${BADGES.length}`;
    $("badgeGrid").innerHTML = BADGES.map(([id, t, d]) => `
      <div class="badge${got.has(id) ? " got" : ""}"><span class="bmark" aria-hidden="true">${got.has(id) ? "✓" : ""}</span><b>${t}</b><small>${d}</small>
      <span class="visually-hidden">${got.has(id) ? "Earned" : "Not yet"}</span></div>`).join("");
  }

  /* ----- background friend alerts (Android, installed app) ----- */
  const FCFG = () => new URL("__friends-config", location.href).href;
  async function readWorkerConfig() { try { const r = await (await caches.open("wib-config")).match(FCFG()); return r ? await r.json() : null; } catch { return null; } }
  async function saveWorkerConfig(patch = {}) {
    const old = await readWorkerConfig(); if (!old && !patch.on) return;
    const b = await ensure(), creds = await b.workerCreds();
    const cfg = { ...(old || {}), ...patch, ...creds, following: links.following, names,
      seen: (old && old.seen) || Date.now(), fireCounts: (old && old.fireCounts) || {} };
    await (await caches.open("wib-config")).put(FCFG(), new Response(JSON.stringify(cfg), { headers: { "Content-Type": "application/json" } }));
  }
  async function renderAlertsState() {
    const c = await readWorkerConfig();
    $("faPhotos").checked = !!(c && c.on && c.photos); $("faFires").checked = !!(c && c.on && c.fires); $("faMonthly").checked = !!(c && c.on && c.monthly);
    if (!c) { $("faPhotos").checked = $("faFires").checked = $("faMonthly").checked = true; }
  }
  $("faSave").addEventListener("click", async () => {
    const want = { photos: $("faPhotos").checked, fires: $("faFires").checked, monthly: $("faMonthly").checked };
    const on = want.photos || want.fires || want.monthly;
    if (on) {
      const err = await ctx.enableBackground(3);
      if (err) { msg("faMsg", err); return; }
    }
    try { await load(); await saveWorkerConfig({ on, ...want }); msg("faMsg", on ? "Saved. Your phone checks a few times a day." : "Friends alerts are off."); }
    catch { msg("faMsg", "Couldn't save right now."); }
  });

  return { renderFeed, renderCard, renderScore, refreshDot, handleInvite, load };
}
