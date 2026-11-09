// Firebase adapter for the Community tab. Everything Firebase-specific lives here, so the UI can be
// tested against an in-memory fake (window.__SUNSCORE_FAKE_BACKEND) with the same methods.
const V = "10.12.2"; // pinned Firebase JS SDK, loaded from Google's CDN only when Community is on
const sdk = name => import(`https://www.gstatic.com/firebasejs/${V}/firebase-${name}.js`);

export async function createBackend(config) {
  if (window.__SUNSCORE_FAKE_BACKEND) return window.__SUNSCORE_FAKE_BACKEND();
  const [{ initializeApp }, A, F, S] = await Promise.all([sdk("app"), sdk("auth"), sdk("firestore"), sdk("storage")]);
  const app = initializeApp(config);
  const auth = A.getAuth(app), db = F.getFirestore(app), st = S.getStorage(app);
  const user = auth.currentUser || (await A.signInAnonymously(auth)).user;
  const uid = user.uid;
  let admin = false;
  try { admin = (await F.getDoc(F.doc(db, "admins", uid))).exists(); } catch { admin = false; }
  const asList = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const ms = x => (x && x.toMillis ? x.toMillis() : x || 0);
  const sortNew = list => list.map(p => ({ ...p, createdAt: ms(p.createdAt) })).sort((a, b) => b.createdAt - a.createdAt);
  const urlCache = new Map();
  return {
    uid, isAdmin: () => admin,
    /** Upload the photo and its thumbnail, then the record (status "pending"). */
    async upload({ id, full, thumb, meta }) {
      const base = `photos/${uid}/${id}`;
      await S.uploadBytes(S.ref(st, base + ".jpg"), full, { contentType: "image/jpeg" });
      await S.uploadBytes(S.ref(st, base + "_t.jpg"), thumb, { contentType: "image/jpeg" });
      await F.setDoc(F.doc(db, "photos", id), { ...meta, uid, status: "pending", path: base, createdAt: F.serverTimestamp() });
    },
    /** Approved photos, newest first (single-field query: no composite index needed). */
    async feed() { return sortNew(asList(await F.getDocs(F.query(F.collection(db, "photos"), F.where("status", "==", "approved"), F.limit(500))))); },
    async mine() { return sortNew(asList(await F.getDocs(F.query(F.collection(db, "photos"), F.where("uid", "==", uid))))); },
    async pending() { return sortNew(asList(await F.getDocs(F.query(F.collection(db, "photos"), F.where("status", "==", "pending"), F.limit(100))))); },
    async reports() { return asList(await F.getDocs(F.collection(db, "reports"))); },
    async setStatus(id, status) { await F.updateDoc(F.doc(db, "photos", id), { status, reviewedAt: F.serverTimestamp() }); },
    async remove(p) {
      for (const suffix of [".jpg", "_t.jpg"]) { try { await S.deleteObject(S.ref(st, p.path + suffix)); } catch { /* already gone */ } }
      await F.deleteDoc(F.doc(db, "photos", p.id));
    },
    async report(id, reason) { await F.addDoc(F.collection(db, "reports"), { photo: id, reason, by: uid, at: F.serverTimestamp() }); },
    async url(p, thumb = true) {
      const key = p.path + (thumb ? "_t" : "");
      if (!urlCache.has(key)) urlCache.set(key, S.getDownloadURL(S.ref(st, p.path + (thumb ? "_t.jpg" : ".jpg"))));
      return urlCache.get(key);
    },
  };
}
