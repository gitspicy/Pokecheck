# Pokecheck (Android app)

A standalone Android app version of Pokecheck, packaged separately from the
web app in the repo root. It is **not** a wrapper around a hosted website -
`www/` is a self-contained copy of the same UI with the web app's PHP
calculator/search logic ported to plain JS (`www/pvp-engine.js`), reading
the same `data.json` and `/rankings` CSVs bundled inside the app itself. The
app makes no network calls at any point (no `INTERNET` permission is even
requested) and never touches the web app's `index.php`.

Everything here is a snapshot derived from the main repo's data/images at
the time it was built - if the web app's `data.json`, `rankings/`, or
`images/` change, re-copy them into `mobile-app/www/` to keep this app in
sync (there's no shared build step between the two; see "Updating" below).

## Getting the APK

This repo cannot compile Android apps itself (it has no access to Google's
SDK servers), so the actual build runs on GitHub's own infrastructure:

1. Push to any branch touching `mobile-app/**` triggers
   `.github/workflows/build-apk.yml` (or run it manually from the repo's
   **Actions** tab -> "Build Pokecheck APK" -> **Run workflow**).
2. Open the finished run and download the **pokecheck-debug-apk** artifact
   (a zip containing `app-debug.apk`).
3. Install it on an Android device/emulator with `adb install app-debug.apk`,
   or copy the APK to the device and open it directly (Android will prompt
   to allow installs from that source if it's not already allowed).

This is a **debug-signed** build, fine for installing and testing on your
own device, but not what you'd upload to the Play Store - that needs a
release keystore and a release build variant, which isn't set up here.

## Building locally instead

Needs Android Studio (or just a JDK 17 + Android SDK with platform 34 /
build-tools installed) and Node 18+:

```
cd mobile-app
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

## Updating the bundled data

```
cd mobile-app/www
cp ../../data.json .
cp -r ../../rankings .
rm -rf images && cp -r ../../images .
```

Then re-run the app or CI build - `www/script.js` and `www/pvp-engine.js`
are copies too, so if you change the web app's `script.js` you'll want to
manually re-apply the same edits here (`pvp-engine.js` only needs updating
if `index.php`'s calculation/lookup *logic* changes, not just its data).
