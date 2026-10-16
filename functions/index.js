const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;
setGlobalOptions({ region: "asia-southeast1", maxInstances: 20 });

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_RE = /^[2-9A-HJKMNP-Z]{12}$/;

const newCode = () => {
  let out = "";
  while (out.length < 12) {
    const b = crypto.randomBytes(1)[0];
    if (b < 248) out += ALPHABET[b % 31];
  }
  return out;
};

const needAuth = (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return req.auth.uid;
};

// Public: what a first responder sees after scanning.
exports.scan = onRequest({ cors: true }, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const code = String(req.query.code || "").toUpperCase();
  if (!CODE_RE.test(code)) return res.status(404).json({ status: "invalid" });
  const snap = await db.doc(`stickers/${code}`).get();
  if (!snap.exists) return res.status(404).json({ status: "invalid" });
  const s = snap.data();
  if (s.status !== "active") return res.json({ status: s.status });
  const prof = await db.doc(`profiles/${s.profileId}`).get();
  await db.collection("scans").add({
    code,
    ownerUid: s.ownerUid,
    ts: FieldValue.serverTimestamp(),
    ua: String(req.get("user-agent") || "").slice(0, 120),
  });
  res.json({ status: "active", profile: prof.exists ? prof.data().public || {} : {} });
});

// Owner links a sticker to their profile.
exports.claimSticker = onCall(async (req) => {
  const uid = needAuth(req);
  const code = String(req.data.code || "").toUpperCase();
  if (!CODE_RE.test(code)) throw new HttpsError("invalid-argument", "Invalid code.");
  const sref = db.doc(`stickers/${code}`);
  await db.runTransaction(async (t) => {
    const s = await t.get(sref);
    const p = await t.get(db.doc(`profiles/${uid}`));
    if (!s.exists) throw new HttpsError("not-found", "Unknown code.");
    if (s.data().status !== "unclaimed") {
      if (s.data().ownerUid === uid) return; // already linked to this owner
      throw new HttpsError("failed-precondition", "Tag already activated.");
    }
    if (!p.exists) throw new HttpsError("failed-precondition", "Save your profile first.");
    t.update(sref, { status: "active", ownerUid: uid, profileId: uid, claimedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

// Owner marks a tag lost (blocked) or active again.
exports.setStickerStatus = onCall(async (req) => {
  const uid = needAuth(req);
  const code = String(req.data.code || "").toUpperCase();
  const status = req.data.status;
  if (!CODE_RE.test(code) || !["active", "blocked"].includes(status)) {
    throw new HttpsError("invalid-argument", "Bad request.");
  }
  const ref = db.doc(`stickers/${code}`);
  const s = await ref.get();
  if (!s.exists || s.data().ownerUid !== uid) throw new HttpsError("permission-denied", "Not your tag.");
  await ref.update({ status });
  return { ok: true };
});

// Right to erasure: profile, scan history and auth account.
// Stickers are unlinked (back to "unclaimed"), not deleted.
exports.deleteAccount = onCall(async (req) => {
  const uid = needAuth(req);
  const del = async (query) => {
    for (;;) {
      const snap = await query.limit(400).get();
      if (snap.empty) break;
      const b = db.batch();
      snap.docs.forEach((d) => b.delete(d.ref));
      await b.commit();
    }
  };
  const stickers = await db.collection("stickers").where("ownerUid", "==", uid).get();
  const b = db.batch();
  stickers.docs.forEach((d) =>
    b.update(d.ref, {
      status: "unclaimed",
      ownerUid: FieldValue.delete(),
      profileId: FieldValue.delete(),
      claimedAt: FieldValue.delete(),
    })
  );
  await b.commit();
  await del(db.collection("scans").where("ownerUid", "==", uid));
  await db.doc(`profiles/${uid}`).delete();
  await admin.auth().deleteUser(uid);
  return { ok: true };
});

// Admin only: create unclaimed codes for a print run.
exports.generateBatch = onCall(async (req) => {
  if (!req.auth || req.auth.token.admin !== true) throw new HttpsError("permission-denied", "Admins only.");
  const n = Math.min(Number(req.data.count) || 0, 500);
  const batch = String(req.data.batch || "batch").slice(0, 40);
  const codes = Array.from({ length: n }, newCode);
  const wb = db.batch();
  codes.forEach((c) =>
    wb.create(db.doc(`stickers/${c}`), { status: "unclaimed", batch, createdAt: FieldValue.serverTimestamp() })
  );
  await wb.commit();
  return { codes };
});
