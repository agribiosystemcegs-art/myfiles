# MyFiles

The DABE MyFiles app for iPhone (a home-screen app) and Android (the same app as an installable app file). It shows the
whole faculty portal or the whole student page, kept on the phone, so it opens at once and keeps working with no signal.
Changes go to Drive as soon as there is a connection. Students also get a scan button for class check-in.

- One app for everyone. After sign-in, MyFiles says who you are: faculty, custodians and signatories get the faculty
  portal, students get the student page. Both are the same pages as the web app, fetched from MyFiles and kept on the
  phone, so new MyFiles features reach the app without an app update.
- Local-first, like MyFiles Desktop: screens open from the phone and refresh in the background; attendance and class
  record edits are saved on the phone at once and sent to Drive a few seconds later (also after being offline).
- The status bar always says where your work is: "Saved to Drive, 9:14 AM", "Saved on this phone",
  "Offline: 3 changes waiting".
- No app store and no passwords in the app: Google sign-in with the CarSU account, or "Link with a code".

## Files

| File | What it is |
| --- | --- |
| `index.html`, `style.css` | The app around the page: sign-in, status bar, scan button, menu, camera (design v2, 1.2.0) |
| `fonts/Geist-Variable.woff2`, `LICENSES/Geist-OFL.txt` | Geist, the app's only font, bundled so it looks the same offline (SIL Open Font License 1.1) |
| `js/app.js` | The app: sign-in, the page in its frame, the status bar, the first-run warm-up, the menu |
| `js/shim.js` | The page's bridge: `google.script.run`, `google.script.url`, `google.script.history`, `window.MYFILES_APP` |
| `js/engine.js` | Local-first rules: read cache, outbox, appPatch, warm-up and background refresh, online and offline |
| `js/net.js` | Requests to MyFiles (the sign-in goes in the request body) |
| `js/store.js` | Storage on the phone (IndexedDB) |
| `js/sealed.js` | Sealed tests: answers kept on the phone, sealed with HMAC-SHA256 |
| `js/scan.js` | Class QR check-in: camera, queue, location at scan (from MyFiles Scan) |
| `js/lists.js`, `js/diff.js` | Which calls are reads, the warm-up list, edits as small changes (the same as MyFiles Desktop) |
| `config.js` | The settings to fill in once |
| `sw.js` | Service worker: the app and the portal's libraries kept for offline use |
| `manifest.webmanifest`, `icons/` | Name, colors and icons (the MyFiles Student icon) |
| `android/` | The Android app file kit: `twa-manifest.json` and `.well-known/assetlinks.json` templates |
| `vendor/jsQR.js`, `LICENSES/jsQR.txt` | jsQR 1.4.0 (Apache-2.0), the QR reader for iPhone |
| `js/push.js` | Phone notifications: Allow Notifications, Turn Off, quiet hours (the menu's Notifications) |
| `vendor/firebase-*-compat.js`, `LICENSES/firebase.txt` | Firebase JS SDK 10.14.1 (Apache-2.0), app and messaging, for the notification token |
| `Dockerfile`, `nginx.conf` | Optional: host it on the school server |

## 1. Fill in config.js

```js
var MYFILES_API = 'https://script.google.com/macros/s/AKfycb.../exec';
var GOOGLE_WEB_CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
var DOMAIN = 'carsu.edu.ph';
```

- `MYFILES_API`: the MyFiles web app link of the "Anyone" deployment (ends in `/exec`). It is the same link ExamViewer
  sync uses; MyFiles Faculty › Custodian › Setup shows it. The app talks to this address only.
- `GOOGLE_WEB_CLIENT_ID`: from step 2. It may stay `''`: the app then uses the one saved in MyFiles (Custodian › Setup ›
  MyFiles app). With neither, "Continue with Google" is hidden and everyone links the app with a code.
- `DEV_API`, `DEV_AS`: development only (see Development); leave them `''`.

After any later change to the app's files, bump `VERSION` in `sw.js` and `APP_VERSION` in `js/app.js` (the same value).
Phones get the new version the next time they open the app online.

## Design v2 (1.2.0)

The app's own screens (sign-in, Getting Ready with named steps, no connection, the status strip, the account sheet, My Scans,
location, the camera and the panel) follow the DABE MyFiles design v2: Geist only, neutral grays, hairlines, CarSU green.
Every action ends in the app's panel (a waiting ring, then Done, Saved on This Phone or Failed), and Sign Out, Remove
Everything and Discard ask first in that panel with a button that names the action (no browser confirm). The top bar with
the page title, term and bell, and the tab bar, belong to the MyFiles page inside the app.

## One top bar (1.2.1)

A MyFiles page from Redesign v2 Stage 7b shows where your work is in its own 52 px top bar (All Changes Saved, Saving,
Offline, Saved on Device, with Refresh) and says so to the app once it is drawn (`MYFILES_APP.ownStatus`, a `caps` request on
the page's port). The app then hides its 44 px strip, so there is one bar, and sends each new status to the page (`status`).
Tapping the chip opens the app's account sheet (`appUi('menu')`); Refresh applies a waiting update or syncs
(`appUi('refresh')`) and the page shows the result in its panel. An older page never announces and keeps the strip; a page
that has not announced 4 seconds after loading gets the strip back.

## The scan button on My Classes (1.2.2)

The green scan button shows only on the student's My Classes. A MyFiles student page from Redesign v2 Stage 7c says which tab
is on screen whenever it changes (`MYFILES_APP.pageTab`, a `tab` message on the page's port; the app accepts only the page's own
tab ids). It stays hidden under the test lock, as before. An older page never says its tab and keeps the button on every screen.

## Phone notifications (1.1.0)

MyFiles sends a notification to the phone for every new notice in the bell (Firebase Cloud Messaging; set up once in MyFiles
Custodian › Setup › Push Notifications, see `push-setup.md` in DABE-Redesign-v2). In the app: Me › Notifications › Allow
Notifications. The phone asks for permission only then, never when the app opens. The lock screen shows the notice's title and
a generic line; tapping it opens the app at the item and marks it read. While the app is open and in view, nothing pops up (the
bell has it). On iPhone and iPad it works only from the Home Screen app (iOS 16.4 or later). Signing out turns notifications
off for that phone. The service worker shows the notices itself; the Firebase SDK runs only in the app's window, to get the token.

## 2. The Google web client (for "Continue with Google")

1. Open console.cloud.google.com with the CarSU account that owns the MyFiles project (or any CarSU project).
2. APIs & Services › OAuth consent screen: User type Internal, app name "MyFiles", support e-mail; scopes: only
   `openid`, `email` and `profile` (the defaults).
3. APIs & Services › Credentials › Create credentials › OAuth client ID › Application type: Web application.
   Name it "MyFiles app".
4. Authorized JavaScript origins: the app's address, scheme and host only, for example `https://dabe-carsu.github.io`
   or `https://myfiles.carsu.edu.ph`. No redirect URIs are needed (the app asks only for an ID token).
5. Create, then copy the Client ID (it ends in `.apps.googleusercontent.com`) into `config.js` or into MyFiles
   (step 4).

MyFiles checks every ID token with Google (the client ID, a verified @carsu.edu.ph address, not expired). Custodians with an
account outside CarSU use "Link with a code".

## 3. Host it (HTTPS is required)

### a) GitHub Pages (free, HTTPS included)

1. Create a public repository, for example `myfiles`, and upload the contents of this folder (including `js/`,
   `icons/`, `vendor/`, `LICENSES/` and the empty `.nojekyll` file). Leave out `android/*.keystore` if you made one.
2. Settings › Pages › Deploy from a branch › `main`, folder `/ (root)` › Save.
3. After a minute the address appears, for example `https://dabe-carsu.github.io/myfiles/`.

### b) The school server

Any static web server with HTTPS works. Serve `sw.js`, `index.html`, `config.js` and `js/` with `Cache-Control: no-cache` so
updates reach phones. With Docker (nginx is included; put the school's HTTPS reverse proxy in front of it):

```sh
docker build -t myfiles-app .
docker run -d --restart unless-stopped -p 8080:80 --name myfiles-app myfiles-app
```

## 4. Tell MyFiles about the app (custodian)

MyFiles Faculty › Custodian › Setup › MyFiles app:

- Google web client ID: the Client ID from step 2 (kept as `APP_WEB_CLIENT_ID`; Google sign-in in the app is on only when
  it is set).
- App address: the address from step 3 (kept as `APP_URL`). The portal shows it to faculty and students, and the link codes
  carry it.

The "Anyone" deployment link must be set too (Setup › ExamViewer sync link): the app talks to that deployment.

## 5. Install

iPhone (Safari): open the app address, tap Share › Add to Home Screen › Add. Open MyFiles from the Home Screen.
Use Safari for this; the app then runs on its own like any other app.

Android (Chrome): open the app address and tap Install app (or ⋮ › Add to Home screen › Install). Or install the
Android app file the department shares (see "Make the Android app file").

### Sign in

- Continue with Google: the CarSU account. The app keeps you signed in and gets a new sign-in from Google by itself; if
  Google asks again, tap the status bar.
- Link with a code: on the MyFiles web page, students open Me › MyFiles Scan app › Link this phone's app; faculty open
  MyFiles on your phone › Make a link code. Scan the code shown there with the app (Link with a code › Scan the link code), or type its
  8 characters. A code works once, for 10 minutes. Links are listed (and removed) on the same web page.

The first time, the app shows "Getting your MyFiles ready…" with a progress bar while it fetches every main screen
once (faculty: the portal's screens of the current term and the attendance and class record of each class; students: the
first page, calendar, practice, messages, check-in, grades and each class). After that MyFiles opens at once.

## Offline

- Every screen opened before (and every main screen, see above) opens from the phone, also with no signal. Online, the
  screen shows at once and the newest data follows in the background; when a screen you are on changed, the status bar
  offers "Refresh" (it never redraws while you are typing or editing).
- The app refreshes the same screens every 10 minutes while online and each time it is opened, newest first.
- Attendance and class records: each change is saved on the phone at once ("Saved on this phone") and sent to Drive a
  few seconds later as a small change ("Saved to Drive, 9:14 AM"). Offline, changes wait ("Offline: 2 changes waiting")
  and are sent when the connection is back; MyFiles marks those check-in times as sent later. A cell also changed on
  another device is listed under Changed elsewhere too in the menu.
- Everything else (uploads, submitting, approving, signing) needs a connection; offline the app says so and nothing
  is half-saved.
- Class scans and sealed tests wait on the phone and are sent when there is a connection.
- Closing the app with changes not yet sent: the browser asks first where it can (Android, the browser tab). iPhone
  home-screen apps cannot ask; the changes stay on the phone and are sent the next time the app opens.

## Class check-in (students)

The round scan button opens the camera (BarcodeDetector on Android, jsQR on iPhone). A scan is saved on the phone at once
and sent with the student's own sign-in (`studentScanSync`); MyFiles decides everything (right class, right meeting,
the code's 30-second window, within 7 days). The result shows "You're checked in", "Checked in, late", "Waiting for your
instructor", "Not accepted" (with the reason) or "Saved. It will be sent when you're online." Menu › My scans lists them.

Location at scan works exactly as in MyFiles Scan: only when MyFiles checks location for the department (`loc` from
appHello), only after the one-time notice, one position at the moment of the scan, deleted from the phone as soon as
MyFiles answers. MyFiles keeps only "on campus" or "not on campus". Menu › Location at scan turns it off.

## Sealed tests (for the student page)

In the app the page gets `window.MYFILES_APP`:

| Call | What it does |
| --- | --- |
| `version` | The app version |
| `sealedStart(attId, payload)` | Keeps the test (`studentPracticeStart` with `{ sealed: true }`: questions and seal) on the phone |
| `sealedSave(attId, answers, { usedMs, leaveCount })` | Keeps the answers after each change |
| `sealedFinish(attId, { usedMs, leaveCount, finishedAt? })` | Seals `{ attId, answers, usedMs, leaveCount, finishedAt }` and returns `{ sealed, mac }` (HMAC-SHA256 hex with the seal, WebCrypto) |
| `sealedGet(attId)` | The kept questions and answers (never the seal) |
| `netLock(on)` | While on, every request of the page and of the app is refused before it leaves the phone |
| `monotonicMs()` | A clock that the phone's time setting cannot change |

The seal stays in the app's storage and is never given back to the page. A submit (`studentTestSubmitSealed`) that finds no
connection is kept and sent later; the page is told "Saved. Your answers are sealed on this phone and will be sent when
you're online." The app also counts the times it was left during a test (used only if the page sends no count).

## What the app keeps on the phone, and how to clear it

In the browser storage of the app (IndexedDB "myfiles-app" and the service worker's caches):

- The MyFiles page of your role, and the portal's libraries (pdf.js, MathJax, mammoth, SheetJS, qrcode-generator; each kept
  only when its SHA-256 matches the pinned one).
- A copy of the screens you opened and of the main screens, for your account only (kept up to 30 days after last use).
- Changes not yet in Drive, class scans until they are sent, sealed test answers until they are sent (at most 14 days).
- Your sign-in (a Google ID token, at most one hour old, or the phone's link token) and your name, e-mail and role.

To clear: Menu › Sign out removes your copy and your sign-in (it asks first when something has not been sent). Menu › What
MyFiles keeps on this phone › Remove everything from this phone removes all of it. Deleting the home-screen app (iPhone:
also Settings › Safari › Advanced › Website Data) or clearing Chrome's site data does the same.

## Make the Android app file

The Android app is the same web app wrapped as a Trusted Web Activity (it runs in Chrome, full screen). Make it once the
app has its HTTPS address. You need Node.js and a computer; Bubblewrap downloads the Java and Android tools it needs the
first time (about 1 GB).

1. Install Bubblewrap: `npm i -g @bubblewrap/cli`
2. In an empty folder: `bubblewrap init --manifest https://<host>/manifest.webmanifest` (for GitHub Pages
   `https://dabe-carsu.github.io/myfiles/manifest.webmanifest`). Answer with the values in `android/twa-manifest.json`
   (package `ph.edu.carsu.dabe.myfiles`, name MyFiles, theme #1D7A33). Let it create a signing key, and keep the key and its
   passwords safe: every later version must be signed with the same key.
3. `bubblewrap build`. It makes `app-release-signed.apk` (to share and install directly) and `app-release-bundle.aab`
   (for the Play Store, if ever), and prints the key's SHA-256 fingerprint (also: `keytool -list -v -keystore android.keystore`).
4. Put that fingerprint into `android/.well-known/assetlinks.json` and publish it at
   `https://<host>/.well-known/assetlinks.json` (the Dockerfile copies it there). On GitHub Pages it must be at the root
   of the domain: put it in the `<account>.github.io` repository (with `.nojekyll`), or use a custom domain. Without it the
   app still works but shows a browser address bar.
5. Share the `.apk`. On the phone: allow installing from that source when Android asks, then install. A new web version
   needs no new app file; only a change of name, icon or address does (raise `appVersionCode` and build again).

## Updating the app

Change the files, bump `VERSION` in `sw.js` and `APP_VERSION` in `js/app.js`, and upload. Phones get it the next time the
app is opened online; the status bar then offers "Refresh". The MyFiles pages themselves update by themselves
(the app compares the page's stamp with MyFiles at each start and every 30 minutes).

## Development

- Serve the folder: `python3 -m http.server 8798 --directory .` and open `http://localhost:8798/`.
- Dev mode (localhost only): `DEV_API = 'http://localhost:PORT/exec'` (the local simulator) and `DEV_AS = '<email>'` in
  `config.js`, or in the address: `?devapi=http://localhost:PORT/exec&as=<email>` (kept for that browser;
  `?devapi=off` ends it). "Continue as <email> (dev)" asks the simulator's `/run` for a link code
  (`facultyAppLink`, else `studentScanLink`) and links with it, so the real link-code sign-in is used. The simulator's
  `/run` must answer with CORS (or put a small CORS proxy in front of it).
- Going offline for a test: point `?devapi=` to a port where nothing listens.
- On localhost the page exposes `window.__scanTest(text)` (acts like a camera scan) and `window.__mfa` (the engine, the
  scanner, sealed tests, timings); the service worker loads the app's files from the network first.

## Privacy

What the app shows students: "This app reads class QR codes and, when you scan, checks whether you are on campus. It keeps
no exact location, contacts or photos."

The app talks only to the configured MyFiles address, to Google (sign-in) and to cdnjs or jsDelivr (the portal's
libraries, checked against pinned checksums). It sends your sign-in, the page's own requests, your class scans (with
the scan's position only when location checking is on and you allowed it) and sealed test answers. It never sends a seal,
contacts, photos or files you did not choose. MyFiles stores only a device name like "iPhone MyFiles app" for a linked phone.

## License note

jsQR 1.4.0 by the jsQR authors, Apache License 2.0: see `LICENSES/jsQR.txt`. Geist (Vercel, with basement.studio), SIL Open Font License 1.1: see `LICENSES/Geist-OFL.txt`. Icons: DABE-App-Icons (MyFiles Student).
