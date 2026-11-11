// Firebase adapter for the Community tab. Everything Firebase-specific lives here, so the UI can be
// tested against an in-memory fake (window.__SUNSCORE_FAKE_BACKEND) with the same methods.
// Free (Spark) plan: no Cloud Storage, so the small thumbnail sits inside the photo record and the
// full picture in its own record (images/{id}), both as JPEG data URLs.
const V = "10.12.2"; // pinned Firebase JS SDK, loaded from Google's CDN only when Community is on
const sdk = name => import(`https://www.gstatic.com/firebasejs/${V}/firebase-${name}.js`);
const dataUrl = blob => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(blob); });

export async function createBackend(config) {
  if (window.__SUNSCORE_FAKE_BACKEND) return window.__SUNSCORE_FAKE_BACKEND();
  const [{ initializeApp }, A, F] = await Promise.all([sdk("app"), sdk("auth"), sdk("firestore")]);
  const app = initializeApp(config);
  const auth = A.getAuth(app), db = F.getFirestore(app);
  // Sign-in runs in the background: approved photos are public, so the map never waits for it.
  let me = null;
  const signIn = () => me || (me = (async () => {
    await new Promise(ok => { const off = A.onAuthStateChanged(auth, () => { off(); ok(); }); }); // wait for the saved sign-in, so the ID stays the same
    const uid = (auth.currentUser || (await A.signInAnonymously(auth)).user).uid;
    let admin = false;
    try { admin = (await F.getDoc(F.doc(db, "admins", uid))).exists(); } catch { admin = false; }
    return { uid, admin };
  })().catch(e => { me = null; throw e; }));
  signIn().catch(() => {});
  const uidNow = async () => (await signIn()).uid;
  const asList = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const ms = x => (x && x.toMillis ? x.toMillis() : x || 0);
  const sortNew = list => list.map(p => ({ ...p, createdAt: ms(p.createdAt) })).sort((a, b) => b.createdAt - a.createdAt);
  const fullCache = new Map();
  return {
    whoami: signIn,
    /** Save the full picture, then the record with its thumbnail (status "pending"). */
    async upload({ id, full, thumb, meta }) {
      const uid = await uidNow();
      const [fullData, thumbData] = await Promise.all([dataUrl(full), dataUrl(thumb)]);
      await F.setDoc(F.doc(db, "images", id), { uid, data: fullData });
      await F.setDoc(F.doc(db, "photos", id), { ...meta, uid, status: "pending", thumb: thumbData, createdAt: F.serverTimestamp() });
    },
    /** Approved photos, newest first (single-field query: no composite index needed). */
    async feed() { return sortNew(asList(await F.getDocs(F.query(F.collection(db, "photos"), F.where("status", "==", "approved"), F.limit(300))))); },
    async mine() { const uid = await uidNow(); return sortNew(asList(await F.getDocs(F.query(F.collection(db, "photos"), F.where("uid", "==", uid))))); },
    async pending() { await signIn(); return sortNew(asList(await F.getDocs(F.query(F.collection(db, "photos"), F.where("status", "==", "pending"), F.limit(100))))); },
    async reports() { await signIn(); return asList(await F.getDocs(F.collection(db, "reports"))); },
    async setStatus(id, status) { await signIn(); await F.updateDoc(F.doc(db, "photos", id), { status, reviewedAt: F.serverTimestamp() }); },
    async remove(p) {
      await signIn();
      try { await F.deleteDoc(F.doc(db, "images", p.id)); } catch { /* already gone */ }
      await F.deleteDoc(F.doc(db, "photos", p.id));
    },
    async report(id, reason) { const uid = await uidNow(); await F.addDoc(F.collection(db, "reports"), { photo: id, reason, by: uid, at: F.serverTimestamp() }); },
    /* ---------- friends ---------- */
    async profile() { const uid = await uidNow(); const d = await F.getDoc(F.doc(db, "users", uid)); return d.exists() ? d.data() : {}; },
    /** Save my nickname (and keep it on my invite links). */
    async setName(name) {
      const uid = await uidNow(), prof = await this.profile();
      await F.setDoc(F.doc(db, "users", uid), { name, codes: prof.codes || {}, at: F.serverTimestamp() });
      for (const code of Object.values(prof.codes || {})) { try { await F.updateDoc(F.doc(db, "invites", code), { name }); } catch { /* gone */ } }
    },
    /** My reusable link code for "friend" (both ways) or "follow" (they ask, I accept). */
    async inviteCode(kind) {
      const uid = await uidNow(), prof = await this.profile(), codes = prof.codes || {};
      if (codes[kind]) return codes[kind];
      const code = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => (b % 36).toString(36)).join("");
      await F.setDoc(F.doc(db, "invites", code), { uid, kind, name: prof.name || "", at: F.serverTimestamp() });
      await F.setDoc(F.doc(db, "users", uid), { name: prof.name || "", codes: { ...codes, [kind]: code }, at: F.serverTimestamp() });
      return code;
    },
    async invite(code) { await signIn(); const d = await F.getDoc(F.doc(db, "invites", code)); return d.exists() ? { code, ...d.data() } : null; },
    /** Accept a friend link: both people follow each other. */
    async acceptFriend(inv) {
      const uid = await uidNow(), b = F.writeBatch(db), at = F.serverTimestamp();
      b.set(F.doc(db, "follows", `${uid}_${inv.uid}`), { follower: uid, target: inv.uid, via: inv.code, at });
      b.set(F.doc(db, "follows", `${inv.uid}_${uid}`), { follower: inv.uid, target: uid, via: inv.code, at });
      await b.commit();
    },
    async requestFollow(inv, name) {
      const uid = await uidNow();
      await F.setDoc(F.doc(db, "requests", `${uid}_${inv.uid}`), { follower: uid, target: inv.uid, name, via: inv.code, at: F.serverTimestamp() });
    },
    async requests() { const uid = await uidNow(); return asList(await F.getDocs(F.query(F.collection(db, "requests"), F.where("target", "==", uid)))); },
    async approve(r) {
      const uid = await uidNow();
      await F.setDoc(F.doc(db, "follows", `${r.follower}_${uid}`), { follower: r.follower, target: uid, via: "request", at: F.serverTimestamp() });
      await F.deleteDoc(F.doc(db, "requests", r.id));
    },
    async decline(r) { await signIn(); await F.deleteDoc(F.doc(db, "requests", r.id)); },
    /** People I follow and people who follow me (user IDs). */
    async links() {
      const uid = await uidNow();
      const [a, b] = await Promise.all([
        F.getDocs(F.query(F.collection(db, "follows"), F.where("follower", "==", uid))),
        F.getDocs(F.query(F.collection(db, "follows"), F.where("target", "==", uid)))]);
      return { following: a.docs.map(d => d.data().target), followers: b.docs.map(d => d.data().follower) };
    },
    async names(uids) {
      await signIn();
      const out = {};
      await Promise.all(uids.map(async u => { try { const d = await F.getDoc(F.doc(db, "users", u)); out[u] = d.exists() ? d.data().name || "" : ""; } catch { out[u] = ""; } }));
      return out;
    },
    async unfriend(other) {
      const uid = await uidNow();
      for (const id of [`${uid}_${other}`, `${other}_${uid}`]) { try { await F.deleteDoc(F.doc(db, "follows", id)); } catch { /* not there */ } }
    },
    /** A friend's photos, including ones not yet checked (friends see them straight away). */
    async photosOf(other) {
      await signIn();
      const q = w => F.getDocs(F.query(F.collection(db, "photos"), ...w, F.limit(60)));
      let snap;
      try { snap = await q([F.where("uid", "==", other)]); }
      catch { snap = await q([F.where("uid", "==", other), F.where("status", "==", "approved")]); }
      return sortNew(asList(snap)).filter(p => p.status !== "rejected");
    },
    async fires(photoId) { await signIn(); return (await F.getDocs(F.collection(db, "photos", photoId, "fires"))).docs.map(d => d.id); },
    async fire(photoId, on) {
      const uid = await uidNow(), ref = F.doc(db, "photos", photoId, "fires", uid);
      if (on) await F.setDoc(ref, { at: F.serverTimestamp() }); else await F.deleteDoc(ref);
    },
    /** Keep friends and points on a new phone: link this anonymous account to Google. */
    async linkGoogle() {
      await signIn();
      const provider = new A.GoogleAuthProvider();
      try { await A.linkWithPopup(auth.currentUser, provider); return "linked"; }
      catch (e) {
        if (e && e.code === "auth/credential-already-in-use") {
          const cred = A.GoogleAuthProvider.credentialFromError(e);
          if (cred) { await A.signInWithCredential(auth, cred); me = null; await signIn(); return "switched"; }
        }
        throw e;
      }
    },
    googleLinked() { const u = auth.currentUser; return !!(u && u.providerData.some(p => p.providerId === "google.com")); },
    /** What the background worker needs to check for friends' photos without the Firebase SDK. */
    async workerCreds() {
      const uid = await uidNow();
      return { uid, apiKey: config.apiKey, projectId: config.projectId, refreshToken: auth.currentUser.refreshToken };
    },
    async url(p, thumb = true) {
      if (thumb) return p.thumb || "";
      if (!fullCache.has(p.id)) fullCache.set(p.id, F.getDoc(F.doc(db, "images", p.id)).then(d => (d.exists() ? d.data().data : p.thumb || "")));
      return fullCache.get(p.id);
    },
  };
}
