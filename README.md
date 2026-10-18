# SOS Tag — MVP (Cloudflare + Firebase)

Flow: sticker (QR + NFC, same link `https://YOURDOMAIN/s/CODE`) -> scan page -> `scan` function -> owner's public fields.
First scan of an unclaimed tag -> activation in `app.html?code=CODE`.

## Setup
1. Create a Firebase project (Blaze plan is required for Cloud Functions). Enable Authentication > Email/Password.
2. `firebase deploy --only functions,firestore:rules`
3. Put the deployed `scan` function URL in `public/s.html` (const API) and your web config in `public/app.html`.
4. Deploy `public/` to Cloudflare Pages (`_redirects` maps /s/CODE to s.html).
5. Make yourself admin with the Admin SDK: `admin.auth().setCustomUserClaims(uid, { admin: true })`, then call `generateBatch({count: 100, batch: "2026-10"})`.
6. Print each code as a QR of `https://YOURDOMAIN/s/CODE`, plus the code in plain text; write the same link to the NTAG213 and lock the tag.

## Not built yet
Rate limiting (add a Cloudflare rule on the scan path), SMS/location alerts to contacts, family profiles, Filipino translation, admin page, payments.
