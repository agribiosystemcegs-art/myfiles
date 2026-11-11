/*
 * MyFiles app settings. Fill these in once when you put the app on its web address (README, step 1).
 *
 * MYFILES_API: the DABE MyFiles web app link of the "Anyone" deployment, ending in /exec. It is the same link ExamViewer sync
 *   uses (MyFiles Faculty › Custodian › Setup shows it), for example 'https://script.google.com/macros/s/AKfycb.../exec'.
 *   The app talks to this address only. Left '', the first link QR code the phone scans sets it (a script.google.com .../exec
 *   address only) and the app keeps it; setting it here is safer.
 *
 * GOOGLE_WEB_CLIENT_ID: the OAuth web client of the Google Cloud project (README, step 2), ending in .apps.googleusercontent.com.
 *   Left '', the app uses the one saved in MyFiles (Custodian › Setup › MyFiles app); with neither, "Continue with Google" is
 *   hidden and people link the app with a code.
 *
 * DOMAIN: the school's Google domain (only these accounts sign in with Google).
 *
 * DEV_API, DEV_AS: development only, on localhost. DEV_API = 'http://localhost:PORT/exec' (the local simulator) and DEV_AS the
 *   e-mail to sign in as (or ?as=<email> in the app's address). Leave both '' everywhere else; they are ignored off localhost.
 *
 * After any change to the app's files, bump VERSION in sw.js and APP_VERSION in js/app.js (the same value).
 */
var MYFILES_API = 'https://script.google.com/macros/s/AKfycbyfcAekjzL9QlaX8Sl7w7Qbpj-CI9fERWAni_CoyA63sqCJlzaMiAtnNv4h9xjYSr5p/exec';
var GOOGLE_WEB_CLIENT_ID = '';
var DOMAIN = 'carsu.edu.ph';
var DEV_API = '';
var DEV_AS = '';
