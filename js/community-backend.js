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
    async url(p, thumb = true) {
      if (thumb) return p.thumb || "";
      if (!fullCache.has(p.id)) fullCache.set(p.id, F.getDoc(F.doc(db, "images", p.id)).then(d => (d.exists() ? d.data().data : p.thumb || "")));
      return fullCache.get(p.id);
    },
  };
}
