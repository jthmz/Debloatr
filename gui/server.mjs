#!/usr/bin/env node
// MAXAPACITY Debloat: a window onto debloat.sh, in the browser.
//
//   node gui/server.mjs                   start it and open the page
//   node gui/server.mjs --no-open         start it without opening a browser
//   node gui/server.mjs --window          open it in its own window when a
//                                         Chromium-family browser is installed
//   node gui/server.mjs --exit-when-idle  stop by itself once the page has
//                                         been closed for a while
//   node gui/server.mjs --background      start as a process of its own and
//                                         return at once (the Mac app uses
//                                         this with the two above)
//
// This is a thin shell. Every read and every change goes through debloat.sh,
// so the page can do nothing the command line cannot, and the safety rules
// (protected packages, verification, the change log) live in one place.
//
// It listens on this computer only. The page it serves can remove apps from
// the phone, so no other page may be allowed to talk to it:
//   - every /api request must carry a token that only the served page knows;
//   - the Host header must be this server's own address, which stops another
//     site from reaching it by pointing a domain name at 127.0.0.1.
//
// No dependencies; Node 18 or newer.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'debloat.sh');
const PAGE = path.join(HERE, 'ui.html');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const TOKEN = crypto.randomBytes(24).toString('hex');
// The tool's version, which is the app's: read from debloat.sh so that there
// is one place it is written.
const VERSION = (() => {
  try {
    return /^VERSION="([^"]+)"$/m.exec(fs.readFileSync(TOOL, 'utf8'))[1];
  } catch (e) {
    return '';
  }
})();
const FIRST_PORT = Number(process.env.DEBLOAT_GUI_PORT) || 8792;
const OPEN_BROWSER = !process.argv.includes('--no-open');
const OWN_WINDOW = process.argv.includes('--window');
const EXIT_WHEN_IDLE = process.argv.includes('--exit-when-idle');
// How long an --exit-when-idle server waits, with no page connected and
// nothing asked of it, before it stops; and how long it waits at the start
// for the first page to arrive.
const IDLE_MS = Number(process.env.DEBLOAT_GUI_IDLE_MS) || 15000;
const START_GRACE_MS = Number(process.env.DEBLOAT_GUI_GRACE_MS) || 90000;

// --background: hand over to a copy of this program that runs on its own, and
// finish. The Mac app starts that way so that macOS sees the app as closed
// while its window is open; opening the app a second time then runs it a
// second time, and that run brings up a window on the helper already there.
//
// It finishes only once the copy says a window is on its way, by writing the
// file named in DEBLOAT_GUI_READY_FILE, and with status 1 if the copy stops
// before saying so. That is how the app can tell the user that it could not
// start, instead of doing nothing at all.
if (process.argv.includes('--background')) {
  const args = process.argv.slice(1).filter(arg => arg !== '--background');
  const ready = path.join(os.tmpdir(), `debloat-ready-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, DEBLOAT_GUI_READY_FILE: ready },
  });
  const finish = () => {
    const up = fs.existsSync(ready);
    fs.rmSync(ready, { force: true });
    process.exit(up ? 0 : 1);
  };
  const started = Date.now();
  child.on('error', finish);
  child.on('exit', finish);
  setInterval(() => {
    if (fs.existsSync(ready)) child.unref();
    if (fs.existsSync(ready) || Date.now() - started > 20000) finish();
  }, 50);
  await new Promise(() => {});      // the timer and the handlers above end this process
}

// Tells a --background starter, if there is one, that a window is coming.
function sayReady(address) {
  const file = process.env.DEBLOAT_GUI_READY_FILE;
  if (!file) return;
  try {
    fs.writeFileSync(file, `${address}\n`);
  } catch (e) {
    // The starter will give up waiting and say that this could not start.
  }
}

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;
const ACTIONS = new Set(['remove', 'mute', 'restore']);
const LISTS = ['back', 'remove', 'ask', 'keep', 'pushed', 'other', 'notifying', 'unknown', 'off'];

let port = FIRST_PORT;
let lastSeen = Date.now() + START_GRACE_MS - IDLE_MS;
let busy = 0;
// Pages that are open right now. Each keeps one request to /api/hold going
// for as long as it is open. That, and not a timer in the page, is what says
// a window is still there: browsers slow the timers of a window nobody is
// looking at to as little as once a minute, and stop them while the computer
// sleeps, but they keep a connection.
let holders = 0;

// ---- Running the tool ------------------------------------------------------

// One at a time: two runs changing the phone or the change log at once could
// trip over each other.
let queue = Promise.resolve();
function runTool(args) {
  busy += 1;
  const job = queue.then(() => new Promise(resolve => {
    execFile(BASH, [TOOL, '--no-color', ...args], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      busy -= 1;
      resolve({ code, stdout, stderr });
    });
  }));
  queue = job.catch(() => {});
  return job;
}

const forPhone = serial => (serial ? ['-s', serial] : []);

// "error: no phone found. Plug it in..." -> "No phone found. Plug it in..."
function toolError(result) {
  const text = (result.stderr || result.stdout || '').trim();
  const line = text.split('\n').find(l => l.startsWith('error: ')) || text.split('\n')[0] || 'debloat.sh failed';
  const plain = line.replace(/^error: /, '');
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

function parseScan(tsv) {
  const meta = {};
  const lists = Object.fromEntries(LISTS.map(name => [name, []]));
  const history = [];
  const changes = [];
  for (const line of tsv.split('\n')) {
    if (!line) continue;
    const field = line.split('\t');
    const [kind, a, b = '', c = ''] = field;
    if (kind === 'meta') meta[a] = b;
    else if (kind === 'history') {
      const [time, installed, cleanup, ask, notifying, off] = field.slice(1).map(Number);
      history.push({ time, installed, cleanup, ask, notifying, off });
    } else if (kind === 'change') changes.push({ pkg: a, action: b, when: c });
    else if (lists[kind]) lists[kind].push({ pkg: a, note: b, app: c === 'app', locked: c === 'locked' });
  }
  return { meta, lists, history, changes };
}

function listPhones() {
  return new Promise(resolve => {
    execFile('adb', ['devices'], (err, stdout) => {
      if (err) return resolve({ ok: false, error: 'adb is not installed. On a Mac: brew install android-platform-tools' });
      const phones = stdout.split('\n').slice(1)
        .map(l => l.trim().split(/\s+/))
        .filter(p => p.length === 2)
        .map(([serial, state]) => ({ serial, state }));
      resolve({ ok: true, phones });
    });
  });
}

// ---- HTTP ------------------------------------------------------------------

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(data);
}

function sameToken(given) {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 65536) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(req.headers.host || '')) return send(res, 403, { error: 'wrong host' });

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    // A page is on its way: give it time to arrive before deciding nobody is
    // there. This is also how a second start keeps this helper around.
    lastSeen = Date.now();
    const html = fs.readFileSync(PAGE, 'utf8')
      .replace('__DEBLOAT_TOKEN__', TOKEN)
      .replace('__DEBLOAT_VERSION__', VERSION);
    return send(res, 200, html, 'text/html');
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  if (!sameToken(req.headers['x-debloat-token'])) return send(res, 401, { error: 'token required' });

  lastSeen = Date.now();
  const serial = url.searchParams.get('serial') || '';
  if (serial && !SERIAL.test(serial)) return send(res, 400, { error: 'bad serial' });

  // Never answered in full: it ends when the page goes away, or this does.
  // The page learns from that too, and says so instead of failing later.
  if (req.method === 'GET' && url.pathname === '/api/hold') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('\n');
    holders += 1;
    const beat = setInterval(() => res.write('\n'), 20000);
    res.on('close', () => {
      clearInterval(beat);
      holders -= 1;
      lastSeen = Date.now();
    });
    return undefined;
  }

  // A plain check-in. The page sends one every few seconds as well, in case
  // something between it and this cuts the held request short.
  if (req.method === 'GET' && url.pathname === '/api/alive') return send(res, 200, { ok: true });

  // A newer or older copy of the app has been opened and wants to take over.
  // Not while the tool is at work on the phone.
  if (req.method === 'POST' && url.pathname === '/api/quit') {
    if (busy > 0) return send(res, 409, { error: 'busy' });
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 50);
    return undefined;
  }

  if (req.method === 'GET' && url.pathname === '/api/phones') {
    return send(res, 200, await listPhones());
  }

  if (req.method === 'GET' && url.pathname === '/api/scan') {
    const result = await runTool([...forPhone(serial), 'scan', '--tsv']);
    if (result.code !== 0) return send(res, 200, { ok: false, error: toolError(result) });
    return send(res, 200, { ok: true, ...parseScan(result.stdout) });
  }

  if (req.method === 'GET' && url.pathname === '/api/inspect') {
    const result = await runTool([...forPhone(serial), 'inspect']);
    if (result.code !== 0) return send(res, 200, { ok: false, error: toolError(result) });
    return send(res, 200, { ok: true, output: result.stdout });
  }

  if (req.method === 'POST' && url.pathname === '/api/act') {
    let body;
    try { body = await readJson(req); } catch (e) { return send(res, 400, { error: 'bad request' }); }
    const { action, packages } = body;
    if (!ACTIONS.has(action)) return send(res, 400, { error: 'unknown action' });
    if (!Array.isArray(packages) || packages.length === 0 || packages.length > 500
      || !packages.every(p => typeof p === 'string' && PACKAGE.test(p))) {
      return send(res, 400, { error: 'bad package list' });
    }
    if (body.serial !== undefined && body.serial !== '' && !SERIAL.test(String(body.serial))) {
      return send(res, 400, { error: 'bad serial' });
    }
    // -y: the page has already asked. Exit status 2 means some could not be
    // changed; the output says which.
    const result = await runTool([...forPhone(body.serial || ''), '-y', action, ...packages]);
    const output = (result.stdout + result.stderr).trim();
    if (result.code !== 0 && result.code !== 2) {
      return send(res, 200, { ok: false, error: toolError(result), output });
    }
    return send(res, 200, { ok: true, partial: result.code === 2, output });
  }

  if (req.method === 'POST' && url.pathname === '/api/restart') {
    const result = await runTool([...forPhone(serial), 'restart']);
    if (result.code !== 0) return send(res, 200, { ok: false, error: toolError(result) });
    return send(res, 200, { ok: true, output: result.stdout.trim() });
  }

  if (req.method === 'GET' && url.pathname === '/api/watch') {
    // Streams the tool's watch output for as long as the page keeps reading.
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const child = spawn(BASH, [TOOL, '--no-color', ...forPhone(serial), 'watch']);
    busy += 1;
    child.stdout.on('data', chunk => res.write(chunk));
    child.stderr.on('data', chunk => res.write(chunk));
    child.on('close', () => { busy -= 1; res.end(); });
    req.on('close', () => child.kill('SIGTERM'));
    return undefined;
  }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) send(res, 500, { error: 'server error' });
    else res.end();
  });
});

// What is already listening on this port: another copy of this helper, and if
// so, which version, and the token its page carries.
function probe(candidate) {
  return new Promise(resolve => {
    const nothing = { ours: false, version: '', token: '' };
    const req = http.get({ host: '127.0.0.1', port: candidate, path: '/', timeout: 1500 }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        if (!text.includes('<title>MAXAPACITY Debloat</title>')) return resolve(nothing);
        const meta = name => (new RegExp(`name="debloat-${name}" content="([^"]*)"`).exec(text) || [])[1] || '';
        return resolve({ ours: true, version: meta('version'), token: meta('token') });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(nothing); });
    req.on('error', () => resolve(nothing));
  });
}

const listening = candidate => new Promise(resolve => {
  const socket = net.connect(candidate, '127.0.0.1');
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});

// Asks the helper on this port to stop and waits for the port to come free.
// False if it would not (it is busy with the phone, or too old to be asked).
async function retire(candidate, token) {
  const agreed = await new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: candidate, path: '/api/quit', method: 'POST', timeout: 1500,
      headers: { 'x-debloat-token': token },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
  if (!agreed) return false;
  for (let i = 0; i < 30; i++) {
    if (!(await listening(candidate))) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

server.on('error', async err => {
  if (err.code !== 'EADDRINUSE') {
    console.error(`Could not start: ${err.message}`);
    process.exit(1);
  }
  const other = await probe(port);
  if (other.ours) {
    // The app has been updated since that helper started: take over from it,
    // so that what opens is the version that was just opened.
    if (other.version !== VERSION && other.token && await retire(port, other.token)) {
      console.log(`MAXAPACITY Debloat ${other.version || 'of an older version'} was running; this is ${VERSION}.`);
      server.listen(port, '127.0.0.1');
      return;
    }
    // Opened twice: show a window on the helper that is already there instead
    // of starting a second one beside it.
    const address = `http://127.0.0.1:${port}/`;
    console.log(`MAXAPACITY Debloat is already running at ${address}`);
    sayReady(address);
    if (OPEN_BROWSER) openPage(address);
    setTimeout(() => process.exit(0), OPEN_BROWSER ? 1500 : 0);
    return;
  }
  if (port < FIRST_PORT + 10) {
    port += 1;
    server.listen(port, '127.0.0.1');
  } else {
    console.error('Could not find a free port to listen on.');
    process.exit(1);
  }
});

// Chromium-family browsers can show a page in a plain window of its own, with
// no tabs or address bar, which is what makes this feel like an app.
const APP_WINDOW_BROWSERS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'];

function openPage(address) {
  if (process.platform !== 'darwin') {
    execFile('xdg-open', [address], () => {});
    return;
  }
  const home = process.env.HOME || '';
  const browser = OWN_WINDOW && APP_WINDOW_BROWSERS.find(name =>
    fs.existsSync(`/Applications/${name}.app`) || fs.existsSync(`${home}/Applications/${name}.app`));
  if (browser) {
    execFile('open', ['-na', browser, '--args', `--app=${address}`, '--window-size=1280,860'], err => {
      if (err) execFile('open', [address], () => {});
    });
  } else {
    execFile('open', [address], () => {});
  }
}

server.on('listening', () => {
  const address = `http://127.0.0.1:${port}/`;
  console.log(`MAXAPACITY Debloat is open at ${address}`);
  sayReady(address);
  if (EXIT_WHEN_IDLE) console.log('It stops by itself shortly after you close its window.');
  else console.log('Leave this window running while you use it. Press Ctrl-C to stop.');
  if (OPEN_BROWSER) openPage(address);
  if (EXIT_WHEN_IDLE) {
    setInterval(() => {
      if (busy === 0 && holders === 0 && Date.now() - lastSeen > IDLE_MS) process.exit(0);
    }, Math.min(2000, Math.max(100, IDLE_MS / 2))).unref();
  }
});

if (!fs.existsSync(TOOL)) {
  console.error(`debloat.sh is missing (looked in ${path.dirname(TOOL)})`);
  process.exit(1);
}
server.listen(port, '127.0.0.1');
