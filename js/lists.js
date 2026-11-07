/*
 * MyFiles app: which page calls are reads (answered from this phone when needed), which reads are local-first, and which
 * saves go to the outbox. The faculty lists are those of MyFiles Desktop (lib/lists.js, from PortalScript.html and
 * ChairDelivery.html); the student lists are from StudentScript.html.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MFA_LISTS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Faculty: the big screen loads, answered at once from this phone and refreshed in the background.
  var FAC_FAST = [
    'portalGetData', 'portalCoursesData', 'portalFrData', 'portalCustData', 'portalTosData', 'portalKrData', 'portalKrLoad',
    'portalSylData', 'portalAttData', 'portalAttLoad', 'portalExcuseData', 'portalRbData', 'portalCalData', 'portalApvData',
    'deptDocsData', 'chairBoard', 'thesisBoot', 'facultyDeliveryData', 'chairDeliveryData', 'thesisPeerBoard', 'mandMine',
    'docTodo', 'portalCiData'
  ];
  // Reads whose success handler only stores the data and draws again, so a fresher answer may be handed to it a second time.
  var FAC_SAFE = [
    'portalCoursesData', 'portalFrData', 'portalTosData', 'portalKrData', 'portalSylData', 'portalAttData', 'portalExcuseData',
    'portalRbData', 'portalApvData', 'deptDocsData', 'chairBoard', 'thesisBoot', 'facultyDeliveryData', 'chairDeliveryData'
  ];
  // Every other faculty read: from MyFiles when online (and kept), from this phone when offline.
  var FAC_READS = FAC_FAST.concat([
    'portalPing', 'heroScene', 'seasonCal', 'portalCalHolidays', 'portalClaLoad', 'portalClassListLoad', 'portalCopInfo', 'portalCopSummary',
    'portalApvSummary', 'portalApvStatus', 'portalRbLoad', 'portalSigGet', 'portalSylLoad', 'portalSylRepo', 'portalTosLoad', 'portalTqLoad',
    'portalTqImgs', 'portalXvGet', 'portalXvInfo', 'portalXvDownloads', 'portalXvTqList', 'portalXvTqGet', 'deptDocData', 'deptDocGet',
    'deptDocPlaceInfo', 'myDraftsGet', 'portalManualFile', 'thesisBestData', 'portalStudentGateway', 'excLetter', 'excFile',
    'portalRbSignedGet', 'ccRulesGet', 'ccCampusGet'
  ]);

  // Students: the screens of the student page (StudentScript.html).
  var STU_FAST = [
    'appStudentState',      // the page's first state (what the web page injects for ?my)
    'studentGetHome',       // My Classes and the tabs (homeReload)
    'studentGetClass',      // one class (openClass)
    'studentPracticeList',  // Practice
    'studentExcuseData',    // excuse letters of a class
    'studentStanding',      // Grades
    'studentCalendar',      // Calendar
    'studentCheckins',      // messages from the instructors
    'studentAttNow',        // a class check-in open now
    'studentGradeCard',     // the grade card of a class
    'studentSigGet',        // the signature image
    'studentApptData',      // appointments
    'studentScanDevices',   // Me › linked phones
    'thesisBoot'            // My Documents
  ];
  var STU_SAFE = [];        // the student page draws a screen from each answer: a newer answer is offered with "Updated, refresh"
  var STU_READS = STU_FAST.concat(['studentPracticeReview', 'excLetter', 'thesisPdf', 'myDraftsGet', 'heroScene', 'seasonCal']);

  // Saved on this phone first and sent as patches (appPatch), faculty only.
  var LOCAL_SAVES = { portalAttSave: 'att', portalKrSave: 'kr' };
  var LOAD_OF = { att: 'portalAttLoad', kr: 'portalKrLoad' };
  var LIST_OF = { att: 'portalAttData', kr: 'portalKrData' };
  // Writes that do not change what the screens show (drafts, presence): they do not make the cache stale.
  var QUIET = ['myDraftsSave', 'portalPrepPing', 'portalLoadDraft', 'studentPracticeFocus'];

  // The warm-up: every main screen's data, fetched in appBatch calls of up to 25 after the first sign-in (and a role change), and
  // again in the background every 10 minutes and on each app open. Round 1 needs no answer first; round 2 and 3 use the answers
  // (the term the portal opens on, the classes of that term), as the pages themselves would call them.
  var FAC_WARM1 = ['portalGetData', 'portalRbData', 'portalApvData', 'deptDocsData', 'chairBoard', 'thesisBoot', 'thesisPeerBoard', 'mandMine', 'docTodo'];
  var FAC_WARM_TERM = ['portalCoursesData', 'portalFrData', 'portalCustData', 'portalTosData', 'portalKrData', 'portalSylData', 'portalAttData',
    'portalExcuseData', 'portalCalData', 'facultyDeliveryData', 'chairDeliveryData'];
  var STU_WARM1 = ['appStudentState', 'studentGetHome', 'studentCalendar', 'studentPracticeList', 'studentCheckins', 'studentAttNow',
    'studentStanding', 'studentSigGet', 'studentApptData', 'studentScanDevices', 'thesisBoot'];
  // The term the portal opens on: PortalScript defaultTerm() (the newest class's, else the first of the lists).
  function termOf(data) {
    if (!data) return null;
    var cl = data.classes || [], c = cl[cl.length - 1];
    var ay = c ? c.ay : (data.ayOptions || [])[0], term = c ? c.term : (data.termOptions || [])[0];
    return ay || term ? { ay: String(ay || ''), term: String(term || '') } : null;
  }
  // -> [{ fn, args }] for a round (1, 2 or 3), from what the cache holds now (get(fn, args) -> value or null)
  function warmPlan(role, round, get) {
    var out = [], add = function (fn, args) { out.push({ fn: fn, args: args || [] }); };
    if (role === 'student') {
      if (round === 1) STU_WARM1.forEach(function (fn) { add(fn); });
      if (round === 2) {
        var home = get('studentGetHome', []) || get('appStudentState', []) || {};
        (home.classes || []).forEach(function (c) { if (c && c.id) { add('studentGetClass', [c.id]); add('studentGradeCard', [c.id]); } });
      }
      return out;
    }
    if (round === 1) FAC_WARM1.forEach(function (fn) { add(fn); });
    var t = termOf(get('portalGetData', []));
    if (round === 2 && t) FAC_WARM_TERM.forEach(function (fn) { add(fn, [t.ay, t.term]); });
    if (round === 3 && t) {
      var seen = {};
      [['portalAttData', 'portalAttLoad'], ['portalKrData', 'portalKrLoad']].forEach(function (x) {
        var d = get(x[0], [t.ay, t.term]);
        ((d && d.classes) || []).forEach(function (c) { var id = c && c.classId; if (id && !seen[x[1] + id]) { seen[x[1] + id] = 1; add(x[1], [id]); } });
      });
    }
    return out;
  }

  function forRole(role) {
    var stu = role === 'student';
    return {
      fast: stu ? STU_FAST : FAC_FAST, safe: stu ? STU_SAFE : FAC_SAFE, reads: stu ? STU_READS : FAC_READS,
      localSaves: stu ? {} : LOCAL_SAVES, quiet: QUIET
    };
  }

  return { FAC_WARM1: FAC_WARM1, FAC_WARM_TERM: FAC_WARM_TERM, STU_WARM1: STU_WARM1, FAC_FAST: FAC_FAST, FAC_SAFE: FAC_SAFE, FAC_READS: FAC_READS, STU_FAST: STU_FAST, STU_SAFE: STU_SAFE, STU_READS: STU_READS,
    LOCAL_SAVES: LOCAL_SAVES, LOAD_OF: LOAD_OF, LIST_OF: LIST_OF, QUIET: QUIET, forRole: forRole, warmPlan: warmPlan, termOf: termOf };
});
