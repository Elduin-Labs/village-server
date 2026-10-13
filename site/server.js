// Village Server website.
//
// Listens on one port (23377) and looks at the first bytes of every
// connection: web browsers get the website, Minecraft clients get passed
// straight through to the real server.
//
// It also does the village jobs over RCON:
//   - the first time the world starts, it finds the nearest village and
//     moves the world spawn into the middle of it
//   - the first time each player joins, it gives them a starter kit
//
// And it looks things up on the Minecraft Wiki by running the Minecraft Wiki
// MCP server (from the Docker profile) and talking to it over stdin/stdout.

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 23377;
const WEB_PORT = 8080; // internal only
const MC_HOST = process.env.MC_HOST || 'minecraft';
const MC_PORT = 25565;
const MC_VERSION = process.env.MC_VERSION || '';
const DATA = '/data';
const STATE_FILE = '/state/village.json';
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

// Everything a new player gets the first time they join.
const STARTER_KIT = [
  { id: 'iron_sword', count: 1, label: 'Iron Sword' },
  { id: 'iron_pickaxe', count: 1, label: 'Iron Pickaxe' },
  { id: 'iron_axe', count: 1, label: 'Iron Axe' },
  { id: 'iron_shovel', count: 1, label: 'Iron Shovel' },
  { id: 'shield', count: 1, label: 'Shield' },
  { id: 'bread', count: 16, label: 'Bread' },
  { id: 'cooked_beef', count: 16, label: 'Steak' },
  { id: 'torch', count: 32, label: 'Torches' },
  { id: 'oak_log', count: 32, label: 'Oak Logs' },
  { id: 'crafting_table', count: 1, label: 'Crafting Table' },
  { id: 'furnace', count: 1, label: 'Furnace' },
  { id: 'white_bed', count: 1, label: 'Bed' },
  { id: 'emerald', count: 16, label: 'Emeralds (for trading with villagers)' },
];

// ---------- one port, two jobs ----------

const HTTP_METHODS = ['GET ', 'POST', 'HEAD', 'PUT ', 'DELE', 'OPTI', 'PATC'];

net.createServer(client => {
  client.on('error', () => {});
  client.once('data', first => {
    const isHttp = HTTP_METHODS.includes(first.subarray(0, 4).toString('latin1'));
    const up = isHttp ? net.connect(WEB_PORT, '127.0.0.1') : net.connect(MC_PORT, MC_HOST);
    const close = () => { client.destroy(); up.destroy(); };
    up.on('error', close);
    up.on('close', close);
    client.on('close', close);
    up.write(first);
    client.pipe(up).pipe(client);
  });
}).listen(PORT, () => console.log(`Listening on ${PORT} (Minecraft + website)`));

// ---------- RCON ----------

function readProps() {
  try {
    const props = {};
    for (const line of fs.readFileSync(path.join(DATA, 'server.properties'), 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && !line.startsWith('#')) props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return props;
  } catch {
    return {};
  }
}

class Rcon {
  constructor() {
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 10;
    this.current = null;
    this.chain = Promise.resolve();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const props = readProps();
      const password = props['rcon.password'];
      if (!password) return reject(new Error('no rcon password yet'));
      const sock = net.connect(Number(props['rcon.port'] || 25575), MC_HOST);
      let authed = false;
      this.buf = Buffer.alloc(0);
      this.onAuth = id => {
        if (id === -1) { sock.destroy(); reject(new Error('bad rcon password')); return; }
        authed = true;
        resolve();
      };
      sock.on('connect', () => { this.sock = sock; this.send(1, 3, password); });
      sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
      sock.on('error', () => {});
      sock.on('close', () => {
        if (this.sock === sock) this.sock = null;
        this.fail(new Error('rcon closed'));
        if (!authed) reject(new Error('rcon closed'));
      });
    });
  }

  send(id, type, body) {
    const b = Buffer.from(body, 'utf8');
    const p = Buffer.alloc(14 + b.length);
    p.writeInt32LE(10 + b.length, 0);
    p.writeInt32LE(id, 4);
    p.writeInt32LE(type, 8);
    b.copy(p, 12);
    this.sock.write(p);
  }

  parse() {
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const body = this.buf.toString('utf8', 12, 4 + len - 2);
      this.buf = this.buf.subarray(4 + len);
      this.packet(id, type, body);
    }
  }

  packet(id, type, body) {
    if (this.onAuth && type === 2) {
      const f = this.onAuth;
      this.onAuth = null;
      f(id);
      return;
    }
    const cur = this.current;
    if (!cur) return;
    // Long replies come in several packets. A second, empty command is sent
    // right after each real one; its reply marks the end of the real one.
    if (id === cur.id) cur.parts.push(body);
    else if (id === cur.marker) { this.current = null; clearTimeout(cur.timer); cur.resolve(cur.parts.join('')); }
  }

  fail(err) {
    if (this.current) { clearTimeout(this.current.timer); this.current.reject(err); this.current = null; }
  }

  cmd(command) {
    const run = async () => {
      if (!this.sock) await this.connect();
      return this.raw(command);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  // Sends one command right now. Only call this from inside cmd()'s queue.
  raw(command) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const marker = this.nextId++;
      if (this.nextId > 2e9) this.nextId = 10;
      // Finding a village can take the server a while.
      const timer = setTimeout(() => {
        if (this.current && this.current.id === id) { this.current = null; reject(new Error('rcon timeout')); this.sock?.destroy(); }
      }, 30000);
      this.current = { id, marker, parts: [], resolve, reject, timer };
      this.send(id, 2, command);
      this.send(marker, 2, '');
    });
  }
}

const rcon = new Rcon();

async function entityData(target, field) {
  const r = await rcon.cmd(`data get entity ${target} ${field}`);
  const i = r.indexOf('entity data: ');
  return i < 0 ? null : r.slice(i + 13).trim();
}

function parsePos(snbt) {
  const pos = (snbt || '').replace(/[\[\]d]/g, '').split(',').map(parseFloat);
  return pos.length === 3 && pos.every(Number.isFinite) ? pos.map(Math.floor) : null;
}

// ---------- what we remember ----------

let store = { village: null, kitted: [] };
try { store = { ...store, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
function save() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(store, null, 2)); } catch (e) { console.error('save failed', e.message); }
}

// ---------- the village ----------

let villageTry = 0;
let villageNote = 'Looking for a village...';

async function setUpVillage(online) {
  if (Date.now() < villageTry) return;
  villageTry = Date.now() + 30000;

  const found = await rcon.cmd('locate structure #minecraft:village');
  const m = found.match(/\(minecraft:village_(\w+)\) is at \[(-?\d+), ~, (-?\d+)\]/)
    || found.match(/village_(\w+).*?\[(-?\d+), ~, (-?\d+)\]/);
  if (!m) { villageNote = 'Still looking for a village...'; console.log('locate:', found); return; }
  const kind = m[1];
  const x = Number(m[2]);
  const z = Number(m[3]);

  // Drop a marker on the ground in the middle of the village, then put the
  // world spawn where it landed.
  await rcon.cmd(`forceload add ${x} ${z}`);
  await rcon.cmd('kill @e[type=marker,tag=village_spawn]');
  await rcon.cmd(`summon marker ${x} 200 ${z} {Tags:["village_spawn"]}`);
  await rcon.cmd(`spreadplayers ${x} ${z} 0 1 false @e[type=marker,tag=village_spawn]`);
  const pos = parsePos(await entityData('@e[type=marker,tag=village_spawn,limit=1]', 'Pos'));
  if (!pos) { console.log('marker not placed yet'); return; }
  await rcon.cmd(`setworldspawn ${pos[0]} ${pos[1]} ${pos[2]}`);
  await rcon.cmd('kill @e[type=marker,tag=village_spawn]');
  await rcon.cmd(`forceload remove ${x} ${z}`);

  // Spawn right in the village, not somewhere random around it. The game
  // rule's name changed between versions, so try each spelling.
  for (const rule of ['respawn_radius', 'spawn_radius', 'spawnRadius']) {
    const r = await rcon.cmd(`gamerule ${rule} 0`);
    if (!/unknown|incorrect|expected/i.test(r)) break;
  }

  store.village = { x: pos[0], y: pos[1], z: pos[2], kind };
  save();
  console.log('village spawn set', store.village);

  for (const name of online) await rcon.cmd(`tp ${name} ${pos[0]} ${pos[1]} ${pos[2]}`);
}

async function giveKit(name) {
  for (const item of STARTER_KIT) await rcon.cmd(`give ${name} minecraft:${item.id} ${item.count}`);
  await rcon.cmd(`title ${name} title {"text":"Welcome to the Village!","color":"gold"}`);
  await rcon.cmd(`title ${name} subtitle {"text":"Here's everything you need","color":"green"}`);
  await rcon.cmd(`tellraw ${name} {"text":"Check your inventory: tools, food, a bed and emeralds to trade with the villagers!","color":"yellow"}`);
  store.kitted.push(name);
  save();
}

// ---------- reading the server log ----------

function knownNames() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'usercache.json'), 'utf8')).map(u => u.name); } catch { return []; }
}

function readEvents() {
  let text;
  try {
    const file = path.join(DATA, 'logs', 'latest.log');
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 128 * 1024);
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, size - len);
    fs.closeSync(fd);
    text = b.toString('utf8');
  } catch {
    return [];
  }
  const names = knownNames();
  const events = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\[(\d\d:\d\d:\d\d)\] \[Server thread\/INFO\]: (.*)$/);
    if (!m) continue;
    const msg = m[2].replace(/^\[Not Secure\] /, '');
    let kind = null;
    if (/^<[A-Za-z0-9_]{1,16}> /.test(msg)) kind = 'chat';
    else if (/ joined the game$/.test(msg)) kind = 'join';
    else if (/ left the game$/.test(msg)) kind = 'leave';
    else if (/ has (made the advancement|reached the goal|completed the challenge) /.test(msg)) kind = 'adv';
    else if (/^Done \(/.test(msg)) kind = 'server';
    else if (names.some(n => msg.startsWith(n + ' ')) && !/ lost connection/.test(msg)) kind = 'death';
    if (kind) events.push({ time: m[1], kind, text: kind === 'server' ? 'Server started' : msg });
  }
  return events.slice(-30).reverse();
}

// ---------- the polling loop ----------

let state = { online: false, players: [], events: [] };

async function poll() {
  const next = { online: false, version: MC_VERSION, kit: STARTER_KIT };
  try {
    const list = await rcon.cmd('list');
    const lm = list.match(/There are (\d+) of a max of (\d+) players online:(.*)/s);
    next.online = true;
    next.max = lm ? Number(lm[2]) : null;
    const names = lm ? lm[3].split(',').map(s => s.trim()).filter(n => NAME_RE.test(n)) : [];

    if (!store.village) await setUpVillage(names);
    for (const name of names) if (store.village && !store.kitted.includes(name)) await giveKit(name);

    // 1.21 says "The time is N" (a day count for `day`, ticks into the day
    // for `daytime`). 26.x has timelines instead: "Timeline minecraft:day is
    // at N tick(s)", where N counts ticks through all the days so far.
    const dayReply = await rcon.cmd('time query day');
    const timeline = dayReply.match(/is at (\d+) tick/);
    if (timeline) {
      const ticks = Number(timeline[1]);
      next.day = Math.floor(ticks / 24000) + 1;
      next.daytime = ticks % 24000;
    } else {
      next.day = Number((dayReply.match(/(\d+)/) || [])[1] ?? 0) + 1;
      next.daytime = Number(((await rcon.cmd('time query daytime')).match(/(\d+)/) || [])[1] ?? 0);
    }
    next.difficulty = ((await rcon.cmd('difficulty')).match(/difficulty is (\w+)/) || [])[1] || '';
    const villagers = (await rcon.cmd('execute if entity @e[type=villager]')).match(/count: (\d+)/);
    next.villagers = villagers ? Number(villagers[1]) : 0;

    next.players = [];
    for (const name of names) {
      next.players.push({
        name,
        health: parseFloat(await entityData(name, 'Health')) || 0,
        food: parseInt(await entityData(name, 'foodLevel')) || 0,
        xp: parseInt(await entityData(name, 'XpLevel')) || 0,
        pos: parsePos(await entityData(name, 'Pos')) || [0, 0, 0],
        dim: (await entityData(name, 'Dimension') || '').replace(/"/g, '').replace(/^minecraft:/, ''),
      });
    }
  } catch (e) {
    next.online = false;
    next.error = e.message;
  }
  next.village = store.village;
  next.villageNote = villageNote;
  next.events = readEvents();
  state = next;
}

(async function loop() {
  const start = Date.now();
  await poll();
  setTimeout(loop, Math.max(500, 2000 - (Date.now() - start)));
})();

// ---------- the Minecraft Wiki (MCP server from the Docker profile) ----------

class Wiki {
  constructor() {
    this.proc = null;
    this.ready = null;
    this.nextId = 1;
    this.waiting = new Map();
    this.buf = '';
  }

  start() {
    const proc = spawn('node', ['dist/server.js'], { cwd: '/app', stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc = proc;
    this.buf = '';
    proc.stdout.on('data', d => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const w = this.waiting.get(msg.id);
        if (!w) continue;
        this.waiting.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.error) w.reject(new Error(msg.error.message || 'wiki error'));
        else w.resolve(msg.result);
      }
    });
    proc.on('exit', () => {
      if (this.proc === proc) { this.proc = null; this.ready = null; }
      for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new Error('wiki stopped')); }
      this.waiting.clear();
    });
    this.ready = this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'village-server', version: '1.0.0' },
    }).then(() => this.notify('notifications/initialized'));
    this.ready.catch(() => {});
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('wiki timeout')); }, 20000);
      this.waiting.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  async call(tool, args) {
    if (!this.proc) this.start();
    await this.ready;
    const result = await this.request('tools/call', { name: tool, arguments: args });
    const text = (result.content || []).map(c => c.text || '').join('');
    if (result.isError) throw new Error(text || 'wiki error');
    try { return JSON.parse(text); } catch { return { text }; }
  }
}

const wiki = new Wiki();

// The wiki text has HTML bits and "[ edit edit source ]" links mixed in.
function tidy(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/span class=searchmatch/g, '').replace(/\/span/g, '')
    .replace(/\[ edit edit source \]/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function wikiApi(url) {
  const title = (url.searchParams.get('title') || '').slice(0, 200);
  if (url.pathname === '/api/wiki/search') {
    const q = (url.searchParams.get('q') || '').slice(0, 100).trim();
    if (!q) return { results: [] };
    const r = await wiki.call('MinecraftWiki_searchWiki', { query: q });
    return { results: (r.results || []).map(x => ({ title: x.title, snippet: tidy(x.snippet) })) };
  }
  if (url.pathname === '/api/wiki/page') {
    const r = await wiki.call('MinecraftWiki_getPageSummary', { title });
    return { title: r.title || title, summary: tidy(r.summary || r.text), sections: (r.sections || []).map(s => ({ index: s.index, title: tidy(s.title) })) };
  }
  if (url.pathname === '/api/wiki/section') {
    const index = Number(url.searchParams.get('index'));
    const r = await wiki.call('MinecraftWiki_getPageSection', { title, sectionIndex: index });
    return { title, index, content: tidy(r.content || r.text) };
  }
  return null;
}

// ---------- the web page ----------

const page = path.join(__dirname, 'index.html');

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (url.pathname === '/api/state') { json(res, 200, state); return; }
  if (url.pathname.startsWith('/api/wiki/')) {
    try {
      const body = await wikiApi(url);
      if (body) json(res, 200, body); else json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 502, { error: e.message });
    }
    return;
  }
  if (url.pathname === '/icon.png') {
    const icon = path.join(DATA, 'server-icon.png');
    if (!fs.existsSync(icon)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/png' });
    fs.createReadStream(icon).pipe(res);
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(page).pipe(res);
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(WEB_PORT, '127.0.0.1');
