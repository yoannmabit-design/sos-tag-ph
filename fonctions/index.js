const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;
setGlobalOptions({ region: "asia-southeast1", maxInstances: 20 });

const SEMAPHORE_KEY = defineSecret("SEMAPHORE_API_KEY");
const SMS_SENDER = defineString("SMS_SENDER", { default: "SEMAPHORE" });
const THROTTLE_MS = 2 * 60 * 1000; // one location report per sticker every 2 minutes

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

const normPhone = (p) => String(p || "").replace(/\D/g, "");

const sendSms = async (number, message) => {
  const body = new URLSearchParams({
    apikey: SEMAPHORE_KEY.value(),
    number,
    message,
    sendername: SMS_SENDER.value(),
  });
  const r = await fetch("https://api.semaphore.co/api/v4/messages", { method: "POST", body });
  if (!r.ok) throw new Error("SMS failed: " + r.status);
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
  const pub = prof.exists ? prof.data().public || {} : {};
  const out = { ...pub };
  if (!pub.showInsurer) { delete out.insurer; delete out.insurerNo; }
  delete out.showInsurer;
  res.json({ status: "active", profile: out });
});

// Public: the scanner's phone sends its GPS position; contacts and owner are alerted by SMS.
exports.reportLocation = onRequest({ cors: true, secrets: [SEMAPHORE_KEY] }, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ status: "error" });
  const b = req.body || {};
  const code = String(b.code || "").toUpperCase();
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  const acc = Math.round(Number(b.accuracy) || 0);
  if (!CODE_RE.test(code) || !Number.isFinite(lat) || !Number.isFinite(lng) ||
      Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ status: "invalid" });
  }

  const sref = db.doc(`stickers/${code}`);
  const snap = await sref.get();
  if (!snap.exists || snap.data().status !== "active") return res.status(404).json({ status: "invalid" });
  const s = snap.data();

  const last = s.lastReportAt ? s.lastReportAt.toMillis() : 0;
  if (Date.now() - last < THROTTLE_MS) return res.json({ status: "throttled" });
  await sref.update({ lastReportAt: FieldValue.serverTimestamp() });

  const prof = await db.doc(`profiles/${s.profileId}`).get();
  const pd = prof.exists ? prof.data() : {};
  const name = (pd.public && pd.public.name) || "A person";

  await db.collection("locations").add({
    code,
    ownerUid: s.ownerUid,
    lat,
    lng,
    accuracy: acc,
    ts: FieldValue.serverTimestamp(),
    ua: String(req.get("user-agent") || "").slice(0, 120),
  });

  const numbers = new Set();
  ((pd.public && pd.public.contacts) || []).forEach((c) => numbers.add(normPhone(c.phone)));
  numbers.add(normPhone(pd.ownerPhone));
  const targets = [...numbers].filter((n) => n.length >= 10);

  const message =
    `SOS Tag: ${name} may need help. Location from the person who scanned the tag: ` +
    `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)} (+/-${acc}m). Call 911 if urgent.`;

  const results = await Promise.allSettled(targets.map((n) => sendSms(n, message)));
  const sent = results.filter((r) => r.status === "fulfilled").length;
  return res.json({ status: "sent", sent });
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
      if (s.data().ownerUid === uid) return;
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

// Right to erasure: profile, scan history, location history and auth account.
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
      lastReportAt: FieldValue.delete(),
    })
  );
  await b.commit();
  await del(db.collection("scans").where("ownerUid", "==", uid));
  await del(db.collection("locations").where("ownerUid", "==", uid));
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
