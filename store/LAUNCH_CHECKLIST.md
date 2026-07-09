# Park2Me — Launch Checklist

Everything needed to get Park2Me onto the App Store and Google Play. Items are
grouped by owner. **"✅ Done in code"** = already handled in the project.
**"➡️ You"** = requires your accounts, money, or hosting and can't be automated.

---

## 0. Already done in the project (for reference)

- ✅ Android Google Maps key wiring (`app.config.js` reads
  `GOOGLE_MAPS_ANDROID_API_KEY`).
- ✅ Production Convex isolated from preview builds (`eas.json`).
- ✅ First-run in-app safety disclaimer.
- ✅ Privacy Policy and Terms/Safety drafts (`store/` folder).
- ✅ App icons, splash, bundle IDs (`com.park2me.app`), location permission
  string.

---

## 1. Accounts & money (do first) — ➡️ You

- [ ] **Apple Developer Program** — enroll at developer.apple.com ($99/year).
- [ ] **Google Play Console** — register at play.google.com/console ($25 one-time).
- [ ] Decide the **legal publisher name** (individual or company) — it appears
      publicly and in the legal docs.
- [ ] Create a **dedicated support email** (e.g. support@park2me.app) instead of
      a personal inbox.

## 2. Google Maps API key (Android maps won't render without this) — ➡️ You

- [ ] In Google Cloud Console, create a project and enable the **Maps SDK for
      Android**.
- [ ] Create an **API key**, then restrict it to Android apps using your package
      name `com.park2me.app` and your app's signing SHA-1 certificate
      fingerprints (get these from `eas credentials`).
- [ ] Provide the key to the build (recommended as an EAS secret):
      ```
      eas secret:create --scope project --name GOOGLE_MAPS_ANDROID_API_KEY --value "AIza...yourkey"
      ```
  The app is already wired to pick it up. (iOS needs no key — it uses Apple Maps.)

## 3. Backend / Convex — ➡️ You (one command each)

- [ ] Confirm the **production** deployment is `pastel-ladybug-488` (in `eas.json`).
- [ ] Deploy the latest backend to production so the new functions
      (`getMyActiveSpot`, freshness fields, updated cron) exist there:
      ```
      npx convex deploy
      ```
- [ ] Run `npm install` once to sync `package-lock.json` after the removed
      Supabase dependency.

## 4. Host the legal pages (required by both stores) — ➡️ You

- [ ] Fill in the placeholders in `store/PRIVACY_POLICY.md` and
      `store/TERMS_AND_SAFETY.md` and have a lawyer review them.
- [ ] Publish both at public URLs (a simple free host like GitHub Pages, Netlify,
      or a one-page site works). You'll paste the **Privacy Policy URL** into both
      stores.
- [ ] Optional but recommended: link both from inside the app (I can add a
      Settings/About screen with these links — just ask).

## 5. Build the production apps — ➡️ You (EAS handles signing)

- [ ] Install EAS CLI and log in: `npm i -g eas-cli && eas login`.
- [ ] Android app bundle: `eas build --platform android --profile production`.
- [ ] iOS build: `eas build --platform ios --profile production`.
- [ ] (Optional) Submit via `eas submit` once store listings exist.

## 6. Test on real devices before submitting — ➡️ You

- [ ] Install the **preview** build on a physical iPhone and Android phone:
      `eas build --profile preview` for each platform.
- [ ] Verify: location permission prompt, map renders (especially Android),
      finding a spot, sharing a spot, in-app GPS, arrival feedback, cancel flow,
      and that your shared spot restores after force-quitting the app.
- [ ] Walk around outside to confirm the live location updates as you move.

## 7. App Store Connect listing (iOS) — ➡️ You

- [ ] Create the app record (bundle ID `com.park2me.app`).
- [ ] Fill: name, subtitle, description, keywords, category (**Navigation** or
      **Travel**), support URL, marketing URL, Privacy Policy URL.
      *(Draft copy in `store/STORE_LISTING.md`.)*
- [ ] Complete **App Privacy** questions — data-type cheat sheet is in
      `store/STORE_LISTING.md`.
- [ ] Upload **screenshots** (6.7" and 6.5" iPhone required; 5.5" optional).
- [ ] Set **age rating**, pricing (Free), and availability.
- [ ] Answer the **Location** usage review note: foreground-only, used to show
      and navigate to nearby parking.

## 8. Google Play listing (Android) — ➡️ You

- [ ] Create the app; set it as **Free**.
- [ ] Complete the **Data safety** form (cheat sheet in
      `store/STORE_LISTING.md`).
- [ ] Fill store listing: title, short + full description, app category
      (**Maps & Navigation**), contact email, Privacy Policy URL.
- [ ] Upload assets: **feature graphic (1024×500)**, phone screenshots, hi-res
      icon (512×512).
- [ ] Complete the **content rating** questionnaire.
- [ ] Provide a **Location permission declaration** (foreground use for core
      parking feature; no background location).
- [ ] Set up **Closed/Internal testing** first, then promote to Production.

## 9. Nice-to-have before or shortly after launch

- [ ] In-app **About/Settings** screen linking Privacy Policy & Terms (ask me).
- [ ] A basic **report a spot** affordance for abuse (ask me).
- [ ] Crash reporting (e.g. Sentry) to catch field issues.
- [ ] A landing website for the marketing URL.

---

### Fastest path to a first submission
1. Enroll in both developer programs (§1).
2. Create + restrict the Google Maps key and add the EAS secret (§2).
3. `npx convex deploy` to production (§3).
4. Host the Privacy Policy (§4).
5. Build production + test on real devices (§5–6).
6. Fill listings using `STORE_LISTING.md` and submit (§7–8).
