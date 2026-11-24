// Tests for gui/server.mjs against the simulated phone (test/fake_adb.py).
//
//   node --test test/gui.test.mjs
//
// They cover what the page relies on and, above all, what keeps another web
// page from driving the phone: the token and the Host check.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'debloat-gui-'));
const PORT = 20000 + (process.pid % 20000);
const ENV = {
  ...process.env,
  PATH: `${path.join(HERE, 'bin')}${path.delimiter}${process.env.PATH}`,
  FAKE_ADB_STATE: path.join(WORK, 'phone.json'),
  DEBLOAT_STATE_DIR: path.join(WORK, 'state'),
  DEBLOAT_GUI_PORT: String(PORT),
};
const ctl = (...args) => execFileSync('python3', [path.join(HERE, 'fake_adb.py'), 'ctl', ...args], { env: ENV });

// A plain request, so the Host header can be set to anything.
function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

let server;
let token;
const authed = (method, url, body) => request(method, url, {
  headers: { 'x-debloat-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
  body,
});

test.before(async () => {
  ctl('init');
  server = spawn(process.execPath, [path.join(HERE, '..', 'gui', 'server.mjs'), '--no-open'], { env: ENV });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', chunk => { if (String(chunk).includes('is open at')) resolve(); });
    server.on('exit', code => reject(new Error(`server exited early (${code})`)));
  });
  const page = await request('GET', '/');
  token = /name="debloat-token" content="([0-9a-f]+)"/.exec(page.text)[1];
});

test.after(() => {
  server.kill();
  fs.rmSync(WORK, { recursive: true, force: true });
});

test('the page is served with a token and the version, and without the placeholders', async () => {
  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.equal(token.length, 48);
  assert.ok(!page.text.includes('__DEBLOAT_TOKEN__'));
  assert.ok(!page.text.includes('__DEBLOAT_VERSION__'));
  const tool = fs.readFileSync(path.join(HERE, '..', 'debloat.sh'), 'utf8');
  const version = /^VERSION="([^"]+)"$/m.exec(tool)[1];
  assert.ok(page.text.includes(`name="debloat-version" content="${version}"`));
});

// The page asks for one more file, and gets it without the token, which a
// script tag cannot send. Nothing else is handed out by name.
test("the wizard's drawing code is served, and nothing else by name", async () => {
  const code = await request('GET', '/magic.js');
  assert.equal(code.status, 200);
  assert.match(code.headers['content-type'], /^text\/javascript/);
  assert.equal(code.text, fs.readFileSync(path.join(HERE, '..', 'gui', 'magic.js'), 'utf8'));
  assert.equal((await request('GET', '/magic.js', { headers: { host: 'evil.example' } })).status, 403);
  for (const other of ['/ui.html', '/server.mjs', '/debloat.sh', '/magic.js.map', '/gui/magic.js']) {
    assert.equal((await request('GET', other)).status, 404, other);
  }
});

// Nothing else here runs either file, so at the least they must parse, and
// the page must only ask the drawing code for things it has.
test('the page and the drawing code parse, and agree on what the wizard can do', () => {
  const page = fs.readFileSync(path.join(HERE, '..', 'gui', 'ui.html'), 'utf8');
  const code = fs.readFileSync(path.join(HERE, '..', 'gui', 'magic.js'), 'utf8');
  const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(found => found[1]);
  assert.equal(inline.length, 1);
  assert.doesNotThrow(() => new vm.Script(inline[0], { filename: 'ui.html' }));
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'magic.js' }));
  assert.ok(page.includes('<script src="/magic.js"></script>'));
  const asked = new Set([...inline[0].matchAll(/\b(?:magic|engine)\.([a-zA-Z]+)\(/g)].map(found => found[1]));
  assert.ok(asked.size >= 10, 'the page should be asking the wizard for things');
  for (const name of asked) {
    assert.match(code, new RegExp(`\\n      (?:async )?${name}\\(`), `magic.js has no ${name}()`);
  }
});

// The drawing code, run for a while against a WebGL that does nothing. No
// picture comes of it, but every path through the code is taken, and a
// mistake in one of them would otherwise only show on somebody's screen.
test('the drawing code runs every act, spell and stage without an error', async () => {
  const code = fs.readFileSync(path.join(HERE, '..', 'gui', 'magic.js'), 'utf8');
  let now = 0;
  let frame = null;
  let stage = 'hero';
  const drawn = { drawElements: 0, drawArrays: 0 };
  const listeners = {};
  const gl = new Proxy({}, {
    get(target, name) {
      if (typeof name !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) return 1;
      return () => {
        if (name in drawn) drawn[name] += 1;
        if (name === 'getShaderParameter' || name === 'getProgramParameter') return true;
        if (name === 'getParameter') return [1, 64];
        if (name === 'getContextAttributes') return { stencil: true };
        if (/^create|^getUniformLocation$/.test(name)) return {};
        return undefined;
      };
    },
  });
  const node = kind => ({
    dataset: kind === 'full' ? { into: '0.02 0.14 0.5 0.95' } : {},
    getBoundingClientRect: () => ({ left: 40, top: 40, right: 840, bottom: 640, width: 800, height: 600 }),
  });
  const sandbox = {
    console,
    setTimeout,
    innerWidth: 1280,
    innerHeight: 860,
    devicePixelRatio: 2,
    performance: { now: () => now },
    requestAnimationFrame: fn => { frame = fn; return 1; },
    cancelAnimationFrame() {},
    addEventListener: (name, fn) => { listeners[name] = fn; },
    getComputedStyle: () => ({ borderTopLeftRadius: '12px' }),
    document: {
      hidden: false,
      hasFocus: () => true,
      addEventListener() {},
      querySelector: selector => (selector === `[data-stage="${stage}"]` ? node(stage) : null),
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'magic.js' });
  const canvas = { width: 0, height: 0, style: {}, getContext: () => gl, addEventListener() {} };
  const magic = sandbox.DebloatMagic.create(canvas, {});
  assert.ok(magic, 'create() should hand back the layer');
  assert.equal(sandbox.DebloatMagic.create({ getContext: () => null }), null, 'without WebGL there is no layer, and no error');
  const run = seconds => {
    for (let i = 0; i < seconds * 60; i++) {
      now += 1000 / 60;
      frame(now);
    }
  };

  magic.phone('scan');
  magic.tiles(Array.from({ length: 14 }, (_, i) => ({ id: `com.example.app${i}`, kind: ['remove', 'pushed', 'back'][i % 3] })));
  listeners.pointermove({ clientX: 500, clientY: 300 });
  for (const act of ['idle', 'hello', 'scan', 'think', 'channel', 'zap', 'cheer', 'cool', 'shrug', 'search', 'no such act']) {
    magic.act(act);
    run(0.5);
  }
  // On every stage and on none, in a dark window and a light one.
  for (const kind of ['hero', 'side', 'none', 'full']) {
    stage = kind;
    for (const light of [false, true]) {
      magic.set({ light });
      magic.phone(light ? 'clean' : 'idle', 0.3);
      run(0.3);
      assert.equal(magic.visible(), kind !== 'none');
    }
  }
  // He stands in the left half of his own screen, where the page put him:
  // that is the camera, the projection and the stage all agreeing.
  const orb = magic.orb();
  assert.ok(orb && orb.x > 40 && orb.x < 440 && orb.y > 40 && orb.y < 640, `the orb should be on the left of the stage, not at ${JSON.stringify(orb)}`);

  magic.tile('com.example.app1', 'keep');
  magic.tile('com.example.app2', 'aim');
  magic.tile('com.example.app3', 'fail');
  magic.tile('not there', 'aim');
  magic.shades(true);
  magic.talking(true);
  magic.poke();
  magic.celebrate();
  magic.burst(100, 100, {});
  const spells = Promise.all([
    magic.zapTiles(['com.example.app0', 'com.example.app4', 'not there'], 1),
    magic.zapRects([{ left: 300, top: 200, width: 400, height: 40 }], 1),
  ]);
  run(1);
  await spells;
  run(2);

  // Asked to hold still, and then switched off, it must not trip either.
  magic.set({ still: true });
  magic.tiles([{ id: 'com.example.new', kind: 'remove', state: 'keep' }]);
  magic.act('cheer');
  for (let i = 0; i < 20; i++) {
    now += 300;
    frame(now);
  }
  const before = drawn.drawElements;
  magic.set({ enabled: false });
  run(0.5);
  assert.equal(drawn.drawElements, before, 'switched off, it draws nothing');
  assert.ok(before > 5000 && drawn.drawArrays > 500, 'it should have been drawing all along');
});

test('a request without the token is refused', async () => {
  assert.equal((await request('GET', '/api/scan')).status, 401);
  assert.equal((await request('GET', '/api/scan', { headers: { 'x-debloat-token': 'f'.repeat(48) } })).status, 401);
  const act = await request('POST', '/api/act', {
    headers: { 'content-type': 'application/json' },
    body: { action: 'remove', packages: ['com.motorola.help'] },
  });
  assert.equal(act.status, 401);
  assert.equal(String(ctl('get', 'com.motorola.help', 'installed')).trim(), 'true');
});

test('a request for another host name is refused, even with the token', async () => {
  // What a site sees if it points its own domain at 127.0.0.1.
  const headers = { host: `evil.example:${PORT}`, 'x-debloat-token': token };
  assert.equal((await request('GET', '/', { headers })).status, 403);
  assert.equal((await request('GET', '/api/scan', { headers })).status, 403);
});

test('scan returns every list with what the page needs', async () => {
  const { json } = await authed('GET', '/api/scan');
  assert.equal(json.ok, true);
  assert.equal(json.meta.phone, 'moto g stylus - 2025 (mona), Android 16');
  assert.deepEqual(Object.keys(json.lists).sort(),
    ['ask', 'back', 'keep', 'notifying', 'off', 'other', 'pushed', 'remove', 'unknown']);
  assert.ok(json.lists.remove.some(r => r.pkg === 'com.motorola.help' && !r.app && !r.locked));
  assert.ok(json.lists.pushed.some(r => r.pkg === 'com.candy.game' && r.app));
  assert.ok(json.lists.off.some(r => r.pkg === 'com.motorola.tracfone.rsu' && r.note.includes('the rules would keep it')));
});

test('a protected app is marked so the page can lock its row', async () => {
  ctl('set', 'com.android.systemui', 'notifs=1');
  const { json } = await authed('GET', '/api/scan');
  assert.ok(json.lists.notifying.some(r => r.pkg === 'com.android.systemui' && r.locked));
  ctl('set', 'com.android.systemui', 'notifs=0');
});

test('remove, then restore, goes through the tool and its change log', async () => {
  const removed = await authed('POST', '/api/act', { action: 'remove', packages: ['com.motorola.help'] });
  assert.equal(removed.json.ok, true);
  assert.match(removed.json.output, /removed\s+com\.motorola\.help/);
  assert.equal(String(ctl('get', 'com.motorola.help', 'installed')).trim(), 'false');

  let scan = (await authed('GET', '/api/scan')).json;
  assert.ok(!scan.lists.remove.some(r => r.pkg === 'com.motorola.help'));
  assert.ok(scan.lists.off.some(r => r.pkg === 'com.motorola.help' && r.note.includes('by this tool')));

  const restored = await authed('POST', '/api/act', { action: 'restore', packages: ['com.motorola.help'] });
  assert.equal(restored.json.ok, true);
  assert.equal(String(ctl('get', 'com.motorola.help', 'installed')).trim(), 'true');
  scan = (await authed('GET', '/api/scan')).json;
  assert.ok(scan.lists.remove.some(r => r.pkg === 'com.motorola.help'));
});

test('what could not be changed is reported, not hidden', async () => {
  const result = await authed('POST', '/api/act', { action: 'remove', packages: ['com.glance.lockscreen'] });
  assert.equal(result.json.ok, true);
  assert.equal(result.json.partial, true);
  assert.match(result.json.output, /FAILED\s+com\.glance\.lockscreen/);
});

test('anything but a known action and plain package names is refused', async () => {
  const bad = [
    { action: 'format', packages: ['com.motorola.help'] },
    { action: 'remove', packages: [] },
    { action: 'remove', packages: ['com.motorola.help; reboot'] },
    { action: 'remove', packages: ['--force'] },
    { action: 'remove', packages: 'com.motorola.help' },
    { action: 'remove', packages: ['com.motorola.help'], serial: 'x y' },
  ];
  for (const body of bad) {
    assert.equal((await authed('POST', '/api/act', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await authed('GET', '/api/scan?serial=a%20b')).status, 400);
  assert.equal(String(ctl('get', 'com.motorola.help', 'installed')).trim(), 'true');
});

test('inspect returns the tool report', async () => {
  const { json } = await authed('GET', '/api/inspect');
  assert.equal(json.ok, true);
  assert.match(json.output, /== ON SCREEN NOW/);
});

test('scan carries the history and the change log the overview is built from', async () => {
  await authed('POST', '/api/act', { action: 'remove', packages: ['com.motorola.help'] });
  const { json } = await authed('GET', '/api/scan');
  assert.ok(json.history.length >= 2);
  const last = json.history[json.history.length - 1];
  for (const key of ['time', 'installed', 'cleanup', 'ask', 'notifying', 'off']) {
    assert.equal(typeof last[key], 'number', key);
  }
  // What there is to clean up is counted once each, as the overview shows it.
  const unique = new Set([...json.lists.remove, ...json.lists.pushed, ...json.lists.back].map(r => r.pkg));
  assert.equal(last.cleanup, unique.size);
  const change = json.changes.find(c => c.pkg === 'com.motorola.help');
  assert.equal(change.action, 'removed');
  assert.ok(!Number.isNaN(Date.parse(change.when)));
  await authed('POST', '/api/act', { action: 'restore', packages: ['com.motorola.help'] });
});

test('restart reaches the phone', async () => {
  const before = JSON.parse(fs.readFileSync(ENV.FAKE_ADB_STATE, 'utf8')).reboots || 0;
  const { json } = await authed('POST', '/api/restart');
  assert.equal(json.ok, true);
  assert.match(json.output, /Restarting/);
  const after = JSON.parse(fs.readFileSync(ENV.FAKE_ADB_STATE, 'utf8')).reboots || 0;
  assert.equal(after, before + 1);
  assert.equal((await request('POST', '/api/restart')).status, 401);
});

// One more helper, as the app starts it: it stops by itself once the page has
// gone, and not while the page is still there.
function startIdleHelper(portOffset) {
  const env = { ...ENV, DEBLOAT_GUI_PORT: String(PORT + portOffset), DEBLOAT_GUI_IDLE_MS: '700', DEBLOAT_GUI_GRACE_MS: '700' };
  const child = spawn(process.execPath, [path.join(HERE, '..', 'gui', 'server.mjs'), '--no-open', '--exit-when-idle'], { env });
  const up = new Promise(resolve => child.stdout.on('data', chunk => { if (String(chunk).includes('is open at')) resolve(); }));
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return { child, up, exited };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A request to another port, for the helpers started beside the main one.
function getFrom(port, url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}
const tokenIn = text => /name="debloat-token" content="([0-9a-f]+)"/.exec(text)[1];
const listening = port => new Promise(resolve => {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});

test('a helper started by the app stops once its window has gone', async () => {
  const helper = startIdleHelper(1);
  await helper.up;
  const code = await Promise.race([helper.exited, sleep(8000).then(() => 'still running')]);
  helper.child.kill();
  assert.equal(code, 0);
});

test('and keeps running while the window checks in', async () => {
  const helper = startIdleHelper(2);
  await helper.up;
  const itsToken = tokenIn((await getFrom(PORT + 2, '/')).text);
  for (let i = 0; i < 8; i++) {
    assert.equal((await getFrom(PORT + 2, '/api/alive', { 'x-debloat-token': itsToken })).status, 200);
    await sleep(300);
  }
  const code = await Promise.race([helper.exited, sleep(6000).then(() => 'still running')]);
  helper.child.kill();
  assert.equal(code, 0);
});

// A hidden window's timers are slowed to as little as once a minute, and a
// sleeping computer's stop. The request the page keeps open is what counts.
test('and while a window is open but silent, for as long as it stays open', async () => {
  const helper = startIdleHelper(3);
  await helper.up;
  const itsToken = tokenIn((await getFrom(PORT + 3, '/')).text);
  assert.equal((await getFrom(PORT + 3, '/api/hold')).status, 401);

  let held;
  const status = await new Promise((resolve, reject) => {
    held = http.get({ host: '127.0.0.1', port: PORT + 3, path: '/api/hold', headers: { 'x-debloat-token': itsToken } },
      res => { res.resume(); resolve(res.statusCode); });
    held.on('error', reject);
  });
  assert.equal(status, 200);
  // Several times the idle limit, with nothing sent.
  const early = await Promise.race([helper.exited, sleep(3500).then(() => 'still running')]);
  assert.equal(early, 'still running');

  held.on('error', () => {});
  held.destroy();                 // the window closes
  const code = await Promise.race([helper.exited, sleep(6000).then(() => 'still running')]);
  helper.child.kill();
  assert.equal(code, 0);
});

test('started in the background, it returns at once and carries on by itself', async () => {
  const port = PORT + 4;
  const env = { ...ENV, DEBLOAT_GUI_PORT: String(port), DEBLOAT_GUI_IDLE_MS: '700', DEBLOAT_GUI_GRACE_MS: '5000' };
  const started = Date.now();
  const launcher = spawn(process.execPath,
    [path.join(HERE, '..', 'gui', 'server.mjs'), '--no-open', '--exit-when-idle', '--background'],
    { env, stdio: 'ignore' });
  const code = await new Promise(resolve => launcher.on('exit', resolve));
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 4000, 'the launcher should not wait for the helper');

  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    page = await getFrom(port, '/').catch(() => null);
    if (!page) await sleep(150);
  }
  assert.ok(page, 'the helper should be serving after its launcher has gone');
  assert.match(page.text, /<title>MAXAPACITY Debloat<\/title>/);
  assert.equal((await getFrom(port, '/api/alive', { 'x-debloat-token': tokenIn(page.text) })).status, 200);

  // With no window, it stops by itself; nothing is left behind.
  let up = true;
  for (let i = 0; i < 40 && up; i++) {
    await sleep(250);
    up = await listening(port);
  }
  assert.equal(up, false);
});

test('started in the background where it cannot start, it says so by its exit status', async () => {
  // Every port it would try is taken, by something that is not this helper.
  const first = PORT + 20;
  const squatters = [];
  for (let i = 0; i <= 10; i++) {
    const squatter = http.createServer((req, res) => res.end('not the helper'));
    await new Promise(resolve => squatter.listen(first + i, '127.0.0.1', resolve));
    squatters.push(squatter);
  }
  const env = { ...ENV, DEBLOAT_GUI_PORT: String(first) };
  const launcher = spawn(process.execPath,
    [path.join(HERE, '..', 'gui', 'server.mjs'), '--no-open', '--exit-when-idle', '--background'],
    { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let said = '';
  launcher.stderr.on('data', chunk => { said += chunk; });
  const code = await Promise.race([
    new Promise(resolve => launcher.on('exit', resolve)),
    sleep(15000).then(() => 'still running'),
  ]);
  for (const squatter of squatters) squatter.close();
  assert.equal(code, 1);
  assert.match(said, /Could not find a free port/);
});

test('opening it a second time reuses the helper that is already running', async () => {
  const second = spawn(process.execPath, [path.join(HERE, '..', 'gui', 'server.mjs'), '--no-open'], { env: ENV });
  let said = '';
  second.stdout.on('data', chunk => { said += chunk; });
  const code = await new Promise(resolve => second.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(said, /already running/);
  // The first one is untouched.
  assert.equal((await authed('GET', '/api/alive')).status, 200);
});

// The app has been updated while its window was open: opening the new one
// must show the new one, not a window on the old helper.
test('a helper from another version of the app is asked to stop, and this one takes over', async () => {
  const port = PORT + 5;
  const env = { ...ENV, DEBLOAT_GUI_PORT: String(port) };
  // An older copy of the app: the same files, with another version written in.
  const old = path.join(WORK, 'older');
  fs.mkdirSync(path.join(old, 'gui'), { recursive: true });
  for (const file of ['gui/server.mjs', 'gui/ui.html', 'rules.tsv']) {
    fs.copyFileSync(path.join(HERE, '..', file), path.join(old, file));
  }
  fs.writeFileSync(path.join(old, 'debloat.sh'),
    fs.readFileSync(path.join(HERE, '..', 'debloat.sh'), 'utf8').replace(/^VERSION="[^"]+"$/m, 'VERSION="0.0.1"'));

  const older = spawn(process.execPath, [path.join(old, 'gui', 'server.mjs'), '--no-open'], { env });
  const olderExit = new Promise(resolve => older.on('exit', code => resolve(code)));
  await new Promise(resolve => older.stdout.on('data', chunk => { if (String(chunk).includes('is open at')) resolve(); }));
  const before = await getFrom(port, '/');
  assert.ok(before.text.includes('name="debloat-version" content="0.0.1"'));
  // That copy has no wizard in it. The page is served all the same, and the
  // request for him is turned down without a fuss.
  assert.equal((await getFrom(port, '/magic.js')).status, 404);
  // Nobody but its own page may stop it.
  const refused = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/quit', method: 'POST' }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(refused, 401);

  const newer = spawn(process.execPath, [path.join(HERE, '..', 'gui', 'server.mjs'), '--no-open'], { env });
  let said = '';
  newer.stdout.on('data', chunk => { said += chunk; });
  await new Promise(resolve => newer.stdout.on('data', () => { if (said.includes('is open at')) resolve(); }));
  assert.equal(await Promise.race([olderExit, sleep(5000).then(() => 'still running')]), 0);
  assert.match(said, /0\.0\.1 was running/);
  const after = await getFrom(port, '/');
  assert.ok(!after.text.includes('content="0.0.1"'));
  assert.notEqual(tokenIn(after.text), tokenIn(before.text));
  newer.kill();
});

test('a missing phone comes back as a readable error, not a crash', async () => {
  ctl('top', 'devices=[]');
  const { status, json } = await authed('GET', '/api/scan');
  assert.equal(status, 200);
  assert.equal(json.ok, false);
  assert.match(json.error, /^No phone found/);
  ctl('top', 'devices=[["FAKE123","device"]]');
});
