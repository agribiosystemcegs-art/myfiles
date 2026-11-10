/*
 * MyFiles app: the development server. It serves this folder on this computer only (127.0.0.1), for work with the local
 * simulator (README, "Development").
 *
 *   node dev/serve.js            http://localhost:8798/
 *   node dev/serve.js 8801       another port
 *
 * Why not any static server: the pages' content security policy (the meta tag in index.html and test.html) names no localhost
 * address, so the published app can never talk to a program listening on the phone or computer. The simulator is such a
 * program, on another port. This server adds "http://localhost:* http://127.0.0.1:*" to connect-src in the copy of the two
 * pages it sends, and nowhere else: the files on disk, and so the published app, stay strict.
 * Nothing is cached (Cache-Control: no-store). No dependencies.
 */
'use strict';
var http = require('http'), fs = require('fs'), path = require('path');

var ROOT = path.resolve(__dirname, '..');
var PORT = Number(process.argv[2] || process.env.PORT || 8798);
var HOST = '127.0.0.1';
var DEV_CONNECT = " http://localhost:* http://127.0.0.1:*";
var TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

// The page as sent in development: the same file, with the simulator's addresses allowed in connect-src.
function devPage(html) {
  var done = false;
  var out = html.replace(/(<meta http-equiv="Content-Security-Policy" content="[^"]*?connect-src 'self')/, function (m) { done = true; return m + DEV_CONNECT; });
  if (!done) console.warn('dev/serve.js: no connect-src found in the page policy; the simulator will be blocked.');
  return out;
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

var server = http.createServer(function (req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Only GET.');
  var p;
  try { p = decodeURIComponent(String(req.url).split('?')[0].split('#')[0]); } catch (e) { return send(res, 400, 'text/plain; charset=utf-8', 'Bad address.'); }
  if (p.charAt(p.length - 1) === '/') p += 'index.html';
  var file = path.resolve(ROOT, '.' + path.posix.normalize('/' + p));
  // this folder only, and none of its hidden files (.git)
  if (file !== ROOT && file.indexOf(ROOT + path.sep) !== 0) return send(res, 404, 'text/plain; charset=utf-8', 'Not found.');
  if (path.relative(ROOT, file).split(path.sep).some(function (s) { return s.charAt(0) === '.' && s !== '.well-known'; })) return send(res, 404, 'text/plain; charset=utf-8', 'Not found.');
  fs.readFile(file, function (err, buf) {
    if (err) return send(res, 404, 'text/plain; charset=utf-8', 'Not found.');
    var rel = path.relative(ROOT, file), type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (rel === 'index.html' || rel === 'test.html') buf = Buffer.from(devPage(buf.toString('utf8')), 'utf8');
    send(res, 200, type, req.method === 'HEAD' ? '' : buf);
  });
});
server.on('error', function (e) { console.error('dev/serve.js: ' + (e && e.message)); process.exit(1); });
server.listen(PORT, HOST, function () { console.log('MyFiles app (development) at http://localhost:' + PORT + '/  (this computer only)'); });
