// ============================================================
// Benin Life — multiplayer client on a REAL map of Benin City
// Storybook Benin renderer (illustrated canvas map, locked style B 2026-10-30).
// Movement, chat, zones and sim systems shared by both.
// ============================================================
'use strict';

const $ = (id) => document.getElementById(id);
const SPEED = 0.0013; // degrees/sec (~145 m/s, gamey)
let speedMult = 1;

let CFG = { mapsKey: '', spawn: { lat: 6.3345, lng: 5.6040 }, bounds: null };
let ws = null, token = localStorage.getItem('bl_token') || null;
let myName = localStorage.getItem('bl_name') || null;
let me = null;
const players = new Map(); // id -> {id,name,lat,lng,tlat,tlng,housing,gov}
const spawns = new Map(); // id -> {id,lat,lng,kind,icon,amount,expires}
const effects = []; // collect sparkles {lat,lng,t0}
let ZONES = {}, JOBS = {}, FOOD = {}, FUN = {}, HOUSING = {}, BOUNDS = null;
let BIZT = {}, VEHT = {};
let myBiz = null, election = { active: false }, governor = null, unreadDm = 0;
// social
let friends = []; // {id, other_id, other_username, status, incoming, online, lat, lng}
let rooms = [];   // {id, name, topic, icon, creator_id, members, joined, unread}
let openRoomId = null;
const roomHist = new Map(); // roomId -> [{name,text,ts,gov}]
let day = 1, dayEndsIn = 0, mode = 'login';
let quest = null; // item 11: daily quest from the server
let currentZone = null, manualClose = false;
let arrivalRing = null; // item 31: expanding ring on zone arrival (canvas, spring fade)
let reconnectTimer = null, manualLogout = false;
const keys = {};
let clickTarget = null;
let tapRipple = null; // item 212: expanding ring at the map tap point, drawn in frame()
let playerMoving = false; // set by stepPlayer; drives walk bob + dust puffs (item 5)
const bubbles = []; // {getPos:()=>{lat,lng}, text, until}
let renderer = null, loopStarted = false;
let zoneSeen = false; // item 20: arrival haptics gate (no buzz on first load)
// item 21: settings, persisted in localStorage (sound toggle wires to item 19)
let settings = { sound: true, reduceMotion: false, calmMap: true }; // calmMap: Max verdict 2026-11-01 — map was "too rowdy"; calm is the default, full ambience is opt-in via Settings
const lowWarned = new Set(); // item 33: one low-stat toast per dip, not per second
try { const _s = JSON.parse(localStorage.getItem('bl_settings') || 'null'); if (_s && typeof _s === 'object') settings = { ...settings, ..._s }; } catch {}
function saveSettings() { try { localStorage.setItem('bl_settings', JSON.stringify(settings)); } catch {} }
// item 19: WebAudio sound effects (no audio files) — coin on pay, pop on tap, chime on level-up
let _ac = null;
function sfx(kind) {
  if (!settings.sound) return;
  try {
    if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
    if (_ac.state === 'suspended') _ac.resume();
    const t0 = _ac.currentTime;
    const tone = (f, t, d, type) => { const o = _ac.createOscillator(), g = _ac.createGain(); o.type = type || 'sine'; o.frequency.setValueAtTime(f, t); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + d); o.connect(g); g.connect(_ac.destination); o.start(t); o.stop(t + d); };
    if (kind === 'coin') { tone(880, t0, 0.12); tone(1320, t0 + 0.09, 0.18); }
    else if (kind === 'pop') { tone(320, t0, 0.07, 'square'); }
    else if (kind === 'chime') { [523, 659, 784].forEach((f, i) => tone(f, t0 + i * 0.1, 0.25)); }
  } catch {}
}
// item 20: gentle vibration on arrival/rewards — guarded: navigator.vibrate only
// exists on supporting (Android) browsers, so iOS silently does nothing.
function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} }
function levelOf(xp) { return 1 + Math.floor(Math.max(0, Number(xp) || 0) / 150); }
// items 36/42: one game-hour helper for tint, lamps, sun/moon + HUD clock.
// A game day is 5 real minutes (server DAY_MS); progress maps to a 24h cycle.
// Test hook: window.__forceGameHour = 22 forces night for screenshots.
function gameHour() {
  if (typeof window !== 'undefined' && typeof window.__forceGameHour === 'number') return window.__forceGameHour;
  const DAY_LEN = 5 * 60 * 1000;
  const p = dayEndsIn > 0 ? Math.max(0, Math.min(1, 1 - dayEndsIn / DAY_LEN)) : 0;
  return p * 24;
}
// Real Benin City geography (OpenStreetMap, pre-processed into city.json):
// real roads, the Ikpoba river, parks — rendered into the Storybook base layer.
window.CITYDATA = null;
fetch('city.json').then(r => (r.ok ? r.json() : null)).then(d => {
  if (!d) return;
  window.CITYDATA = d;
  if (renderer && renderer.buildCity) renderer.buildCity();
}).catch(() => {});

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, t = Math.PI / 180;
  const dLat = (lat2 - lat1) * t, dLng = (lng2 - lng1) * t;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const colorFor = (id) => `hsl(${(id * 137) % 360} 70% 55%)`;
const fmt = (n) => '₦' + Number(n || 0).toLocaleString();

// ============================================================
// AUTH
// ============================================================
$('tab-login').onclick = () => setMode('login');
$('tab-register').onclick = () => setMode('register');
function setMode(m) {
  mode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-register').classList.toggle('active', m === 'register');
  $('auth-btn').textContent = m === 'login' ? 'Enter the city →' : 'Create account →';
  $('auth-err').textContent = '';
}
$('auth-btn').onclick = doAuth;
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(); });

async function doAuth() {
  const username = $('username').value.trim();
  const password = $('password').value;
  $('auth-err').textContent = '';
  if (!username || !password) { $('auth-err').textContent = 'Enter username and password.'; return; }
  const _authLabel = $('auth-btn').textContent;
  $('auth-btn').disabled = true; $('auth-btn').textContent = '🌆 Entering the city…';
  try {
    const r = await fetch('/api/' + mode, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Failed');
    token = j.token; myName = j.username;
    localStorage.setItem('bl_token', token);
    localStorage.setItem('bl_name', myName);
    connect();
  } catch (e) { $('auth-err').textContent = e.message; }
  $('auth-btn').disabled = false; $('auth-btn').textContent = _authLabel;
}
$('btn-logout').onclick = () => {
  manualLogout = true;
  localStorage.removeItem('bl_token'); localStorage.removeItem('bl_name');
  if (ws) ws.close();
  location.reload();
};
$('btn-admin').onclick = () => window.open('admin.html', '_blank');

// ============================================================
// WEBSOCKET
// ============================================================
function connect() {
  if (!token) return;
  manualLogout = false;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => $('reconnect').classList.add('hidden');
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
  ws.onclose = () => {
    if (manualLogout) return;
    $('reconnect').classList.remove('hidden');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2500);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

async function handle(m) {
  switch (m.t) {
    case 'init':
      me = m.you; day = m.day; dayEndsIn = m.endsIn;
      quest = m.quest || null; renderQuest();
      if (m.event) renderEvent(m.event);
      ZONES = m.zones; JOBS = m.jobs; FOOD = m.food; FUN = m.fun; HOUSING = m.housing; BOUNDS = m.bounds;
      BIZT = m.bizTypes; VEHT = m.vehicles;
      myBiz = m.biz; election = m.election; governor = m.governor;
      unreadDm = m.unreadDm || 0;
      friends = m.friends || [];
      rooms = m.rooms || [];
      speedMult = m.you.speedMult || 1;
      players.clear();
      for (const p of m.players) players.set(p.id, { ...p, tlat: p.lat, tlng: p.lng });
      spawns.clear();
      for (const s of (m.spawns || [])) spawns.set(s.id, s);
      $('auth-screen').classList.add('hidden');
      $('game-screen').classList.remove('hidden');
      if (me.is_admin) $('btn-admin').classList.remove('hidden');
      $('chat-msgs').innerHTML = '';
      for (const c of m.chat) addChat(c.name, c.text, c.name === myName, c.gov);
      addSys(`${myName} entered Benin City 🌆`);
      if (governor) addSys(`👑 ${governor.name} is the Governor of Benin City`);
      updateDmBadge();
      $('map-boot').classList.remove('hidden');
      await initRenderer();
      $('map-boot').classList.add('hidden');
      updateHUD(); startLoop();
      break;
    case 'spawn':
      spawns.set(m.s.id, m.s);
      break;
    case 'despawn':
      spawns.delete(m.id);
      break;
    case 'join': {
      const p = { ...m.p, tlat: m.p.lat, tlng: m.p.lng };
      players.set(m.p.id, p);
      if (renderer) renderer.playerIn(p);
      addSys(`${m.p.name} entered the city 👋`);
      updateOnline();
      break;
    }
    case 'leave': {
      const p = players.get(m.id);
      players.delete(m.id);
      if (renderer) renderer.playerOut(m.id);
      if (p) addSys(`${p.name} left the city`);
      updateOnline();
      break;
    }
    case 'mv': {
      const p = players.get(m.id);
      if (p) { p.tlat = m.lat; p.tlng = m.lng; }
      break;
    }
    case 'chat':
      addChat(m.name, m.text, m.name === myName, m.gov);
      bubbleFor(m.id, m.lat, m.lng, m.text);
      break;
    case 'snap':
      if (me) { me.lat = m.lat; me.lng = m.lng; clickTarget = null; }
      break;
    case 'you': {
      const prevCash = me ? me.cash : null, prevLevel = me ? (me.level || levelOf(me.xp)) : null;
      Object.assign(me, {
        cash: m.cash, energy: m.energy, hunger: m.hunger, happy: m.happy,
        housing: m.housing, cert: m.cert, lat: m.lat, lng: m.lng,
        vehicle: m.vehicle, savings: m.savings, loan: m.loan, gov: m.gov,
        xp: m.xp, level: m.level,
      });
      if (prevCash !== null && m.cash > prevCash) { sfx('coin'); buzz(40); } // items 19 + 20: reward feedback
      if (prevLevel !== null && (m.level || 0) > prevLevel) sfx('chime');
      if (m.speedMult) speedMult = m.speedMult;
      updateHUD();
      if (m.note) toast(m.note);
      if (!$('zone-panel').classList.contains('hidden') && currentZone) renderZone(currentZone);
      if (!$('menu-panel').classList.contains('hidden') && menuTab) renderMenuBody();
      }
    case 'biz':
      myBiz = m.biz;
      break;
    case 'election':
      election = m;
      if (!$('menu-panel').classList.contains('hidden') && menuTab === 'election') renderMenuBody();
      break;
    case 'gov':
      governor = { id: m.id, name: m.name };
      if (me) me.gov = (me.id === m.id);
      for (const p of players.values()) p.gov = (p.id === m.id);
      if (renderer && renderer.setGov) renderer.setGov(m.id);
      break;
    case 'stats':
      updateOnline(m.online);
      break;
    case 'dm':
      toast(`✉️ ${m.fromName}: ${m.text.slice(0, 60)}`);
      break;
    case 'dm_sent':
      break;
    case 'dm_unread':
      unreadDm = m.n;
      updateDmBadge();
      break;
    case 'dm_threads':
      renderThreads(m.threads);
      break;
    case 'dm_history':
      renderConversation(m.with, m.withName, m.msgs);
      break;
    case 'profile':
      renderProfile(m.p);
      break;
    case 'friends':
      friends = m.friends || [];
      renderFriends(); renderRequests(); updateSocialBadge();
      break;
    case 'friend_request':
      friends = m.friends || friends;
      renderFriends(); renderRequests(); updateSocialBadge();
      toast(`🤝 Friend request from ${m.from.username}!`);
      break;
    case 'rooms':
      rooms = m.rooms || [];
      renderRooms(); updateSocialBadge();
      break;
    case 'room_joined': {
      const r = rooms.find(x => Number(x.id) === Number(m.roomId));
      if (r) { r.joined = true; r.unread = 0; }
      if (m.history) roomHist.set(Number(m.roomId), m.history);
      send({ t: 'room_read', roomId: m.roomId });
      openRoomView(Number(m.roomId));
      renderRooms(); updateSocialBadge();
      break;
    }
    case 'room_left': {
      const rid = Number(m.roomId);
      const r = rooms.find(x => Number(x.id) === rid);
      if (r) { r.joined = false; r.unread = 0; }
      roomHist.delete(rid);
      if (openRoomId === rid) closeRoomView();
      renderRooms(); updateSocialBadge();
      break;
    }
    case 'room_msg': {
      const rid = Number(m.roomId);
      if (!roomHist.has(rid)) roomHist.set(rid, []);
      const h = roomHist.get(rid);
      h.push({ name: m.name, text: m.text, ts: m.ts, gov: m.gov });
      if (h.length > 50) h.splice(0, h.length - 50);
      if (openRoomId === rid) { appendRoomMsg(m); send({ t: 'room_read', roomId: rid }); }
      break;
    }
    case 'room_unread': {
      const r = rooms.find(x => Number(x.id) === Number(m.roomId));
      if (r && openRoomId !== Number(m.roomId)) { r.unread = m.unread; renderRooms(); updateSocialBadge(); }
      break;
    }
    case 'room_members':
      renderRoomMembers(Number(m.roomId), m.members || []);
      break;
    case 'mention':
      toast(`💬 ${m.from} mentioned you${m.roomName ? ' in ' + m.roomName : ' in City Chat'}!`);
      break;
    case 'sys': addSys(m.text); break;
    case 'err': toast('⚠️ ' + m.text); break;
    case 'day':
      day = m.day; dayEndsIn = m.endsIn; updateHUD();
      if (m.quest) { quest = m.quest; renderQuest(); }
      if (m.event) { renderEvent(m.event); toast(`${m.event.icon} Today's event: ${m.event.name}`); }
      addSys(`📅 Day ${day} begins in Benin City`);
      break;
    case 'quest':
      quest = m.quest; renderQuest();
      break;
  }
}

// ============================================================
// CHAT
// ============================================================
function addChat(name, text, isMe, gov) {
  const el = document.createElement('div');
  el.className = 'msg' + (isMe ? ' me' : '');
  const who = document.createElement('span');
  who.className = 'who'; who.textContent = (gov ? '👑 ' : '') + name + ': ';
  el.appendChild(who);
  el.appendChild(document.createTextNode(text));
  const box = $('chat-msgs');
  box.appendChild(el);
  while (box.children.length > 120) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
function addSys(text) {
  const el = document.createElement('div');
  el.className = 'msg sys'; el.textContent = text;
  const box = $('chat-msgs');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
function bubbleFor(pid, lat, lng, text) {
  const near = !me || haversineM(me.lat, me.lng, lat, lng) < 1500 || (me && pid === me.id);
  if (!near) return;
  const src = pid === (me && me.id) ? me : players.get(pid);
  bubbles.push({ src: src || { lat, lng }, text: text.slice(0, 80), until: Date.now() + 5000 });
  if (bubbles.length > 12) bubbles.shift();
}
function sendChat() {
  const inp = $('chat-input');
  const text = inp.value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  inp.value = '';
}
$('chat-send').onclick = sendChat;
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
function updateOnline(n) { $('online-count').textContent = `• ${n !== undefined ? n : players.size + 1} online`; }

// ============================================================
// RENDERERS
// ============================================================
const DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#161d29' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#161d29' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a9bb0' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c3a50' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a4c68' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0b1220' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];

function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.maps) return resolve();
    const to = setTimeout(() => reject(new Error('timeout')), 10000);
    window.__blMapsReady = () => { clearTimeout(to); resolve(); };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__blMapsReady`;
    s.async = true; s.defer = true;
    s.onerror = () => { clearTimeout(to); reject(new Error('load failed')); };
    document.head.appendChild(s);
  });
}

function dotIcon(color, big) {
  const r = big ? 15 : 12, sz = big ? 38 : 32;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}"><circle cx="${sz / 2}" cy="${sz / 2}" r="${r}" fill="${color}" stroke="white" stroke-width="3"/></svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(sz, sz),
    anchor: new google.maps.Point(sz / 2, sz / 2),
  };
}

class GoogleRenderer {
  async init() {
    $('gmap').classList.remove('hidden');
    $('btn-recenter').classList.remove('hidden');
    this.map = new google.maps.Map($('gmap'), {
      center: { lat: me.lat, lng: me.lng },
      zoom: 14, styles: DARK_STYLE,
      disableDefaultUI: true, zoomControl: true,
      gestureHandling: 'greedy', clickableIcons: false,
    });
    // zone circles + labels
    for (const [k, z] of Object.entries(ZONES)) {
      new google.maps.Circle({
        center: { lat: z.lat, lng: z.lng }, radius: z.r,
        strokeColor: z.color, strokeWeight: 2, fillColor: z.color, fillOpacity: 0.18, map: this.map,
      });
      new google.maps.Marker({
        position: { lat: z.lat, lng: z.lng }, map: this.map,
        icon: { url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', scaledSize: new google.maps.Size(1, 1) },
        label: { text: `${z.icon} ${z.name}`, color: '#eef4fa', fontSize: '13px', fontWeight: '700' },
        clickable: false,
      });
    }
    this.markers = new Map();
    this.follow = true;
    this.followPauseUntil = 0;
    this.map.addListener('dragstart', () => { this.followPauseUntil = Date.now() + 15000; });
    this.map.addListener('click', (e) => this.tapCb && this.tapCb(e.latLng.lat(), e.latLng.lng()));
    // projection overlay for bubbles
    const ov = new google.maps.OverlayView();
    ov.onAdd = function () {}; ov.draw = function () {};
    ov.setMap(this.map);
    this.overlay = ov;
    for (const p of players.values()) this.playerIn(p);
    this.playerIn({ ...me, name: me.name + ' (you)' }, true);
  }
  playerIn(p, isMe) {
    if (this.markers.has(p.id)) return;
    const mk = new google.maps.Marker({
      position: { lat: p.lat, lng: p.lng }, map: this.map,
      icon: dotIcon(colorFor(p.id), isMe), title: (p.gov ? '👑 ' : '') + p.name,
    });
    if (!isMe) mk.addListener('click', () => openProfile(p.id));
    this.markers.set(p.id, mk);
  }
  setGov(id) {
    for (const [pid, mk] of this.markers) {
      const pl = pid === (me && me.id) ? me : players.get(pid);
      if (pl) mk.setTitle((pid === id ? '👑 ' : '') + (pl.name || pl.username || ''));
    }
  }
  playerOut(id) {
    const mk = this.markers.get(id);
    if (mk) { mk.setMap(null); this.markers.delete(id); }
  }
  frame() {
    for (const p of players.values()) {
      const mk = this.markers.get(p.id);
      if (mk) mk.setPosition({ lat: p.lat, lng: p.lng });
    }
    const myMk = this.markers.get(me.id);
    if (myMk) myMk.setPosition({ lat: me.lat, lng: me.lng });
    if (this.follow && Date.now() > this.followPauseUntil) this.map.setCenter({ lat: me.lat, lng: me.lng });
  }
  project(lat, lng) {
    try {
      const pr = this.overlay.getProjection();
      if (!pr) return null;
      const pt = pr.fromLatLngToDivPixel(new google.maps.LatLng(lat, lng));
      const wrap = $('map-wrap').getBoundingClientRect();
      const mapEl = $('gmap').getBoundingClientRect();
      return { x: pt.x + (mapEl.left - wrap.left), y: pt.y + (mapEl.top - wrap.top) };
    } catch { return null; }
  }
  onTap(cb) { this.tapCb = cb; }
  recenter() { this.followPauseUntil = 0; this.map.setCenter({ lat: me.lat, lng: me.lng }); }
}

class CanvasRenderer {
  // Stylized Benin City: procedural road network, buildings, river, parks.
  // World units = meters relative to (6.34, 5.61). Camera: center + px/m.
  init() {
    $('map').classList.remove('hidden');
    $('btn-recenter').classList.remove('hidden');
    this.canvas = $('map');
    this.ctx = this.canvas.getContext('2d');
    this.tapCb = null;
    this.cam = { x: 0, y: 0, z: 0.02 };
    this.pinT0 = performance.now(); // item 4: zone-pin staggered spring pop-in
    this.dust = []; // item 5: walk dust puffs
    this._drizzleToasted = false; // item 9
    this.follow = true;
    this.pointers = new Map();
    this.pinchD0 = 0; this.pinchZ0 = 0;
    this.buildCity();
    this.bindInput();
    this.fit();
    const s = this.ll2m(CFG.spawn.lat, CFG.spawn.lng);
    this.cam.x = s.x; this.cam.y = s.y;
    this.cam.z = this.baseZoom();
    window.addEventListener('resize', () => this.fit());
    this.addZoomButtons();
  }
  // ---- geo ----
  ll2m(lat, lng) {
    return {
      x: (lng - 5.61) * 111320 * Math.cos(6.34 * Math.PI / 180),
      y: -(lat - 6.34) * 110540,
    };
  }
  m2ll(x, y) {
    return {
      lat: 6.34 - y / 110540,
      lng: 5.61 + x / (111320 * Math.cos(6.34 * Math.PI / 180)),
    };
  }
  w2s(x, y, w, h) {
    return { x: (x - this.cam.x) * this.cam.z + w / 2, y: (y - this.cam.y) * this.cam.z + h / 2 };
  }
  baseZoom() {
    const r = this.canvas.getBoundingClientRect();
    return Math.min(r.width, r.height) / 7800;
  }
  fit() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const z0 = this.baseZoom();
    this._bz = z0;
    this.cam.z = Math.max(z0 * 0.5, Math.min(z0 * 7, this.cam.z || z0));
  }
  setZoom(nz, e) {
    const z0 = this.baseZoom();
    nz = Math.max(z0 * 0.5, Math.min(z0 * 7, nz));
    if (e && e.clientX !== undefined) {
      const r = this.canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const wx = this.cam.x + (sx - r.width / 2) / this.cam.z;
      const wy = this.cam.y + (sy - r.height / 2) / this.cam.z;
      this.cam.z = nz;
      this.cam.x = wx - (sx - r.width / 2) / nz;
      this.cam.y = wy - (sy - r.height / 2) / nz;
    } else this.cam.z = nz;
  }
  // ---- city generation (deterministic) ----
  buildCity() {
    let seed = 987654321;
    const rnd = () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const ZM = {};
    for (const [k, z] of Object.entries(ZONES)) ZM[k] = { ...this.ll2m(z.lat, z.lng), r: z.r };
    this.ZM = ZM;
    const CD = window.CITYDATA || null;
    this.real = !!CD;
    // Ikpoba river: real OSM geometry when the city data is loaded, else schematic
    this.river = [];
    if (CD && CD.river && CD.river.length) this.river = CD.river[0];
    else for (let i = 0; i <= 40; i++) {
      const y = -6500 + (13000 * i) / 40;
      const x = 4300 + Math.sin(i * 0.55) * 700 + Math.sin(i * 0.21) * 300;
      this.river.push([x, y]);
    }
    this.parks = [
      { x: -2700, y: -1900, r: 560 }, { x: 2900, y: 2500, r: 440 }, { x: -900, y: 3500, r: 400 },
    ];
    if (CD && CD.greenPoly) { // building-exclusion circles around the real green areas
      this.parks = CD.greenPoly.map(poly => {
        let cx = 0, cy = 0; for (const [px, py] of poly) { cx += px; cy += py; }
        cx /= poly.length; cy /= poly.length;
        let r = 0; for (const [px, py] of poly) r = Math.max(r, Math.hypot(px - cx, py - cy));
        return { x: cx, y: cy, r: r * 0.8 };
      }).filter(pk => pk.r > 60);
    }
    // roads: REAL Benin City street geometry (OpenStreetMap) when loaded;
    // the schematic ring + radials remain only as an offline fallback.
    this.roads = [];
    if (CD) {
      for (const pts of CD.major) this.roads.push({ pts, w: 46, c: '#e8b33d', dash: true });
      for (const pts of CD.minor) this.roads.push({ pts, w: 28, c: '#dfa92e', dash: false });
    } else {
    const ringC = ZM.ring;
    const ringPts = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      ringPts.push([ringC.x + Math.cos(a) * 980, ringC.y + Math.sin(a) * 880]);
    }
    this.roads.push({ pts: ringPts, w: 52, c: '#e8b33d', dash: true });
    const bez = (p0, p1, p2, n) => {
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n, u = 1 - t;
        pts.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
      }
      return pts;
    };
    for (const k of Object.keys(ZONES)) { if (k === 'ring') continue;
      const z = ZM[k];
      const ang = Math.atan2(z.y - ringC.y, z.x - ringC.x);
      const p0 = [ringC.x + Math.cos(ang) * 980, ringC.y + Math.sin(ang) * 880];
      const mid = [(p0[0] + z.x) / 2, (p0[1] + z.y) / 2];
      const dx = z.x - p0[0], dy = z.y - p0[1], len = Math.hypot(dx, dy) || 1;
      const off = 260 + rnd() * 200;
      const p1 = [mid[0] - dy / len * off, mid[1] + dx / len * off];
      this.roads.push({ pts: bez(p0, p1, [z.x, z.y], 26), w: 34, c: '#e8b33d', dash: true });
    }
    const link = (a, b) => {
      const A = ZM[a], B = ZM[b];
      const mid = [(A.x + B.x) / 2 + (rnd() - 0.5) * 500, (A.y + B.y) / 2 + (rnd() - 0.5) * 500];
      this.roads.push({ pts: bez([A.x, A.y], mid, [B.x, B.y], 18), w: 22, c: '#dfa92e', dash: false });
    };
    link('oba', 'newbenin'); link('zoo', 'kada'); link('housing', 'ring'); link('newbenin', 'uniben');
    link('palace', 'igun'); link('igun', 'ekiosa'); link('ekiosa', 'sapele'); link('uniben', 'ugbowo'); link('zoo', 'airport'); link('stadium', 'airport'); link('museum', 'stadium'); link('oba', 'hospital'); link('housing', 'ekiosa'); link('ekenwan', 'airport'); link('ugbowo', 'museum');
    }
    // flattened segments for distance checks, in a spatial grid (fast lookups)
    const cell = 400;
    const grid = new Map();
    const gkey = (cx, cy) => cx + ',' + cy;
    const addSeg = (s, m) => {
      const x0 = Math.min(s[0], s[2]) - m, x1 = Math.max(s[0], s[2]) + m;
      const y0 = Math.min(s[1], s[3]) - m, y1 = Math.max(s[1], s[3]) + m;
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
        for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
          const k = gkey(cx, cy);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push({ s, m });
        }
    };
    for (const r of this.roads)
      for (let i = 0; i < r.pts.length - 1; i++)
        addSeg([r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1]], 60);
    for (let i = 0; i < this.river.length - 1; i++)
      addSeg([this.river[i][0], this.river[i][1], this.river[i + 1][0], this.river[i + 1][1]], this.real ? 150 : 210);
    if (CD) { // keep buildings off the real side streets and out of water/green areas
      for (const line of [...CD.streets, ...CD.service])
        for (let i = 0; i < line.length - 1; i++)
          addSeg([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]], 24);
      for (const poly of [...CD.waterPoly, ...CD.greenPoly])
        for (let i = 0; i < poly.length - 1; i++)
          addSeg([poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]], 40);
    }
    const distSeg = (px, py, s) => {
      const dx = s[2] - s[0], dy = s[3] - s[1];
      const l2 = dx * dx + dy * dy || 1;
      let t = ((px - s[0]) * dx + (py - s[1]) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy));
    };
    const blocked = (x, y) => {
      const k = gkey(Math.floor(x / cell), Math.floor(y / cell));
      const arr = grid.get(k);
      if (!arr) return false;
      for (const { s, m } of arr) if (distSeg(x, y, s) < m) return true;
      return false;
    };
    // buildings
    this.buildings = [];
    for (let gx = -6500; gx <= 6500; gx += 150) {
      for (let gy = -6500; gy <= 6500; gy += 150) {
        if (rnd() < 0.38) continue;
        const x = gx + (rnd() - 0.5) * 110, y = gy + (rnd() - 0.5) * 110;
        if (blocked(x, y)) continue;
        if (this.parks.some(p => Math.hypot(x - p.x, y - p.y) < p.r + 70)) continue;
        if (Object.values(ZM).some(z => Math.hypot(x - z.x, y - z.y) < z.r + 130)) continue;
        const w = 45 + rnd() * 70, h = 45 + rnd() * 70;
        const WALLS = ['#fff7e8', '#fecaca', '#bfdbfe', '#bbf7d0', '#fde68a', '#ffedd5', '#e9d5ff'];
        const ROOFS = ['#b45309', '#92400e', '#b91c1c', '#9a3412', '#78350f'];
        this.buildings.push({
          x: x - w / 2, y: y - h / 2, w, h,
          c: WALLS[Math.floor(rnd() * WALLS.length)],
          roof: ROOFS[Math.floor(rnd() * ROOFS.length)],
        });
      }
    }
    // palm trees (deterministic scatter, kept off roads/river/zones)
    this.palms = [];
    for (let i = 0; i < 200 && this.palms.length < 60; i++) {
      const x = -6400 + rnd() * 12800, y = -6400 + rnd() * 12800;
      if (blocked(x, y)) continue;
      if (Object.values(ZM).some(z => Math.hypot(x - z.x, y - z.y) < z.r * 0.7)) continue;
      this.palms.push({ x, y, s: 0.8 + rnd() * 0.7, phase: rnd() * Math.PI * 2 }); // item 6: per-palm sway phase
    }
    // drifting illustrated clouds (item 2): deterministic, slow, soft, low opacity
    this.clouds = [];
    for (let i = 0; i < 9; i++) {
      this.clouds.push({
        x: -7000 + rnd() * 14000, y: -6500 + rnd() * 13000,
        s: 0.7 + rnd() * 0.9, v: 18 + rnd() * 26, a: 0.30 + rnd() * 0.16,
      });
    }
    // birds crossing the map (item 3): 3 flocks on slow looping elliptical paths
    this.birds = [];
    for (let i = 0; i < 3; i++) {
      this.birds.push({
        cx: -3500 + i * 3500, cy: -3200 + i * 2800,
        rx: 2600 + i * 600, ry: 850 + i * 300,
        sp: 0.045 + i * 0.012, ph: rnd() * Math.PI * 2, n: 5,
      });
    }
    // item 13: ambient residents — illustrated NPC wanderers (client ambience only,
    // no server state, no interaction): they stroll around their home zone and
    // greet with a speech bubble for part of each cycle.
    this.npcs = [
      { name: 'Mama Nkechi', emoji: '👵', home: 'oba', greet: ['Good morning o!', 'Fresh pepper soup today!', 'How market?'] },
      { name: 'Baba Tunde', emoji: '👴', home: 'ring', greet: ['Welcome to Benin!', 'Keke dey go Ugbowo!', 'Edo nor be Lagos o!'] },
      { name: 'Adaeze', emoji: '👩', home: 'uniben', greet: ['Lectures done!', 'Shawarma or suya?', 'UNIBEN no dey carry last!'] },
      { name: 'Emeka', emoji: '🧑', home: 'newbenin', greet: ['Fine fine shirts!', 'Come and buy!', 'Market don open!'] },
      { name: 'Funke', emoji: '👧', home: 'kada', greet: ['Cinema tonight?', 'Vibes on vibes!', 'Kada Plaza sweet!'] },
      { name: 'Chief Osaro', emoji: '🧔', home: 'palace', greet: ['Respect the palace.', 'Benin history deep o!', 'Oba gha tokpere!'] },
    ].map((n, i) => ({ ...n, ph: i * 1.7, sp: 0.05 + (i % 3) * 0.02, r: 170 + i * 45 }));
    // street / area labels: real OSM road names when the city data is loaded
    const AREA = [
      [6.3520, 5.5900, 'Uselu'], [6.3680, 5.6480, 'Aduwawa'], [6.3580, 5.6600, 'Ikpoba Hill'],
      [6.2960, 5.5680, 'Ogba Forest'], [6.3180, 5.6450, 'Ikpoba River'],
    ];
    const areaLabels = AREA.map(([lat, lng, text]) => ({ ...this.ll2m(lat, lng), text }));
    if (CD && CD.labels) {
      this.labels = CD.labels.map(([x, y, text]) => ({ x, y, text })).concat(areaLabels);
    } else {
      const LBL = [
        [6.3345, 5.6040, "King's Square"], [6.3410, 5.6260, 'Akpakpava Rd'],
        [6.3270, 5.6080, 'Mission Rd'], [6.3060, 5.6220, 'Sapele Rd'],
        [6.3120, 5.5880, 'Airport Rd'], [6.3000, 5.5800, 'Ekehuan Rd'],
        [6.3720, 5.6060, 'Ugbowo–Lagos Rd'],
      ];
      this.labels = LBL.map(([lat, lng, text]) => ({ ...this.ll2m(lat, lng), text })).concat(areaLabels);
    }
    if (CD) this.buildBase(CD); else this.base = null;
  }
  // Pre-render the real city (OpenStreetMap) once into a static base image,
  // painted in Storybook style: green areas, water, then streets by class
  // with ochre majors and cream dashes. The frame just blits it each tick.
  buildBase(CD) {
    let minX = 1e12, minY = 1e12, maxX = -1e12, maxY = -1e12;
    const scan = (lines) => { for (const L of lines) for (const [x, y] of L) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } };
    scan(CD.major); scan(CD.minor); scan(CD.streets); scan(CD.river); scan(CD.greenPoly); scan(CD.waterPoly);
    minX -= 350; minY -= 350; maxX += 350; maxY += 350;
    const BS = 0.2;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil((maxX - minX) * BS); cv.height = Math.ceil((maxY - minY) * BS);
    const b = cv.getContext('2d');
    b.lineCap = 'round'; b.lineJoin = 'round';
    const path = (L, close) => { b.beginPath(); L.forEach(([x, y], i) => { const px = (x - minX) * BS, py = (y - minY) * BS; i ? b.lineTo(px, py) : b.moveTo(px, py); }); if (close) b.closePath(); };
    for (const poly of CD.greenPoly) { path(poly, true); b.fillStyle = '#a9d18c'; b.fill(); }
    for (const poly of CD.waterPoly) { path(poly, true); b.fillStyle = '#a9d9f2'; b.fill(); }
    for (const L of CD.streams) { path(L); b.strokeStyle = 'rgba(125,211,252,0.75)'; b.lineWidth = 30 * BS; b.stroke(); }
    for (const L of CD.river) { path(L); b.strokeStyle = '#7cc0e8'; b.lineWidth = 130 * BS; b.stroke(); path(L); b.strokeStyle = '#a9d9f2'; b.lineWidth = 104 * BS; b.stroke(); }
    for (const L of CD.service) { path(L); b.strokeStyle = '#e7cd97'; b.lineWidth = Math.max(1.4, 11 * BS); b.stroke(); }
    for (const L of CD.streets) { path(L); b.strokeStyle = '#dcba77'; b.lineWidth = Math.max(1.6, 16 * BS); b.stroke(); }
    for (const L of CD.minor) { path(L); b.strokeStyle = 'rgba(58,36,16,0.45)'; b.lineWidth = 40 * BS; b.stroke(); path(L); b.strokeStyle = '#f2c14e'; b.lineWidth = 29 * BS; b.stroke(); }
    for (const L of CD.major) { path(L); b.strokeStyle = 'rgba(58,36,16,0.55)'; b.lineWidth = 58 * BS; b.stroke(); path(L); b.strokeStyle = '#e8b33d'; b.lineWidth = 46 * BS; b.stroke(); path(L); b.strokeStyle = 'rgba(255,247,232,0.8)'; b.lineWidth = 2; b.setLineDash([9, 11]); b.stroke(); b.setLineDash([]); }
    for (const poly of CD.greenPoly) { path(poly, true); b.strokeStyle = 'rgba(58,36,16,0.25)'; b.lineWidth = 2; b.stroke(); }
    this.base = { c: cv, x0: minX, y0: minY, s: BS };
  }
  // ---- input: tap = move, drag = pan, pinch/wheel = zoom ----
  bindInput() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => {
      try { c.setPointerCapture(e.pointerId); } catch {}
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: Date.now(), moved: false });
      if (this.pointers.size === 2) {
        this.multiTouch = true;
        const p = [...this.pointers.values()];
        this.pinchD0 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        this.pinchZ0 = this.cam.z;
      }
    });
    c.addEventListener('pointermove', (e) => {
      const pt = this.pointers.get(e.pointerId);
      if (!pt) return;
      const dx = e.clientX - pt.x, dy = e.clientY - pt.y;
      pt.x = e.clientX; pt.y = e.clientY;
      if (Math.hypot(e.clientX - pt.sx, e.clientY - pt.sy) > 12) pt.moved = true;
      if (this.pointers.size === 1) {
        if (pt.moved) {
          this.follow = false;
          this.cam.x -= dx / this.cam.z;
          this.cam.y -= dy / this.cam.z;
        }
      } else if (this.pointers.size === 2) {
        const p = [...this.pointers.values()];
        const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        if (this.pinchD0 > 0) this.setZoom(this.pinchZ0 * d / this.pinchD0);
        this.follow = false;
      }
    });
    const up = (e) => {
      const pt = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      const wasPinch = this.multiTouch;
      if (this.pointers.size === 0) this.multiTouch = false;
      if (pt && this.pointers.size === 0 && !pt.moved && !wasPinch && Date.now() - pt.t < 500) this.handleTap(e);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setZoom(this.cam.z * Math.pow(1.0016, -e.deltaY), e);
      this.follow = false;
    }, { passive: false });
  }
  handleTap(e) {
    sfx('pop'); // item 19: tap feedback
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    // street finds first (GO-style tap interaction)
    for (const sp of spawns.values()) {
      const m = this.ll2m(sp.lat, sp.lng);
      const s = this.w2s(m.x, m.y, r.width, r.height);
      if (Math.hypot(s.x - x, s.y - y) < 32) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'collect', id: sp.id }));
        effects.push({ lat: sp.lat, lng: sp.lng, t0: performance.now() });
        return;
      }
    }
    for (const p of players.values()) {
      const m = this.ll2m(p.lat, p.lng);
      const s = this.w2s(m.x, m.y, r.width, r.height);
      if (Math.hypot(s.x - x, s.y - y) < 30) { openProfile(p.id); return; }
    }
    const wx = this.cam.x + (x - r.width / 2) / this.cam.z;
    const wy = this.cam.y + (y - r.height / 2) / this.cam.z;
    const ll = this.m2ll(wx, wy);
    ll.lat = clamp(ll.lat, BOUNDS.latMin, BOUNDS.latMax);
    ll.lng = clamp(ll.lng, BOUNDS.lngMin, BOUNDS.lngMax);
    if (this.tapCb) this.tapCb(ll.lat, ll.lng);
  }
  addZoomButtons() {
    let el = $('map-zoom');
    if (!el) {
      el = document.createElement('div');
      el.id = 'map-zoom';
      el.innerHTML = '<button aria-label="Zoom in">+</button><button aria-label="Zoom out">−</button>';
      $('map-wrap').appendChild(el);
      el.children[0].onclick = () => this.setZoom(this.cam.z * 1.4);
      el.children[1].onclick = () => this.setZoom(this.cam.z / 1.4);
    }
    el.classList.remove('hidden');
  }
  playerIn() {} playerOut() {}
  // ---- draw ----
  rr(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }
  pill(x, y, text, font, fg, bg) {
    const ctx = this.ctx;
    ctx.font = font;
    const tw = ctx.measureText(text).width;
    const pad = 9, ph = 24;
    this.rr(x - tw / 2 - pad, y - ph / 2, tw + pad * 2, ph, 12);
    ctx.fillStyle = 'rgba(58,36,16,0.9)';
    this.rr(x - tw / 2 - pad + 2.5, y - ph / 2 + 3, tw + pad * 2, ph, 12); ctx.fill();
    ctx.fillStyle = bg; this.rr(x - tw / 2 - pad, y - ph / 2, tw + pad * 2, ph, 12); ctx.fill();
    ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 1);
    ctx.textBaseline = 'alphabetic';
  }
  frame() {
    const ctx = this.ctx, c = this.canvas;
    // item 26: quality scaler — SUSTAINED slow frames step decorations down
    // (2 full → 1 no clouds/birds → 0 no labels/chimney smoke), never back up.
    // Consecutive-only (a fast frame resets the streak) + 120-frame steps, so a
    // brief hitch never strips the map; only a genuinely struggling device does.
    if (this.quality === undefined) this.quality = 2;
    const _now = performance.now();
    if (this._lastFrame) {
      if (_now - this._lastFrame > 33) {
        this._slow = (this._slow || 0) + 1;
        if (this._slow >= 120 && this.quality > 0) { this.quality -= 1; this._slow = 0; }
      } else this._slow = 0;
    }
    this._lastFrame = _now; window.__blQuality = this.quality;
    const r = c.getBoundingClientRect(), w = r.width, h = r.height;
    if (me && this.follow) {
      const m = this.ll2m(me.lat, me.lng);
      this.cam.x += (m.x - this.cam.x) * 0.14;
      this.cam.y += (m.y - this.cam.y) * 0.14;
    }
    const z = this.cam.z;
    const S = (x, y) => this.w2s(x, y, w, h);
    const rmCalm = settings.reduceMotion || settings.calmMap !== false; // calm-by-default gate for ALL drifting map ambience
    const t = rmCalm ? performance.now() / 10000 : performance.now() / 1000; // item 21: reduce-motion slows (never freezes) map animation
    // === original dark theme ===
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#f6dcab'); g.addColorStop(1, '#efc98f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const x0 = this.cam.x - w / 2 / z, x1 = this.cam.x + w / 2 / z;
    const y0 = this.cam.y - h / 2 / z, y1 = this.cam.y + h / 2 / z;
    const vis = (x, y, m) => x > x0 - m && x < x1 + m && y > y0 - m && y < y1 + m;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // real-city base layer (OSM geography, pre-rendered Storybook style)
    if (this.base) {
      const tl = S(this.base.x0, this.base.y0);
      ctx.drawImage(this.base.c, tl.x, tl.y, this.base.c.width * z / this.base.s, this.base.c.height * z / this.base.s);
    }
    // Ikpoba River sparkle (item 7): light dashes gliding along the water
    if (this.river && this.river.length > 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (let i = 0; i < this.river.length - 1; i += 6) {
        const [ax, ay] = this.river[i], [bx, by] = this.river[i + 1];
        if (!vis((ax + bx) / 2, (ay + by) / 2, 300)) continue;
        const p = ((t * 0.05 + i * 0.13) % 1 + 1) % 1;
        const mx = ax + (bx - ax) * p, my = ay + (by - ay) * p;
        const sa = S(mx, my), sb = S(bx, by), saa = S(ax, ay);
        const dx = sb.x - saa.x, dy = sb.y - saa.y, dl = Math.hypot(dx, dy) || 1;
        ctx.beginPath();
        ctx.moveTo(sa.x - dx / dl * 6, sa.y - dy / dl * 6);
        ctx.lineTo(sa.x + dx / dl * 6, sa.y + dy / dl * 6);
        ctx.stroke();
      }
    }
    // === item 170: river boats — small canoes drifting along the Ikpoba River by day ===
    // Hidden under reduce-motion (calm map), like the other drifting ambience.
    { window.__blBoats = 0;
      const _bHour = gameHour(); const _bNight = (typeof window !== 'undefined' && window.__forceNight === true) || _bHour >= 20 || _bHour < 5;
      if (this.river && this.river.length > 2 && !_bNight && !rmCalm) for (let i = 0; i < 3; i++) {
        const fi = Math.floor((((t * 0.008 + i * 0.33) % 1 + 1) % 1) * (this.river.length - 2));
        const [ax, ay] = this.river[fi], [bx, by] = this.river[fi + 1];
        if (!vis((ax + bx) / 2, (ay + by) / 2, 300)) continue;
        const sa = S(ax, ay), sb = S(bx, by); const ang = Math.atan2(sb.y - sa.y, sb.x - sa.x);
        const mx = (sa.x + sb.x) / 2, my = (sa.y + sb.y) / 2;
        ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
        ctx.fillStyle = '#7c4a21'; ctx.beginPath(); ctx.ellipse(0, 0, 12, 4.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#fff7e8'; ctx.beginPath(); ctx.moveTo(-2, -4); ctx.lineTo(2, -4); ctx.lineTo(0, -11); ctx.closePath(); ctx.fill();
        ctx.restore(); window.__blBoats++;
      } }
    // === item 210: night streetlights — warm glowing dots spaced along major roads at night ===
    // Hidden under reduce-motion (calm map), like lanterns/fireflies.
    { window.__blStreetlights = 0;
      const _sHour = gameHour(); const _sNight = (typeof window !== 'undefined' && window.__forceNight === true) || _sHour >= 20 || _sHour < 5;
      if (_sNight && !rmCalm && this.roads)
        for (const rd of this.roads) {
          if (rd.w < 34) continue; // majors only (real majors + schematic ring/radials)
          for (let i = 0; i < rd.pts.length; i += 4) {
            const [lx, ly] = rd.pts[i];
            if (!vis(lx, ly, 60)) continue;
            const ls = S(lx, ly);
            const flick = 0.7 + 0.3 * Math.sin(t * 2 + i * 1.3);
            ctx.fillStyle = `rgba(255,190,80,${(0.30 * flick).toFixed(3)})`;
            ctx.beginPath(); ctx.arc(ls.x, ls.y, 7, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = `rgba(255,220,140,${(0.9 * flick).toFixed(3)})`;
            ctx.beginPath(); ctx.arc(ls.x, ls.y, 2.5, 0, Math.PI * 2); ctx.fill();
            window.__blStreetlights++;
          }
        } }
    // river (schematic fallback only)
    if (!this.base) {
    ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 316 * z;
    ctx.beginPath();
    this.river.forEach(([x, y], i) => { const s = S(x, y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
    ctx.stroke();
    ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 292 * z;
    ctx.stroke();
    ctx.strokeStyle = '#a5e3ff'; ctx.lineWidth = 200 * z;
    ctx.stroke();
    }
    // parks (schematic fallback only; real green areas are in the base layer)
    if (!this.base) for (const p of this.parks) {
      if (!vis(p.x, p.y, p.r)) continue;
      const s = S(p.x, p.y);
      ctx.fillStyle = '#a7d08a';
      ctx.beginPath(); ctx.arc(s.x, s.y, p.r * z, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c2e6a4';
      ctx.beginPath(); ctx.arc(s.x, s.y, p.r * 0.72 * z, 0, Math.PI * 2); ctx.fill();
    }
    // buildings
    // item 120: night house window lights (flicker, counted; hidden under reduce-motion like lanterns)
    const _nightB = gameHour() >= 20 || gameHour() < 5 || (typeof window !== 'undefined' && window.__forceNight === true);
    window.__blWindows = 0;
    for (let bi = 0; bi < this.buildings.length; bi++) {
      const b = this.buildings[bi];
      if (b.x > x1 || b.x + b.w < x0 || b.y > y1 || b.y + b.h < y0) continue;
      const s = S(b.x, b.y);
      const bw = Math.max(2.5, b.w * z), bh = Math.max(2.5, b.h * z);
      if (bw <= 7) { // zoomed out: calm warm blocks, colour arrives as you zoom in
        ctx.fillStyle = (b.x + b.y) % 3 === 0 ? '#dcc493' : '#e6d3a3';
        ctx.fillRect(s.x, s.y, bw, bh);
        continue;
      }
      ctx.fillStyle = b.c;
      ctx.fillRect(s.x, s.y, bw, bh);
      ctx.strokeStyle = 'rgba(58,36,16,0.65)'; ctx.lineWidth = 1; ctx.strokeRect(s.x, s.y, bw, bh);
      if (bw > 7) {
        ctx.fillStyle = b.roof || '#b45309';
        ctx.beginPath();
        ctx.moveTo(s.x - 1.5, s.y + 1); ctx.lineTo(s.x + bw / 2, s.y - bh * 0.34); ctx.lineTo(s.x + bw + 1.5, s.y + 1); ctx.closePath(); ctx.fill();
      }
      // item 120: one warm lit window per visible house at night (bw>12 keeps it to zoomed-in houses)
      if (_nightB && !rmCalm && bw > 12) {
        const wa = 0.55 + 0.35 * Math.sin(t * 2.2 + bi * 1.7);
        ctx.fillStyle = `rgba(255,190,80,${wa.toFixed(3)})`;
        ctx.fillRect(s.x + bw * 0.28, s.y + bh * 0.38, 4.5, 5.5);
        ctx.strokeStyle = 'rgba(58,36,16,0.5)'; ctx.lineWidth = 0.8;
        ctx.strokeRect(s.x + bw * 0.28, s.y + bh * 0.38, 4.5, 5.5);
        window.__blWindows++;
      }
      // item 8: chimneys + drifting smoke, only at high zoom (all houses —
      // the every-3rd gate hid chimneys across whole neighbourhoods in testing)
      if ((this.quality ?? 2) >= 1 && z > (this._bz || z) * 1.6 && bw > 12) {
        const chX = s.x + bw * 0.68, chY = s.y - bh * 0.30;
        ctx.fillStyle = '#8a6d4a'; ctx.fillRect(chX, chY - 7, 5, 8);
        ctx.strokeStyle = 'rgba(58,36,16,0.6)'; ctx.lineWidth = 1; ctx.strokeRect(chX, chY - 7, 5, 8);
        for (let k = 0; k < 3; k++) {
          const cyc = ((t * 0.35 + bi * 0.13 + k / 3) % 1 + 1) % 1;
          ctx.fillStyle = `rgba(255,247,232,${((1 - cyc) * 0.45).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(chX + 2.5 + cyc * 9 + Math.sin(t * 2 + bi + k) * 1.5, chY - 9 - cyc * 26, 2 + cyc * 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    // roads (proper network, dark)
    // palms (under roads so streets stay readable)
    ctx.textAlign = 'center';
    for (const pm of (this.palms || [])) {
      if (!vis(pm.x, pm.y, 120)) continue;
      const s = S(pm.x, pm.y);
      ctx.font = `${Math.max(10, Math.min(22, 14 * pm.s * Math.sqrt(z / (this._bz || z))))}px sans-serif`;
      const sway = Math.sin(t * 1.3 + (pm.phase || 0)) * 3; // item 6: gentle per-palm sway
      ctx.fillText('🌴', s.x + sway, s.y);
    }
    // street / area labels
    if ((this.quality ?? 2) >= 1 && z > (this._bz || z) * 0.55) {
      ctx.font = 'italic 600 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(58,36,16,0.55)';
      for (const lb of (this.labels || [])) {
        if (!vis(lb.x, lb.y, 300)) continue;
        const s = S(lb.x, lb.y);
        ctx.fillText(lb.text, s.x, s.y);
      }
    }
    if (!this.base) for (const rd of this.roads) {
      ctx.strokeStyle = 'rgba(58,36,16,0.85)'; ctx.lineWidth = Math.max(2.5, rd.w * z + 2.5);
      ctx.beginPath();
      rd.pts.forEach(([x, y], i) => { const s = S(x, y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      ctx.stroke();
      ctx.strokeStyle = rd.c; ctx.lineWidth = Math.max(2, rd.w * z);
      ctx.beginPath();
      rd.pts.forEach(([x, y], i) => { const s = S(x, y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      ctx.stroke();
      if (rd.dash && z > 0.008) {
        ctx.strokeStyle = 'rgba(255,247,232,0.75)'; ctx.lineWidth = Math.max(1, 3 * z * 10);
        ctx.setLineDash([16 * z * 10, 22 * z * 10]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // === zones: Storybook districts + pill pins (no giant glowing circles) ===
    // item 122: soft shadow under each pin (counted for tests; static, so not reduce-motion gated)
    window.__blPinShadows = 0;
    const MAJOR = new Set(['ring', 'oba', 'newbenin', 'uniben', 'zoo', 'kada', 'housing']);
    let zi = 0;
    for (const [k, zv] of Object.entries(ZONES)) {
      const zIdx = zi++;
      const zm = this.ZM[k];
      if (!vis(zm.x, zm.y, zv.r)) continue;
      const s = S(zm.x, zm.y), rad = zv.r * z;
      const inRange = currentZone === k;
      // soft district territory
      ctx.fillStyle = zv.color + '30';
      ctx.beginPath(); ctx.arc(s.x, s.y, rad, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = zv.color + '55'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, rad, 0, Math.PI * 2); ctx.stroke();
      if (inRange) {
        ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, rad + 5 + Math.sin(t * 4) * 2.5, 0, Math.PI * 2); ctx.stroke();
      }
      // pill pin: breathes gently; minor places are icon-only until you zoom in.
      // Downtown zones sit close together, so badges get small declutter offsets.
      const PIN_OFF = { ring: [0, -40], palace: [52, -16], igun: [-52, 14], hospital: [58, 20], museum: [-58, -22], oba: [54, -2], ekiosa: [-54, 34], housing: [44, 30] };
      const off = PIN_OFF[k] || [0, 0];
      const cx = s.x + off[0], cy = s.y - 8 + off[1];
      const breathe = 1 + Math.sin(t * 2.2 + zm.x * 0.01) * 0.045;
      const showName = MAJOR.has(k) || inRange || z > (this._bz || z) * 1.25;
      ctx.fillStyle = '#3a2410';
      ctx.beginPath(); ctx.arc(s.x, s.y, 3.2, 0, Math.PI * 2); ctx.fill();
      // item 122: pin shadow ellipse under the pill pin
      ctx.fillStyle = 'rgba(58,36,16,0.25)';
      ctx.beginPath(); ctx.ellipse(cx, cy + 24, 17, 4.5, 0, 0, Math.PI * 2); ctx.fill();
      window.__blPinShadows++;
      if (off[0] || off[1]) {
        ctx.strokeStyle = 'rgba(58,36,16,0.6)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(cx, cy + 10); ctx.stroke();
      }
      // item 4: staggered spring pop-in on first load (90ms apart, easeOutBack)
      const popAge = (performance.now() - (this.pinT0 || 0)) / 1000 - zIdx * 0.09;
      const pp = Math.max(0, Math.min(1, popAge / 0.6));
      const pop = pp <= 0 ? 0 : 1 + 2.70158 * Math.pow(pp - 1, 3) + 1.70158 * Math.pow(pp - 1, 2);
      ctx.save();
      ctx.translate(cx, cy); ctx.scale(breathe * pop, breathe * pop); ctx.translate(-cx, -cy);
      ctx.fillStyle = '#3a2410';
      ctx.beginPath(); ctx.moveTo(cx - 6, cy + 10); ctx.lineTo(cx + 6, cy + 10); ctx.lineTo(cx, cy + 20); ctx.closePath(); ctx.fill();
      if (showName) this.pill(cx, cy, `${zv.icon} ${zv.name}`, '800 12px sans-serif', '#3a2410', '#fff7e8');
      else this.pill(cx, cy, zv.icon, '13px sans-serif', '#3a2410', '#fff7e8');
      ctx.restore();
      // item 45: gold pulse ring on today's visit-quest zone pin while the quest is undone
      if (quest && !quest.done && quest.zone === k) {
        const ph = (performance.now() % 1600) / 1600;
        ctx.strokeStyle = `rgba(217,119,6,${(0.75 * (1 - ph)).toFixed(3)})`; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, 24 + ph * 26, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#fff7e8'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('📜', cx, cy - 26);
      }
    }
    // === street-find spawns (kept, restyled for dark) ===
    for (const sp of spawns.values()) {
      const m = this.ll2m(sp.lat, sp.lng);
      if (!vis(m.x, m.y, 200)) continue;
      const s = S(m.x, m.y);
      const bob = Math.sin(t * 3 + sp.id * 1.7) * 5;
      const d = me ? haversineM(me.lat, me.lng, sp.lat, sp.lng) : 9999;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(s.x, s.y + 15, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
      if (d <= 300) {
        ctx.strokeStyle = 'rgba(180,83,9,0.95)'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(s.x, s.y + bob, 21, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(s.x, s.y + bob, 16, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(sp.icon, s.x, s.y + bob + 1);
      ctx.textBaseline = 'alphabetic';
    }
    // === collect sparkles ===
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      const age = (performance.now() - e.t0) / 650;
      if (age >= 1) { effects.splice(i, 1); continue; }
      const m = this.ll2m(e.lat, e.lng), s = S(m.x, m.y);
      ctx.strokeStyle = `rgba(255,200,60,${1 - age})`; ctx.lineWidth = 3;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + age;
        const r1 = 8 + age * 26, r2 = r1 + 8;
        ctx.beginPath();
        ctx.moveTo(s.x + Math.cos(a) * r1, s.y + Math.sin(a) * r1);
        ctx.lineTo(s.x + Math.cos(a) * r2, s.y + Math.sin(a) * r2);
        ctx.stroke();
      }
    }
    // route to destination
    if (me && clickTarget) {
      const a = this.ll2m(me.lat, me.lng), b = this.ll2m(clickTarget.lat, clickTarget.lng);
      const sa = S(a.x, a.y), sb = S(b.x, b.y);
      ctx.strokeStyle = 'rgba(180,83,9,0.9)'; ctx.lineWidth = 3.5;
      ctx.setLineDash([8, 8]); ctx.lineDashOffset = -t * 30;
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
      ctx.setLineDash([]);
      const pulse = 1 + Math.sin(t * 5) * 0.15;
      ctx.font = `${Math.round(20 * pulse)}px sans-serif`; ctx.textAlign = 'center';
      // item 89: destination flag gently bobs while you walk (sin, canvas-drawn)
      const _flagBob = Math.sin(t * 2.5) * 3; window.__blFlagBob = _flagBob;
      ctx.fillText('🚩', sb.x, sb.y - 8 + _flagBob);
      // item 32: live distance-to-go label under the flag
      const _dM = haversineM(me.lat, me.lng, clickTarget.lat, clickTarget.lng);
      this.pill(sb.x, sb.y + 24, `🚶 ${_dM >= 1000 ? (_dM / 1000).toFixed(1) + 'km' : Math.round(_dM) + 'm'} to go`, '700 11px sans-serif', '#3a2410', '#fff7e8');
    }
    // === item 212: tap ripple — expanding gold ring at the tap point, fades over ~0.8s ===
    { window.__blTapRipple = 0;
      if (tapRipple) {
        const age = (performance.now() - tapRipple.t0) / 800;
        if (age >= 1) tapRipple = null;
        else {
          const rm = this.ll2m(tapRipple.lat, tapRipple.lng);
          const rs = S(rm.x, rm.y);
          ctx.strokeStyle = `rgba(180,83,9,${(0.8 * (1 - age)).toFixed(3)})`; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(rs.x, rs.y, 8 + age * 42, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = `rgba(255,247,232,${(0.6 * (1 - age)).toFixed(3)})`; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(rs.x, rs.y, 4 + age * 28, 0, Math.PI * 2); ctx.stroke();
          window.__blTapRipple = 1;
        }
      } }
    // === walk dust puffs (item 5): spawn behind the player while moving ===
    if (me && playerMoving) {
      if (Math.random() < 0.35) {
        const mm = this.ll2m(me.lat, me.lng);
        this.dust.push({ x: mm.x, y: mm.y, t0: performance.now() });
      }
    }
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const d = this.dust[i];
      const age = (performance.now() - d.t0) / 900;
      if (age >= 1) { this.dust.splice(i, 1); continue; }
      const s = S(d.x, d.y);
      ctx.fillStyle = `rgba(222,184,135,${((1 - age) * 0.5).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(s.x, s.y + age * 4, 3 + age * 6, 0, Math.PI * 2); ctx.fill();
    }
    // === item 37: walking trail — fading dots behind the player while moving ===
    if (!this.trail) this.trail = [];
    if (me && playerMoving) {
      const mm = this.ll2m(me.lat, me.lng);
      const last = this.trail[this.trail.length - 1];
      if (!last || Math.hypot(mm.x - last.x, mm.y - last.y) > 60) {
        this.trail.push({ x: mm.x, y: mm.y, t0: performance.now() });
        if (this.trail.length > 48) this.trail.shift();
      }
    }
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const tp = this.trail[i];
      const age = (performance.now() - tp.t0) / 7000;
      if (age >= 1) { this.trail.splice(i, 1); continue; }
      if (!vis(tp.x, tp.y, 100)) continue;
      const s = S(tp.x, tp.y);
      ctx.fillStyle = `rgba(255,247,232,${((1 - age) * 0.55).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(58,36,16,${((1 - age) * 0.4).toFixed(3)})`; ctx.lineWidth = 1; ctx.stroke();
    }
    // === players: original dots ===
    const dot = (lat, lng, color, label, isMe, gov, vehicle) => {
      const m = this.ll2m(lat, lng), p = S(m.x, m.y);
      if (isMe && playerMoving) p.y += Math.sin(t * 14) * 2.5; // item 5: walk bob
      if (isMe) {
        ctx.strokeStyle = 'rgba(239,68,68,0.35)'; ctx.lineWidth = 2;
        ctx.setLineDash([10, 10]);
        ctx.beginPath(); ctx.arc(p.x, p.y, 300 * z, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        const pr = 14 + ((t * 22) % 26);
        ctx.strokeStyle = `rgba(239,68,68,${Math.max(0, 0.5 - pr / 60)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, pr, 0, Math.PI * 2); ctx.stroke();
      }
      // item 69: soft shadow ellipse under your marker — grounds it on the map, bobs with you
      if (isMe) {
        ctx.fillStyle = 'rgba(58,36,16,0.28)';
        ctx.beginPath(); ctx.ellipse(p.x, p.y + 15, 14, 5, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(p.x, p.y, isMe ? 12 : 10, 0, Math.PI * 2);
      ctx.fillStyle = isMe ? '#ef4444' : color;
      ctx.fill();
      ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = '#fff7e8'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(p.x, p.y, isMe ? 8.5 : 6.5, 0, Math.PI * 2); ctx.stroke();
      this.pill(p.x, isMe ? p.y + 32 : p.y - 26, label, '700 11px sans-serif', '#3a2410', '#fff7e8');
      if (gov) { ctx.font = '15px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('👑', p.x, p.y - 44); }
      if (vehicle === 'keke' || vehicle === 'car') { ctx.font = '15px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(vehicle === 'keke' ? '🛺' : '🚗', p.x + 18, p.y - 20); } // item 14: owned-vehicle badge on the marker
    };
    for (const p of players.values()) dot(p.lat, p.lng, colorFor(p.id), p.name, false, p.gov, p.vehicle);
    if (me) dot(me.lat, me.lng, colorFor(me.id), me.name, true, me.gov, me.vehicle);
    // item 70: gold walk-direction chevron ahead of your marker while walking to a destination
    window.__blDirArrow = false;
    if (me && clickTarget && playerMoving) {
      const a = this.ll2m(me.lat, me.lng), b = this.ll2m(clickTarget.lat, clickTarget.lng);
      const sa = S(a.x, a.y), sb = S(b.x, b.y);
      const dx = sb.x - sa.x, dy = sb.y - sa.y, len = Math.hypot(dx, dy);
      if (len > 1) {
        const ux = dx / len, uy = dy / len, cxp = sa.x + ux * 26, cyp = sa.y + uy * 26;
        const ang = Math.atan2(uy, ux), pulse = 1 + Math.sin(t * 6) * 0.12;
        ctx.save(); ctx.translate(cxp, cyp); ctx.rotate(ang); ctx.scale(pulse, pulse);
        ctx.fillStyle = '#f59e0b'; ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-4, -7); ctx.lineTo(0, 0); ctx.lineTo(-4, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore(); window.__blDirArrow = true;
      }
    }
    // item 13: draw the ambient residents wandering their home zones
    // Calm map (Max verdict 2026-11-01): the wandering residents + their greeting
    // pills were a big part of the "too rowdy" pile-up downtown — hidden when calm.
    for (const npc of (rmCalm ? [] : (this.npcs || []))) {
      const hz = this.ZM[npc.home]; if (!hz) continue;
      const a = t * npc.sp + npc.ph;
      const wx = hz.x + Math.cos(a) * npc.r, wy = hz.y + Math.sin(a) * npc.r * 0.7;
      if (!vis(wx, wy, 200)) continue;
      const s = S(wx, wy);
      ctx.beginPath(); ctx.arc(s.x, s.y, 13, 0, Math.PI * 2);
      ctx.fillStyle = '#fff7e8'; ctx.fill(); ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = '17px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(npc.emoji, s.x, s.y + 1); ctx.textBaseline = 'alphabetic';
      this.pill(s.x, s.y + 26, npc.name, '700 10px sans-serif', '#3a2410', '#fff7e8');
      const cyc = ((t + npc.ph) % 9 + 9) % 9;
      if (cyc < 3.5) this.pill(s.x, s.y - 30, npc.greet[Math.floor((t + npc.ph) / 9) % npc.greet.length], '700 11px sans-serif', '#3a2410', '#fff7e8');
    }
    // item 31: arrival ring — expands + fades over ~0.9s, spring feel, no teleport
    if (arrivalRing) {
      const age = (performance.now() - arrivalRing.t0) / 900;
      if (age >= 1) arrivalRing = null;
      else {
        const rm = this.ll2m(arrivalRing.lat, arrivalRing.lng), rs = S(rm.x, rm.y);
        ctx.strokeStyle = `rgba(245,158,11,${(0.85 * (1 - age)).toFixed(3)})`; ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.arc(rs.x, rs.y, 18 + age * 72, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = `rgba(58,36,16,${(0.5 * (1 - age)).toFixed(3)})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(rs.x, rs.y, 12 + age * 52, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (this.base) { ctx.font = '600 9px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(58,36,16,0.55)'; ctx.fillText('Real Benin City streets · © OpenStreetMap contributors', 8, h - 8); }
    // subtle vignette
    const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.75);
    v.addColorStop(0, 'rgba(120,72,20,0)'); v.addColorStop(1, 'rgba(120,72,20,0.16)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
    // === drifting clouds (item 2): slow eastward drift, soft white puffs ===
    // item 82: reduce-motion hides clouds entirely (calm map), not just slowing them
    window.__blClouds = 0;
    if (!rmCalm && (this.quality ?? 2) >= 2) for (const c of (this.clouds || [])) {
      const WX = 8200;
      const wx = (((c.x + t * c.v + WX) % (2 * WX)) + 2 * WX) % (2 * WX) - WX;
      if (!vis(wx, c.y, 900)) continue;
      const s = S(wx, c.y);
      const r = 260 * c.s * z;
      if (r < 4) continue;
      ctx.fillStyle = `rgba(255,255,255,${c.a})`;
      const puff = (dx, dy, pr) => { ctx.beginPath(); ctx.arc(s.x + dx * r, s.y + dy * r, pr * r, 0, Math.PI * 2); ctx.fill(); };
      puff(-0.85, 0.15, 0.55); puff(0, -0.28, 0.72); puff(0.85, 0.15, 0.58);
      puff(-0.4, 0.28, 0.5); puff(0.45, 0.28, 0.52); puff(0, 0.12, 0.8);
      window.__blClouds++;
    }
    // === item 130: soft shadows drifting under the clouds (same drift, ground offset) ===
    window.__blCloudShadows = 0;
    if (!rmCalm && (this.quality ?? 2) >= 2) for (const c of (this.clouds || [])) {
      const WX = 8200;
      const wx = (((c.x + t * c.v + WX) % (2 * WX)) + 2 * WX) % (2 * WX) - WX;
      if (!vis(wx, c.y, 900)) continue;
      const s = S(wx, c.y);
      const r = 260 * c.s * z;
      if (r < 4) continue;
      ctx.fillStyle = 'rgba(58,36,16,0.10)';
      ctx.beginPath(); ctx.ellipse(s.x + r * 0.6, s.y + r * 1.4, r * 0.9, r * 0.32, 0, 0, Math.PI * 2); ctx.fill();
      window.__blCloudShadows++;
    }
    // === birds crossing the map (item 3): flapping V-flocks on looping paths ===
    // item 82: reduce-motion hides birds too (calm map)
    if (!rmCalm && (this.quality ?? 2) >= 2) for (const fl of (this.birds || [])) {
      const a = t * fl.sp + fl.ph;
      const bx = fl.cx + Math.cos(a) * fl.rx, by = fl.cy + Math.sin(a) * fl.ry;
      const dir = Math.atan2(Math.cos(a) * fl.ry, -Math.sin(a) * fl.rx);
      for (let i = 0; i < fl.n; i++) {
        const off = i - (fl.n - 1) / 2;
        const wx = bx + Math.cos(dir + Math.PI) * i * 90 - Math.sin(dir) * Math.abs(off) * 70;
        const wy = by + Math.sin(dir + Math.PI) * i * 90 + Math.cos(dir) * Math.abs(off) * 70;
        if (!vis(wx, wy, 300)) continue;
        const s = S(wx, wy);
        const flap = Math.sin(t * 10 + i * 0.9) * 5;
        ctx.strokeStyle = 'rgba(58,36,16,0.85)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(s.x - 9, s.y - flap); ctx.lineTo(s.x, s.y); ctx.lineTo(s.x + 9, s.y - flap);
        ctx.stroke();
      }
    }
    // === item 50: twinkling night stars (canvas, per-star phase, subtle) ===
    { const _h50 = gameHour(); const _n50 = (typeof window !== 'undefined' && window.__forceNight === true) || _h50 >= 20 || _h50 < 5;
      window.__blStars = _n50 ? 36 : 0;
      if (_n50) for (let i = 0; i < 36; i++) {
        const sx = ((i * 197 + 53) % Math.max(w, 1)), sy = ((i * 131 + 89) % Math.max(h, 1));
        const tw = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2 + i * 1.7));
        ctx.fillStyle = `rgba(255,247,232,${tw.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(sx, sy, 1.6 + (i % 3) * 0.5, 0, Math.PI * 2); ctx.fill();
      } }
    // === time-of-day tint (item 1): tied to the game clock ===
    // A game day is 5 real minutes (server DAY_MS); progress maps to a 24h cycle.
    const tint = this.timeTint();
    if (tint) { ctx.fillStyle = tint; ctx.fillRect(0, 0, w, h); }
    // === item 140: golden-hour glow — warm orange wash at dusk (hour 17–19) ===
    { const _dh = gameHour(); const _dusk = _dh >= 17 && _dh < 19;
      window.__blDusk = _dusk ? 1 : 0;
      if (_dusk) { const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, 'rgba(255,140,60,0.10)'); g.addColorStop(1, 'rgba(255,100,40,0.20)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); } }
    // === item 35: night lamp glows + item 36: sun/moon disc ===
    const _hour = gameHour(); window.__blGameHour = _hour;
    const _night = (typeof window !== 'undefined' && window.__forceNight === true) || _hour >= 20 || _hour < 5;
    if (_night) {
      const glowAt = (sx, sy, idx) => {
        const flick = 0.9 + 0.1 * Math.sin(t * 7 + idx * 1.3);
        const g = ctx.createRadialGradient(sx, sy, 2, sx, sy, 30);
        g.addColorStop(0, `rgba(255,190,80,${(0.38 * flick).toFixed(3)})`);
        g.addColorStop(1, 'rgba(255,190,80,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, 30, 0, Math.PI * 2); ctx.fill();
      };
      let _gi = 0;
      for (const k of Object.keys(this.ZM || {})) {
        const zm = this.ZM[k]; if (!vis(zm.x, zm.y, 100)) continue;
        const s = S(zm.x, zm.y); glowAt(s.x, s.y, _gi++);
      }
      if (me) { const mm = this.ll2m(me.lat, me.lng), s = S(mm.x, mm.y); glowAt(s.x, s.y, 99); }
    }
    // sun by day, moon by night — bottom-right corner, storybook furniture style
    {
      const dx = w - 44, dy = h - 46, dayTime = _hour >= 6 && _hour < 18;
      ctx.fillStyle = 'rgba(58,36,16,0.9)';
      ctx.beginPath(); ctx.arc(dx + 3, dy + 3, 18, 0, Math.PI * 2); ctx.fill();
      if (dayTime) {
        ctx.strokeStyle = 'rgba(245,158,11,0.9)'; ctx.lineWidth = 2.5;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2 + t * 0.15;
          ctx.beginPath();
          ctx.moveTo(dx + Math.cos(a) * 22, dy + Math.sin(a) * 22);
          ctx.lineTo(dx + Math.cos(a) * 28, dy + Math.sin(a) * 28);
          ctx.stroke();
        }
        ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(dx, dy, 17, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = '#fef3c7'; ctx.beginPath(); ctx.arc(dx, dy, 17, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f6dcab'; ctx.beginPath(); ctx.arc(dx + 8, dy - 5, 14, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(dx, dy, 17, 0, Math.PI * 2); ctx.stroke();
    }
    // === item 55: market crowd dots — tiny animated shoppers milling at market pins (ambience only) ===
    // item 90: hidden entirely under reduce-motion (calm map), like clouds/birds (item 82)
    { const _mk = ['oba', 'ekiosa', 'newbenin'], _pal = ['#b91c1c', '#0284c7', '#16a34a', '#7c3aed', '#ea580c', '#0f766e'];
      window.__blCrowd = 0;
      if (!rmCalm) for (const k of _mk) {
        const zm = (this.ZM || {})[k]; if (!zm || !vis(zm.x, zm.y, 100)) continue;
        const s = S(zm.x, zm.y);
        for (let i = 0; i < 6; i++) {
          const ox = Math.sin(t * 0.7 + i * 1.9 + k.length) * 14, oy = Math.cos(t * 0.5 + i * 2.3) * 10;
          ctx.fillStyle = _pal[(i + k.length) % _pal.length];
          ctx.beginPath(); ctx.arc(s.x + ox, s.y + 14 + oy, 2.2, 0, Math.PI * 2); ctx.fill();
          window.__blCrowd++;
        }
      } }
    // === item 63: night market lanterns — warm flickering dots over market pins at night ===
    // item 90: hidden entirely under reduce-motion (calm map); fireflies (item 79) already gated
    { window.__blLanterns = 0;
      if (_night && !rmCalm) for (const k of ['oba', 'ekiosa', 'newbenin']) {
        const zm = (this.ZM || {})[k]; if (!zm || !vis(zm.x, zm.y, 100)) continue;
        const s = S(zm.x, zm.y);
        for (let i = 0; i < 6; i++) {
          const a = 0.55 + 0.35 * Math.sin(t * 3 + i * 1.7 + k.length);
          ctx.fillStyle = `rgba(255,190,80,${a.toFixed(3)})`;
          ctx.beginPath(); ctx.arc(s.x - 18 + i * 7, s.y - 26 - (i % 2) * 4, 2.6, 0, Math.PI * 2); ctx.fill();
          window.__blLanterns++;
        }
      } }
    // === item 79: night fireflies — tiny drifting golden dots at night (pairs with stars) ===
    { window.__blFireflies = 0;
      if (_night && !rmCalm) for (let i = 0; i < 14; i++) {
        const fx = ((i * 347 + 71) % Math.max(w, 1)) + Math.sin(t * 0.6 + i * 2.1) * 22;
        const fy = ((i * 211 + 137) % Math.max(h, 1)) + Math.cos(t * 0.45 + i * 1.3) * 16;
        const fa = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.4 + i * 1.9));
        ctx.fillStyle = `rgba(255,215,90,${fa.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(fx, fy, 2.2, 0, Math.PI * 2); ctx.fill();
        window.__blFireflies++;
      } }
    // === item 100: daytime butterflies — fluttering over the map by day ===
    // Hidden under reduce-motion (calm map), like clouds/birds (item 82).
    { window.__blButterflies = 0;
      if (!_night && !rmCalm) for (let i = 0; i < 10; i++) {
        const bx = ((i * 431 + 97) % Math.max(w, 1)) + Math.sin(t * 0.8 + i * 2.4) * 26;
        const by = ((i * 293 + 61) % Math.max(h, 1)) + Math.cos(t * 0.6 + i * 1.8) * 18;
        const flap = Math.sin(t * 12 + i * 1.9);
        const cols = ['#c084fc', '#fb923c', '#2dd4bf', '#f472b6'];
        ctx.fillStyle = cols[i % cols.length];
        ctx.beginPath(); ctx.ellipse(bx - 3 - flap, by, 3.2, 2.2, -0.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(bx + 3 + flap, by, 3.2, 2.2, 0.5, 0, Math.PI * 2); ctx.fill();
        window.__blButterflies++;
      } }
    // === item 150: daytime kites — colourful kites drifting over the map by day ===
    // Hidden under reduce-motion (calm map), like clouds/birds (item 82).
    { window.__blKites = 0;
      if (!_night && !rmCalm) for (let i = 0; i < 4; i++) {
        const kx = ((i * 557 + 149) % Math.max(w, 1)) + Math.sin(t * 0.5 + i * 2.2) * 30;
        const ky = ((i * 331 + 83) % Math.max(h, 1)) + Math.cos(t * 0.4 + i * 1.6) * 20;
        const sway = Math.sin(t * 1.8 + i * 2.0) * 4;
        const cols = ['#ef4444', '#22c55e', '#eab308', '#3b82f6'];
        ctx.fillStyle = cols[i % cols.length];
        ctx.beginPath(); ctx.moveTo(kx, ky - 8); ctx.lineTo(kx + 7 + sway, ky); ctx.lineTo(kx, ky + 8); ctx.lineTo(kx - 7 + sway, ky); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(58,36,16,0.6)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(kx, ky + 8); ctx.lineTo(kx + sway, ky + 26); ctx.stroke();
        window.__blKites++;
      } }
    // === item 229: daytime balloons — small colourful balloons drifting over the map by day ===
    // Hidden under reduce-motion (calm map), like kites/butterflies.
    { window.__blBalloons = 0;
      if (!_night && !rmCalm) for (let i = 0; i < 5; i++) {
        const bx = ((i * 613 + 173) % Math.max(w, 1)) + Math.sin(t * 0.45 + i * 2.1) * 28;
        const by = ((i * 347 + 71) % Math.max(h, 1)) + Math.cos(t * 0.35 + i * 1.5) * 16;
        const cols = ['#ef4444', '#eab308', '#22c55e', '#3b82f6', '#c084fc'];
        ctx.fillStyle = cols[i % cols.length];
        ctx.beginPath(); ctx.ellipse(bx, by, 7, 9, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(58,36,16,0.6)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(bx, by + 9); ctx.lineTo(bx + Math.sin(t * 1.2 + i) * 3, by + 26); ctx.stroke();
        window.__blBalloons++;
      } }
    // === item 239: daytime plane flyover — small plane crossing the map sky by day ===
    // Hidden under reduce-motion (calm map), like kites/balloons.
    { window.__blPlane = 0;
      if (!_night && !rmCalm) {
        const px = (((t * 22) % (Math.max(w, 1) + 120)) + Math.max(w, 1) + 120) % (Math.max(w, 1) + 120) - 60;
        const py = Math.max(h, 1) * 0.22 + Math.sin(t * 0.5) * 8;
        ctx.fillStyle = '#fff7e8'; ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(px, py, 14, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px - 2, py - 3); ctx.lineTo(px + 2, py - 3); ctx.lineTo(px, py - 10); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px - 10, py); ctx.lineTo(px + 10, py); ctx.stroke();
        window.__blPlane = 1;
      } }
    // === item 160: midday sunbeams — soft golden rays sweeping the map at midday ===
    // Game hour 11–13 only; hidden under reduce-motion (calm map), like clouds/birds.
    { window.__blSunbeams = 0;
      if (_hour >= 11 && _hour < 14 && !rmCalm) for (let i = 0; i < 5; i++) {
        const sx = ((i * 479 + 113) % Math.max(w, 1)) + Math.sin(t * 0.3 + i * 1.4) * 24;
        ctx.fillStyle = 'rgba(255,215,90,0.10)';
        ctx.beginPath(); ctx.moveTo(sx - 14, 0); ctx.lineTo(sx + 14, 0); ctx.lineTo(sx + 40, h); ctx.lineTo(sx - 2, h); ctx.closePath(); ctx.fill();
        window.__blSunbeams++;
      } }
    // === item 109: dawn mist wisps — soft cream blobs drifting in the early morning ===
    // Game hour 5–8 only; hidden under reduce-motion (calm map), like clouds/birds.
    { window.__blMist = 0;
      if (_hour >= 5 && _hour < 9 && !rmCalm) for (let i = 0; i < 6; i++) {
        const mx = ((i * 389 + 53) % Math.max(w, 1)) + Math.sin(t * 0.25 + i * 1.7) * 30;
        const my = ((i * 211 + 89) % Math.max(h, 1)) + Math.cos(t * 0.2 + i * 1.2) * 12;
        ctx.fillStyle = 'rgba(255,247,232,0.16)';
        ctx.beginPath(); ctx.ellipse(mx, my, 52 + (i % 3) * 14, 13, 0, 0, Math.PI * 2); ctx.fill();
        window.__blMist++;
      } }
    // === item 113: market awnings — striped canopies over the three market pins by day ===
    // Hidden under reduce-motion (calm map), like clouds/birds (item 82).
    { window.__blAwnings = 0;
      if (!_night && !rmCalm) for (const k of ['oba', 'ekiosa', 'newbenin']) {
        const zm = (this.ZM || {})[k]; if (!zm || !vis(zm.x, zm.y, 100)) continue;
        const s = S(zm.x, zm.y);
        const cols = ['#b91c1c', '#fff7e8', '#0284c7', '#fff7e8', '#ea580c'];
        for (let i = 0; i < 5; i++) { ctx.fillStyle = cols[i]; ctx.fillRect(s.x - 20 + i * 8, s.y - 38, 8, 9); }
        ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 1.2; ctx.strokeRect(s.x - 20, s.y - 38, 40, 9);
        window.__blAwnings++;
      } }
    // === item 165: market bunting flags — swaying triangle strings over the three markets by day ===
    // Hidden under reduce-motion (calm map), like market awnings (item 113).
    { window.__blBunting = 0;
      if (!_night && !rmCalm) for (const k of ['oba', 'ekiosa', 'newbenin']) {
        const zm = (this.ZM || {})[k]; if (!zm || !vis(zm.x, zm.y, 100)) continue;
        const s = S(zm.x, zm.y); const sway = Math.sin(t * 1.6 + zm.x * 0.01) * 3;
        const cols = ['#b91c1c', '#eab308', '#16a34a', '#0284c7', '#ea580c'];
        ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(s.x - 26, s.y - 52); ctx.quadraticCurveTo(s.x, s.y - 42 + sway, s.x + 26, s.y - 52); ctx.stroke();
        for (let i = 0; i < 5; i++) { const fx = s.x - 22 + i * 11; const fy = s.y - 50 + Math.sin((fx - s.x) / 26 * Math.PI) * 4 + sway * 0.4; ctx.fillStyle = cols[i]; ctx.beginPath(); ctx.moveTo(fx - 4, fy); ctx.lineTo(fx + 4, fy); ctx.lineTo(fx, fy + 8); ctx.closePath(); ctx.fill(); }
        window.__blBunting++;
      } }
    // === item 179: stadium bouncing ball — small ball bouncing over the stadium pin by day ===
    // Hidden under reduce-motion (calm map), like kites/bunting.
    { window.__blStadiumBall = 0;
      if (!_night && !rmCalm) {
        const zm = (this.ZM || {})['stadium']; if (zm && vis(zm.x, zm.y, 100)) {
          const s = S(zm.x, zm.y); const bounce = Math.abs(Math.sin(t * 2.2)) * 12;
          ctx.fillStyle = 'rgba(58,36,16,0.25)'; ctx.beginPath(); ctx.ellipse(s.x, s.y - 30, 5, 2, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#fff7e8'; ctx.beginPath(); ctx.arc(s.x, s.y - 36 - bounce, 5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 1.2; ctx.stroke();
          window.__blStadiumBall = 1;
        }
      } }
    // === item 243: zoo giraffe — giraffe head-and-neck bobbing over the Ogba Zoo pin by day ===
    // Hidden under reduce-motion (calm map), like the stadium ball.
    { window.__blGiraffe = 0;
      if (!_night && !rmCalm) {
        const zm = (this.ZM || {})['zoo']; if (zm && vis(zm.x, zm.y, 100)) {
          const s = S(zm.x, zm.y); const bob = Math.sin(t * 1.4) * 3;
          ctx.fillStyle = '#f2c14e'; ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.rect(s.x - 3, s.y - 52 - bob, 6, 20); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.ellipse(s.x + 2, s.y - 56 - bob, 7, 4.5, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#3a2410';
          ctx.beginPath(); ctx.arc(s.x - 1, s.y - 50 - bob, 1.2, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(s.x + 1, s.y - 44 - bob, 1.2, 0, Math.PI * 2); ctx.fill();
          window.__blGiraffe = 1;
        }
      } }
    // === item 219: daytime road traffic — small keke/car dots moving along major roads by day ===
    // Hidden under reduce-motion (calm map), like clouds/birds.
    { window.__blTraffic = 0;
      if (!_night && !rmCalm && this.roads)
        for (let ri = 0; ri < this.roads.length; ri++) {
          const rd = this.roads[ri]; if (rd.w < 34 || !rd.pts.length) continue; // majors only
          const idx = Math.floor(t * 2 + ri * 7) % rd.pts.length;
          const [lx, ly] = rd.pts[idx]; if (!vis(lx, ly, 40)) continue;
          const s = S(lx, ly);
          ctx.fillStyle = ri % 2 ? '#facc15' : '#fff7e8'; ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(s.x, s.y, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          window.__blTraffic++;
        } }
    // === item 189: Owambe fireworks — colourful bursts over the palace pin on Owambe days ===
    // Only when today's city event is Owambe Saturday (id or name match, defensive);
    // hidden under reduce-motion (calm map), like kites/bunting.
    { window.__blFireworks = 0;
      const _owambe = typeof cityEvent !== 'undefined' && cityEvent && (cityEvent.id === 'owambe' || (cityEvent.name || '').indexOf('Owambe') >= 0);
      if (_owambe && !rmCalm) {
        const zm = (this.ZM || {})['palace']; if (zm && vis(zm.x, zm.y, 140)) {
          const s = S(zm.x, zm.y); const cols = ['#ef4444', '#eab308', '#22c55e'];
          for (let i = 0; i < 3; i++) {
            const ph = (t * 0.5 + i * 0.33) % 1; const r = 6 + ph * 16;
            const cx = s.x + (i - 1) * 26, cy = s.y - 70 - (i % 2) * 14;
            ctx.strokeStyle = cols[i]; ctx.globalAlpha = 1 - ph * 0.7; ctx.lineWidth = 1.4;
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
            for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + t * 0.8; ctx.fillStyle = cols[i]; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.8, 0, Math.PI * 2); ctx.fill(); }
            ctx.globalAlpha = 1; window.__blFireworks++;
          }
        }
      } }
    // === item 193: market food-stall steam — soft wisps rising over the three market pins by day ===
    // Hidden under reduce-motion (calm map), like market awnings/bunting.
    { window.__blSteam = 0;
      if (!_night && !rmCalm) for (const k of ['oba', 'ekiosa', 'newbenin']) {
        const zm = (this.ZM || {})[k]; if (!zm || !vis(zm.x, zm.y, 100)) continue;
        const s = S(zm.x, zm.y);
        for (let i = 0; i < 2; i++) {
          const ph = (t * 0.4 + i * 0.5 + zm.x * 0.001) % 1;
          const sx = s.x - 10 + i * 20 + Math.sin(ph * Math.PI * 2) * 4, sy = s.y - 44 - ph * 16;
          ctx.fillStyle = 'rgba(255,247,232,' + (0.35 * (1 - ph)).toFixed(2) + ')';
          ctx.beginPath(); ctx.ellipse(sx, sy, 4 + ph * 3, 6 + ph * 4, 0, 0, Math.PI * 2); ctx.fill();
          window.__blSteam++;
        }
      } }
    // === item 199: Rainy Day puddle shimmer — soft shimmer ellipses near the market pins on Rainy Days ===
    // Only when today's city event is Rainy Day (id or name match, defensive);
    // hidden under reduce-motion (calm map), like fireworks/steam.
    { window.__blPuddles = 0;
      const _rain = typeof cityEvent !== 'undefined' && cityEvent && (cityEvent.id === 'rain' || (cityEvent.name || '').indexOf('Rainy') >= 0);
      if (_rain && !rmCalm) for (const k of ['oba', 'ekiosa', 'newbenin']) {
        const zm = (this.ZM || {})[k]; if (!zm || !vis(zm.x, zm.y, 100)) continue;
        const s = S(zm.x, zm.y);
        for (let i = 0; i < 2; i++) {
          const ph = (t * 0.6 + i * 0.5 + zm.x * 0.001) % 1;
          const px = s.x - 18 + i * 36, py = s.y + 22 + (i % 2) * 10;
          ctx.fillStyle = 'rgba(148,163,184,' + (0.30 + 0.15 * Math.sin(ph * Math.PI * 2)).toFixed(2) + ')';
          ctx.beginPath(); ctx.ellipse(px, py, 14, 5, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(255,247,232,0.35)';
          ctx.beginPath(); ctx.ellipse(px - 3, py - 1, 5, 1.6, 0, 0, Math.PI * 2); ctx.fill();
          window.__blPuddles++;
        }
      } }
    // === item 223: NEPA Outage candle glows — warm flickering dots over zone pins on NEPA days ===
    // Only when today's city event is NEPA Outage (id or name match, defensive);
    // hidden under reduce-motion (calm map), like fireworks/puddles.
    { window.__blCandles = 0;
      const _nepa = typeof cityEvent !== 'undefined' && cityEvent && (cityEvent.id === 'nepa' || (cityEvent.name || '').indexOf('NEPA') >= 0);
      if (_nepa && !rmCalm) for (const k of Object.keys(this.ZM || {})) {
        const zm = (this.ZM || {})[k]; if (!zm || !vis(zm.x, zm.y, 100)) continue;
        const s = S(zm.x, zm.y);
        const flick = 0.6 + 0.4 * Math.sin(t * 4 + zm.x * 0.01);
        ctx.fillStyle = `rgba(255,190,80,${(0.85 * flick).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(s.x + 14, s.y - 30, 2.6, 0, Math.PI * 2); ctx.fill();
        window.__blCandles++;
      } }
    // === item 232: Market Day confetti — colourful dots falling over the market pins on Market Days ===
    // Only when today's city event is Market Day (id or name match, defensive);
    // hidden under reduce-motion (calm map), like fireworks/puddles/candles.
    { window.__blConfetti = 0;
      const _market = typeof cityEvent !== 'undefined' && cityEvent && (cityEvent.id === 'market' || (cityEvent.name || '').indexOf('Market Day') >= 0);
      if (_market && !rmCalm) for (const k of ['oba', 'ekiosa', 'newbenin']) {
        const zm = (this.ZM || {})[k]; if (!zm || !vis(zm.x, zm.y, 100)) continue;
        const s = S(zm.x, zm.y); const cols = ['#ef4444', '#eab308', '#22c55e', '#3b82f6'];
        for (let i = 0; i < 4; i++) {
          const ph = (t * 0.7 + i * 0.25 + zm.x * 0.001) % 1;
          ctx.fillStyle = cols[i];
          ctx.fillRect(s.x - 22 + i * 12 + Math.sin(ph * Math.PI * 2) * 3, s.y - 60 + ph * 44, 4, 6);
          window.__blConfetti++;
        }
      } }
    // === drizzle overlay (item 9): part of a game day, visual only ===
    const dz = this.drizzleActive();
    if (dz && !this._drizzleToasted) {
      this._drizzleToasted = true;
      toast('🌧️ Light drizzle over Benin City — just atmosphere, no effect on your hustle.');
    }
    if (!dz) this._drizzleToasted = false;
    if (dz) {
      ctx.strokeStyle = 'rgba(174,194,224,0.35)'; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < 70; i++) {
        const dx = (i * 97) % (w + 40);
        const dy = ((i * 137 + t * 380) % (h + 40)) - 20;
        ctx.moveTo(dx - dy * 0.15, dy); ctx.lineTo(dx - dy * 0.15 - 3, dy + 12);
      }
      ctx.stroke();
    }
    // === storybook map furniture (item 10): compass rose + cartouche ===
    // cartouche, top-left
    ctx.fillStyle = 'rgba(58,36,16,0.9)';
    this.rr(14 + 3, 14 + 3, 138, 44, 12); ctx.fill();
    ctx.fillStyle = '#fff7e8';
    this.rr(14, 14, 138, 44, 12); ctx.fill();
    ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#3a2410'; ctx.textAlign = 'center';
    ctx.font = '800 15px sans-serif'; ctx.fillText('Benin City', 83, 32);
    ctx.font = '600 10px sans-serif'; ctx.fillStyle = '#8a6d4a'; ctx.fillText('Edo State • Nigeria', 83, 48);
    ctx.textAlign = 'left';
    // compass rose, top-right
    const ccx = w - 44, ccy = 40;
    ctx.fillStyle = 'rgba(58,36,16,0.9)';
    ctx.beginPath(); ctx.arc(ccx + 3, ccy + 3, 22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff7e8';
    ctx.beginPath(); ctx.arc(ccx, ccy, 22, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#3a2410'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#b91c1c';
    ctx.beginPath(); ctx.moveTo(ccx, ccy - 16); ctx.lineTo(ccx - 5, ccy + 4); ctx.lineTo(ccx + 5, ccy + 4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#3a2410';
    ctx.beginPath(); ctx.moveTo(ccx, ccy + 16); ctx.lineTo(ccx - 5, ccy - 4); ctx.lineTo(ccx + 5, ccy - 4); ctx.closePath(); ctx.fill();
    ctx.font = '800 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#3a2410';
    ctx.fillText('N', ccx, ccy - 22); ctx.textAlign = 'left';
  }
  // Drizzle window (item 9): every 3rd game day, 13:00–16:00 game time.
  // Visual + toast only — no economy, speed or stat effect anywhere.
  drizzleActive() {
    if (typeof window !== 'undefined' && window.__forceDrizzle === true) return true;
    const DAY_LEN = 5 * 60 * 1000;
    const p = dayEndsIn > 0 ? Math.max(0, Math.min(1, 1 - dayEndsIn / DAY_LEN)) : 0;
    const hour = p * 24;
    return (day % 3 === 1) && hour >= 13 && hour < 16;
  }
  // Interpolated tint for the current game hour: bright midday = no tint,
  // warm dusk glow in the evening, dim blue night after dark. Kept subtle
  // (max alpha 0.20) so the map stays readable at all hours.
  timeTint() {
    const hour = gameHour(); // item 36: shared helper (was duplicated dayEndsIn math)
    const KF = [
      [0, 18, 28, 72, 0.20], [5, 18, 28, 72, 0.20], [7, 255, 170, 110, 0.10],
      [10, 0, 0, 0, 0], [16, 0, 0, 0, 0], [18.5, 255, 140, 60, 0.15],
      [20, 18, 28, 72, 0.20], [24, 18, 28, 72, 0.20],
    ];
    let a = KF[0], b = KF[KF.length - 1];
    for (let i = 0; i < KF.length - 1; i++) {
      if (hour >= KF[i][0] && hour <= KF[i + 1][0]) { a = KF[i]; b = KF[i + 1]; break; }
    }
    const f = b[0] === a[0] ? 0 : (hour - a[0]) / (b[0] - a[0]);
    const mix = (i) => Math.round(a[i] + (b[i] - a[i]) * f);
    const alpha = a[4] + (b[4] - a[4]) * f;
    if (alpha <= 0.001) return null;
    return `rgba(${mix(1)},${mix(2)},${mix(3)},${alpha.toFixed(3)})`;
  }
  project(lat, lng) {
    const r = this.canvas.getBoundingClientRect();
    const m = this.ll2m(lat, lng);
    const p = this.w2s(m.x, m.y, r.width, r.height);
    const wrap = $('map-wrap').getBoundingClientRect();
    const cr = this.canvas.getBoundingClientRect();
    return { x: p.x + (cr.left - wrap.left), y: p.y + (cr.top - wrap.top) };
  }
  onTap(cb) { this.tapCb = cb; }
  recenter() { this.follow = true; }
}

async function initRenderer() {
  try {
    const r = await fetch('/api/config');
    CFG = await r.json();
  } catch { CFG = { mapsKey: '', spawn: { lat: 6.3345, lng: 5.6040 } }; }
  // Storybook Benin (style B, locked 2026-10-30) is an illustrated canvas
  // world — always use it; the Google renderer would clash with the style.
  renderer = new CanvasRenderer();
  await renderer.init();
  renderer.onTap((lat, lng) => {
    if (!BOUNDS) return;
    clickTarget = {
      lat: clamp(lat, BOUNDS.latMin, BOUNDS.latMax),
      lng: clamp(lng, BOUNDS.lngMin, BOUNDS.lngMax),
    };
    tapRipple = { lat: clickTarget.lat, lng: clickTarget.lng, t0: performance.now() }; // item 212
  });
  $('btn-recenter').onclick = () => renderer.recenter && renderer.recenter();
}

// ============================================================
// MAIN LOOP
// ============================================================
let lastMoveSent = 0;
function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  let last = performance.now();
  requestAnimationFrame(function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (me && renderer) {
      stepPlayer(dt);
      // interpolate remotes
      for (const p of players.values()) {
        if (p.tlat !== undefined) {
          p.lat += (p.tlat - p.lat) * 0.2;
          p.lng += (p.tlng - p.lng) * 0.2;
        }
      }
      renderer.frame();
      const z = zoneAt(me.lat, me.lng);
      if (z !== currentZone) {
        const arrived = !!z && zoneSeen; // item 20: buzz on arrival, not on first load
        currentZone = z; manualClose = false;
        if (z) { zoneSeen = true; openZone(z); } else closeZone();
        if (arrived) { buzz(30); arrivalRing = { t0: performance.now(), lat: me.lat, lng: me.lng }; toast(`📍 Arrived at ${ZONES[z].name}`); } // item 131: one arrival toast, same hook as ring/haptic
      }
      dayEndsIn = Math.max(0, dayEndsIn - dt * 1000);
      drawBubbles();
    }
    requestAnimationFrame(frame);
  });
  setInterval(updateHUD, 1000);
  setInterval(drawBubbles, 300);
}

function stepPlayer(dt) {
  const sp = SPEED * speedMult;
  let dlat = 0, dlng = 0;
  if (keys.up) dlat += 1;
  if (keys.down) dlat -= 1;
  if (keys.right) dlng += 1;
  if (keys.left) dlng -= 1;
  playerMoving = false;
  if (dlat || dlng) {
    clickTarget = null;
    playerMoving = true;
    const n = Math.hypot(dlat, dlng);
    me.lat = clamp(me.lat + (dlat / n) * sp * dt, BOUNDS.latMin, BOUNDS.latMax);
    me.lng = clamp(me.lng + (dlng / n) * sp * dt, BOUNDS.lngMin, BOUNDS.lngMax);
    sendMove();
  } else if (clickTarget) {
    const dM = haversineM(me.lat, me.lng, clickTarget.lat, clickTarget.lng);
    if (dM < 10) { clickTarget = null; }
    else {
      playerMoving = true;
      const stepM = Math.min(dM, sp * 111320 * dt);
      const f = stepM / dM;
      me.lat = clamp(me.lat + (clickTarget.lat - me.lat) * f, BOUNDS.latMin, BOUNDS.latMax);
      me.lng = clamp(me.lng + (clickTarget.lng - me.lng) * f, BOUNDS.lngMin, BOUNDS.lngMax);
      sendMove();
    }
  }
}
function sendMove() {
  const now = performance.now();
  if (now - lastMoveSent < 100) return;
  lastMoveSent = now;
  send({ t: 'move', lat: +me.lat.toFixed(6), lng: +me.lng.toFixed(6) });
}
function zoneAt(lat, lng) {
  for (const [k, z] of Object.entries(ZONES))
    if (haversineM(lat, lng, z.lat, z.lng) <= z.r) return k;
  return null;
}

function drawBubbles() {
  const layer = $('bubble-layer');
  const now = Date.now();
  // prune
  for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i].until < now) bubbles.splice(i, 1);
  layer.innerHTML = '';
  if (!renderer) return;
  for (const b of bubbles) {
    const pt = renderer.project(b.src.lat, b.src.lng);
    if (!pt) continue;
    const el = document.createElement('div');
    el.className = 'map-bubble';
    el.style.left = pt.x + 'px';
    el.style.top = (pt.y - 46) + 'px';
    el.textContent = b.text;
    layer.appendChild(el);
  }
}

// ---------- input ----------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = keyName(e.key);
  if (k) { keys[k] = true; clickTarget = null; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  const k = keyName(e.key);
  if (k) keys[k] = false;
});
function keyName(k) {
  k = k.toLowerCase();
  if (k === 'arrowup' || k === 'w') return 'up';
  if (k === 'arrowdown' || k === 's') return 'down';
  if (k === 'arrowleft' || k === 'a') return 'left';
  if (k === 'arrowright' || k === 'd') return 'right';
  return null;
}
document.querySelectorAll('#dpad button').forEach((b) => {
  const k = b.dataset.k;
  const on = (e) => { e.preventDefault(); keys[k] = true; clickTarget = null; };
  const off = (e) => { e.preventDefault(); keys[k] = false; };
  b.addEventListener('pointerdown', on);
  b.addEventListener('pointerup', off);
  b.addEventListener('pointerleave', off);
  b.addEventListener('pointercancel', off);
});

// ============================================================
// HUD + ZONE PANELS
// ============================================================
function updateHUD() {
  if (!me) return;
  const mm = String(Math.floor(dayEndsIn / 60000)).padStart(1, '0');
  const ss = String(Math.floor((dayEndsIn % 60000) / 1000)).padStart(2, '0');
  const _hh = String(Math.floor(gameHour())).padStart(2, '0');
  $('hud-day').textContent = `📅 Day ${day} • ${mm}:${ss} • 🕐 ${_hh}:00`;
  // item 51: cash pill flashes green on a cash rise (spring CSS, no new state)
  if (typeof window !== 'undefined') {
    if (window.__blLastCash != null && me.cash > window.__blLastCash) {
      const ce = $('hud-cash'); window.__blCashFlash = true;
      if (ce) { ce.classList.remove('cash-flash'); void ce.offsetWidth; ce.classList.add('cash-flash'); setTimeout(() => { ce.classList.remove('cash-flash'); window.__blCashFlash = false; }, 900); }
    }
    window.__blLastCash = me.cash;
  }
  $('hud-cash').textContent = fmt(me.cash);
  const lv = $('hud-level'); if (lv) lv.textContent = `⭐ Lv ${me.level || levelOf(me.xp)}`;
  // item 60: XP progress bar — progress to the next level, display only
  { const _xp = Number(me.xp) || 0, _xb = $('hud-xpbar');
    if (_xb) { _xb.style.width = ((_xp % 150) / 150 * 100).toFixed(1) + '%'; _xb.title = `${_xp % 150} / 150 XP to next level`; } }
  $('bar-energy').style.width = me.energy + '%';
  $('bar-hunger').style.width = me.hunger + '%';
  $('bar-happy').style.width = me.happy + '%';
  // item 103: numeric stat values beside the bars — display only
  for (const [k, id] of [['energy', 'num-energy'], ['hunger', 'num-hunger'], ['happy', 'num-happy']]) {
    const ne = $(id); if (ne) ne.textContent = String(Math.round(me[k]));
  }
  // item 33: pulse + one toast per dip when a stat falls under 25%
  const LOW_TIPS = { energy: ['⚡ Energy is low — sleep or eat to restore it', 'energy'], hunger: ['🍲 Hunger is low — grab food before it bottoms out', 'hunger'], happy: ['😊 Happiness is low — visit a fun spot to lift it', 'happy'] };
  for (const [k, [msg]] of Object.entries(LOW_TIPS)) {
    const el = $('stat-' + k); if (!el) continue;
    const low = me[k] < 25; el.classList.toggle('low', low);
    if (low && !lowWarned.has(k)) { lowWarned.add(k); toast(msg); }
    if (!low) lowWarned.delete(k);
  }
  updateOnline();
}
// item 22: icon toasts that spring in and queue (max 3 visible, oldest drops first)
function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  let icon = '', rest = text;
  try {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const first = [...seg.segment(text)][0];
    if (first && /\p{Extended_Pictographic}/u.test(first.segment)) { icon = first.segment; rest = text.slice(first.segment.length).trim(); }
  } catch {}
  if (icon) { const ic = document.createElement('span'); ic.className = 'toast-icon'; ic.textContent = icon; el.appendChild(ic); }
  const tx = document.createElement('span'); tx.textContent = rest || text; el.appendChild(tx);
  const wrap = $('toast-wrap');
  wrap.appendChild(el);
  while (wrap.children.length > 3) wrap.firstChild.remove();
  setTimeout(() => el.classList.add('out'), 2800);
  setTimeout(() => el.remove(), 3200);
}
// item 17: city-event banner over the map (server-rotated, broadcast on day change)
let cityEvent = null;
function renderEvent(ev) {
  cityEvent = ev;
  const el = $('event-banner');
  if (!el) return;
  if (!ev) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.textContent = `${ev.icon} ${ev.name} — ${ev.desc}`;
}
// item 21: settings panel (sound + reduce-motion, persisted; ship even before item 19)
function renderSettings() {
  const body = $('settings-body');
  if (!body) return;
  body.innerHTML = '';
  body.appendChild(section('⚙️ Settings'));
  body.appendChild(row('🔊 Sound effects', 'Coin, tap + level-up sounds (WebAudio, no files)', settings.sound ? 'ON' : 'OFF', () => { settings.sound = !settings.sound; saveSettings(); renderSettings(); }));
  body.appendChild(row('🎞️ Reduce motion', 'Hides clouds, cloud shadows, birds, butterflies, kites, balloons, sunbeams, crowds, lanterns, fireflies, dawn mist, market awnings, bunting flags, river boats, house window lights, the stadium ball, Owambe fireworks, market steam, night streetlights, Rainy Day puddles, daytime road traffic, NEPA candle glows, Market Day confetti, the plane flyover & the zoo giraffe and slows map animation for comfort', settings.reduceMotion ? 'ON' : 'OFF', () => { settings.reduceMotion = !settings.reduceMotion; saveSettings(); renderSettings(); }));
  body.appendChild(row('🌿 Calm map', 'Keeps the map clean and still — all the drifting decorations (clouds, birds, kites, balloons, boats, traffic dots and the wandering residents with their greetings) stay hidden, and what remains moves slowly and gently. ON by default; turn it OFF only if you want the full busy map back.', settings.calmMap !== false ? 'ON' : 'OFF', () => { settings.calmMap = settings.calmMap === false ? true : false; saveSettings(); renderSettings(); }));
  body.appendChild(note('📳 Haptics: gentle vibration on arrival and rewards, where your phone supports it (Android).'));
}
// item 11: on-map daily quest card (server-set quest + reward; tap walks to a visit zone)
function renderQuest() {
  const el = $('quest-card');
  if (!el) return;
  if (!quest) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = '';
  const t = document.createElement('b');
  t.textContent = quest.done ? `📜 Quest done ✓` : `📜 Daily quest`;
  const s = document.createElement('span');
  s.textContent = `${quest.text} — ₦${Number(quest.reward || 0).toLocaleString()}`;
  el.append(t, s);
  el.onclick = () => {
    if (quest.done) { toast('📜 Quest done — new one tomorrow!'); return; }
    if (quest.zone && ZONES[quest.zone]) {
      clickTarget = { lat: ZONES[quest.zone].lat, lng: ZONES[quest.zone].lng };
      toast(`🚶 Heading to ${ZONES[quest.zone].name} for today's quest`);
    } else {
      toast(`📜 Today's quest: ${quest.text}`);
    }
  };
}
function openZone(key) {
  if (manualClose && currentZone === key) return;
  $('zone-icon').textContent = ZONES[key].icon;
  $('zone-name').textContent = ZONES[key].name;
  renderZone(key);
  $('zone-panel').classList.remove('hidden');
}
function closeZone() { $('zone-panel').classList.add('hidden'); }
$('zone-close').onclick = () => { manualClose = true; closeZone(); };
$('btn-help').onclick = () => $('help-panel').classList.remove('hidden');
$('btn-settings').onclick = () => { renderSettings(); $('settings-panel').classList.remove('hidden'); };
$('settings-close').onclick = () => $('settings-panel').classList.add('hidden');
// item 27: PWA install prompt (deferred until the browser fires beforeinstallprompt)
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('install-banner').classList.remove('hidden'); });
$('install-btn').onclick = async () => { if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; } $('install-banner').classList.add('hidden'); };
$('install-dismiss').onclick = () => $('install-banner').classList.add('hidden');
window.__showInstall = () => $('install-banner').classList.remove('hidden');
$('help-close').onclick = () => $('help-panel').classList.add('hidden');

function row(title, sub, btnText, fn, disabled) {
  const d = document.createElement('div');
  d.className = 'action-row';
  const info = document.createElement('div');
  info.className = 'info';
  const b = document.createElement('b'); b.textContent = title;
  const s = document.createElement('span'); s.textContent = sub;
  info.appendChild(b); info.appendChild(s);
  const btn = document.createElement('button');
  btn.className = 'go'; btn.textContent = btnText;
  btn.disabled = !!disabled;
  btn.onclick = fn;
  d.appendChild(info); d.appendChild(btn);
  return d;
}
function section(t) { const p = document.createElement('p'); p.innerHTML = `<b>${t}</b>`; p.style.margin = '10px 0 6px'; return p; }
function note(t) { const p = document.createElement('p'); p.style.cssText = 'color:#8a6d4a;font-size:13px'; p.textContent = t; return p; }

const ZONE_BLURBS = {
  ring: "The heartbeat of Benin City — King's Square. Keke drivers rule these roads.",
  palace: 'Home of the Oba of Benin. Respect the palace, guide visitors, feel the history.',
  igun: 'Igun Street — world-famous bronze casters. Hot metal, old skill, real money.',
  ekiosa: 'Ekiosa Market — busy, loud, full of deals. Traders here hustle from dawn.',
  museum: 'Benin City National Museum — bronzes, history and quiet tours.',
  stadium: 'Samuel Ogbemudia Stadium — match days here shake the whole area.',
  hospital: 'Central Hospital — ward assistants keep this place moving.',
  airport: 'Benin Airport, Airport Road — travellers, luggage and quick porter money.',
  sapele: 'Sapele Road — POS agents, shops and traffic money all day.',
  ugbowo: 'Ugbowo — student town outside UNIBEN main gate. Hostels, cafés, nightlife.',
  ekenwan: 'UNIBEN Ekenwan Campus — the second campus, across the city.',
};
const FOOD_SPOTS = {
  oba: ['mamaput', 'suya', 'banga', 'akara', 'moimoi', 'beansdodo', 'snailpeppersoup', 'afang', 'ewa', 'ogbono'], newbenin: ['shawarma', 'suya', 'jollof', 'akara', 'ofada', 'yamegg', 'afang', 'starchowho'],
  ekiosa: ['mamaput', 'asun', 'jollof', 'cornpear', 'ofada', 'nkwobi', 'snailpeppersoup', 'edikang', 'whiterice', 'ewa', 'ogbono', 'beansplantain', 'amala'], ring: ['suya', 'mamaput', 'peppersoup', 'boli', 'eba', 'catfishbbq', 'whiterice', 'beansplantain', 'amala'], hospital: ['peppersoup', 'moimoi', 'poundedyam', 'ukodo'],
  sapele: ['jollof', 'banga', 'cornpear', 'boli', 'beansdodo', 'groundnutsoup', 'starchowho'], ugbowo: ['shawarma', 'mamaput', 'eba', 'friedrice', 'yamegg', 'poundedyam', 'groundnutsoup', 'edikang', 'coconutrice'], airport: ['shawarma', 'jollof', 'friedrice', 'nkwobi', 'catfishbbq', 'ukodo', 'coconutrice'],
};
const FUN_SPOTS = { zoo: ['zoo', 'zoopicnic', 'zoofeeding', 'zoobird'], kada: ['cinema', 'kadaarcade'], stadium: ['match', 'stadiumfan'], museum: ['museum_tour', 'museumsketch', 'museumstory'], palace: ['palace_tour', 'palacegarden', 'palacedrum'], ugbowo: ['hostelparty', 'streetfootball'], sapele: ['nightmarket', 'sapelefoodtour'], airport: ['airportview', 'airportlounge'], uniben: ['campushangout', 'botanical', 'unibensports'], oba: ['bargain', 'obamusic'], igun: ['gallery', 'castingdemo'], ring: ['eveningstroll', 'ringwalk'], ekiosa: ['ekiosagist', 'ekiosadance'], housing: ['grawalk', 'grajog'], newbenin: ['newbeninshop'], ekenwan: ['ekenwanview', 'ekenwanmovie'], hospital: ['hospitalsitout'] };
function renderZone(key) {
  const body = $('zone-body');
  body.innerHTML = '';
  const z = ZONES[key];
  // item 23: distance to this zone + a Walk-there button when you're not in it
  if (z && me) {
    const zd = haversineM(me.lat, me.lng, z.lat, z.lng);
    if (zd <= z.r) body.appendChild(note(`📍 You are here — ${z.name}`));
    else {
      body.appendChild(note(`📍 ${fmtDist(zd)} away from ${z.name}`));
      // item 183: walk-there ETA — estimated walk time from distance + walk speed, display only
      // Game walk speed is ~145 m/s (gamey, not real-world pace), so short trips are seconds, not minutes.
      { const _etaSec = zd / (145 * (typeof speedMult !== 'undefined' ? speedMult : 1));
        const _etaLabel = _etaSec < 60 ? `~${Math.max(1, Math.round(_etaSec))} sec walk` : `~${Math.round(_etaSec / 60)} min walk`;
        body.appendChild(row('Walk there', `${fmtDist(zd)} away • ${_etaLabel}`, '🚶 Walk', () => { clickTarget = { lat: z.lat, lng: z.lng }; closeZone(); toast(`🚶 Heading to ${z.name}`); })); }
    }
  }
  // item 61: today's city event effect on the zone sheet — display only, from the already-sent event
  if (cityEvent) body.appendChild(note(`${cityEvent.icon} Today: ${cityEvent.name} — ${cityEvent.desc}`));
  if (ZONE_BLURBS[key]) body.appendChild(note(ZONE_BLURBS[key]));
  // item 173: zone sheet summary line — derived counts, display only, no new state
  { const _jc = Object.entries(JOBS).filter(([, j]) => j.zone === key).length; const _fc = (FOOD_SPOTS[key] || []).filter(ik => FOOD[ik]).length; const _vc = (FUN_SPOTS[key] || []).filter(fk => FUN[fk]).length; body.appendChild(note(`💼 ${_jc} jobs • 🍲 ${_fc} foods • ✨ ${_vc} fun here`)); }
  const jobsHere = Object.entries(JOBS).filter(([, j]) => j.zone === key);
  if (key === 'uniben' || key === 'ekenwan') {
    body.appendChild(section('🎓 Education'));
    if (!me.cert)
      body.appendChild(row('Study for certificate', '₦5,000 tuition • -15⚡', 'Study', () => send({ t: 'act', a: 'study' })));
    else
      body.appendChild(note('🎓 Certified! Graduate Intern unlocked.'));
  }
  if (jobsHere.length) {
    body.appendChild(section('💼 Jobs here'));
    for (const [jk, j] of jobsHere)
      body.appendChild(row(j.name, `₦${j.pay.toLocaleString()} • -${j.energy}⚡ • ${j.cd}s cooldown${j.cert ? ' • needs certificate' : ''}`, 'Work',
        () => send({ t: 'act', a: 'work', job: jk }), j.cert && !me.cert));
  }
  const foods = FOOD_SPOTS[key] || [];
  if (foods.length) {
    body.appendChild(section('🍲 Food stalls'));
    for (const ik of foods) {
      const f = FOOD[ik]; if (!f) continue;
      // item 203: full effects on food rows (hunger + energy + happiness, skipping zeroes)
      const _fp = [`+${f.hunger}🍲`]; if (f.energy) _fp.push(`+${f.energy}⚡`); if (f.happy) _fp.push(`+${f.happy}😊`);
      body.appendChild(row(f.name, `₦${f.cost.toLocaleString()} • ${_fp.join(' ')}`, 'Eat', () => send({ t: 'act', a: 'eat', item: ik })));
    }
  }
  const funs = FUN_SPOTS[key] || [];
  if (funs.length) {
    body.appendChild(section('✨ Vibes'));
    for (const fk of funs) {
      const f = FUN[fk]; if (!f) continue;
      // item 203: full effects on fun rows (happiness + energy when it moves)
      const _vp = [`+${f.happy}😊`]; if (f.energy) _vp.push(`${f.energy > 0 ? '+' : ''}${f.energy}⚡`);
      body.appendChild(row(f.name, `₦${f.cost.toLocaleString()} • ${_vp.join(' ')}`, 'Go', () => send({ t: 'act', a: 'fun', what: fk })));
    }
  }
  if (key === 'housing') {
    body.appendChild(section('🏠 Housing — rent due every day'));
    for (const [hk, h] of Object.entries(HOUSING)) {
      const cur = me.housing === hk ? ' • current' : '';
      body.appendChild(row(h.name, h.rent ? `₦${h.rent.toLocaleString()}/day${cur}` : `Free${cur}`, me.housing === hk ? '✓' : 'Move',
        () => send({ t: 'act', a: 'rent', h: hk }), me.housing === hk));
    }
  }
  body.appendChild(section('😴 Rest'));
  body.appendChild(row('Sleep', 'Restore ⚡ to full • -15🍲', 'Sleep', () => send({ t: 'act', a: 'sleep' })));
}

// chat toggle on touch devices (hidden in Storybook — the dock owns chat)
(function () {
  const btn = document.createElement('button');
  btn.id = 'chat-toggle'; btn.className = 'icon-btn'; btn.textContent = '💬';
  btn.onclick = () => $('chat-panel').classList.toggle('open');
  $('main').appendChild(btn);
})();

// bottom dock (Storybook UI)
(function () {
  const setA = (id) => document.querySelectorAll('#dock button').forEach(b => b.classList.toggle('active', b.id === id));
  const map = $('dock-map'), hustle = $('dock-hustle'), chat = $('dock-chat'), social = $('dock-social'), menu = $('dock-menu');
  if (!map) return;
  map.onclick = () => { setA('dock-map'); if (renderer && renderer.recenter) renderer.recenter(); };
  hustle.onclick = () => { setA('dock-hustle'); if (currentZone) { manualClose = false; openZone(currentZone); } else openMenu(null); };
  chat.onclick = () => { setA('dock-chat'); $('chat-panel').classList.toggle('open'); };
  social.onclick = () => { setA('dock-social'); $('btn-social').click(); };
  menu.onclick = () => { setA('dock-menu'); openMenu(null); };
})();

// auto-login if token saved
if (token && myName) {
  $('username').value = myName;
  connect();
}

// ============================================================
// MENU — Bank, Business, Garage, Election, Dice, Street Runs
// ============================================================
let menuTab = null;
const MENU_ITEMS = [
  ['bank', '🏦', 'Bank'],
  ['biz', '🏪', 'Business'],
  ['garage', '🚗', 'Garage'],
  ['election', '🗳️', 'Election'],
  ['dice', '🎲', 'Dice'],
  ['runs', '🏃', 'Street Runs'],
];
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
$('btn-menu').onclick = () => openMenu(null);
$('btn-nearby').onclick = () => {
  const p = $('nearby-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) updateNearby();
};
$('nearby-close').onclick = () => $('nearby-panel').classList.add('hidden');

function fmtDist(d) { return d < 1000 ? `${Math.round(d)}m` : `${(d / 1000).toFixed(1)}km`; }
function arrowTo(a, b) {
  const dLat = b.lat - a.lat, dLng = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180);
  const brg = (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360;
  return ['⬆️', '↗️', '➡️', '↘️', '⬇️', '↙️', '⬅️', '↖️'][Math.round(brg / 45) % 8];
}
function updateNearby() {
  if (!me || $('nearby-panel').classList.contains('hidden')) return;
  const list = $('nearby-list');
  list.innerHTML = '';
  const mkItem = (it) => {
    const div = document.createElement('div');
    div.className = 'np-item';
    const ic = document.createElement('span'); ic.className = 'np-icon'; ic.textContent = it.icon;
    const nm = document.createElement('span'); nm.className = 'np-name';
    // item 52: mark today's quest destination in the Places list
    nm.textContent = it.name + ((quest && !quest.done && quest.zone === it.key) ? ' 📜' : '');
    const ar = document.createElement('span'); ar.textContent = arrowTo(me, it);
    const ds = document.createElement('span'); ds.className = 'np-dist'; ds.textContent = fmtDist(it.d);
    // item 213: walk ETA beside the distance — same game-speed formula as the zone-sheet Walk button
    const es = document.createElement('span'); es.className = 'np-dist';
    { const _etaSec = it.d / (145 * speedMult);
      es.textContent = _etaSec < 60 ? `~${Math.max(1, Math.round(_etaSec))}s` : `~${Math.round(_etaSec / 60)}min`; }
    div.append(ic, nm, ar, ds, es);
    div.onclick = () => { clickTarget = { lat: it.lat, lng: it.lng }; toast(`🚶 Heading to ${it.name}`); };
    return div;
  };
  // item 24: Places — ALL 17 places, sorted by distance, tap one to walk there
  // item 121: header shows the total place count (display only, from the same list)
  const places = Object.entries(ZONES).map(([key, z]) => ({ key, icon: z.icon, name: z.name, d: haversineM(me.lat, me.lng, z.lat, z.lng), lat: z.lat, lng: z.lng })).sort((x, y) => x.d - y.d);
  const h1 = section(`📍 Places (${places.length})`); h1.style.padding = '0 12px'; list.appendChild(h1);
  for (const it of places) list.appendChild(mkItem(it));
  const h2 = section('🔭 Nearby finds'); h2.style.padding = '0 12px'; list.appendChild(h2);
  const finds = [];
  for (const sp of spawns.values()) {
    const d = haversineM(me.lat, me.lng, sp.lat, sp.lng);
    if (d < 1500) finds.push({
      icon: sp.icon, d, lat: sp.lat, lng: sp.lng,
      name: sp.kind === 'cash' ? `₦${sp.amount.toLocaleString()}` : sp.kind === 'snack' ? 'Snack' : sp.kind === 'airtime' ? 'Airtime' : sp.kind === 'fruit' ? 'Fruit' : 'Energy drink',
    });
  }
  finds.sort((x, y) => x.d - y.d);
  if (!finds.length) list.appendChild(Object.assign(document.createElement('div'), { className: 'np-empty', textContent: 'No street finds nearby — keep walking! 🚶' }));
  else for (const it of finds.slice(0, 9)) list.appendChild(mkItem(it));
}
setInterval(updateNearby, 3000);
$('menu-close').onclick = () => { $('menu-panel').classList.add('hidden'); menuTab = null; };

function openMenu(tab) {
  menuTab = tab;
  $('menu-panel').classList.remove('hidden');
  renderMenuBody();
}
function arow() { const d = document.createElement('div'); d.className = 'arow'; return d; }
function numInput(ph) { const i = document.createElement('input'); i.type = 'number'; i.min = '1'; i.placeholder = ph || 'Amount'; return i; }

function renderMenuBody() {
  const body = $('menu-body');
  body.innerHTML = '';
  if (!menuTab) {
    $('menu-title').textContent = 'Menu';
    const grid = document.createElement('div');
    grid.className = 'menu-grid';
    for (const [key, icon, label] of MENU_ITEMS) {
      const b = document.createElement('button');
      b.className = 'menu-tile';
      b.innerHTML = `<span class="mt-icon">${icon}</span><span>${label}</span>`;
      b.onclick = () => openMenu(key);
      grid.appendChild(b);
    }
    if (me.gov) {
      const gb = document.createElement('button');
      gb.className = 'menu-tile gov-tile';
      gb.innerHTML = `<span class="mt-icon">👑</span><span>Governor Broadcast</span>`;
      gb.onclick = () => openMenu('govbc');
      grid.appendChild(gb);
    }
    body.appendChild(grid);
    return;
  }
  const back = document.createElement('button');
  back.className = 'go'; back.textContent = '‹ Back'; back.style.marginBottom = '10px';
  back.onclick = () => openMenu(null);
  body.appendChild(back);
  ({ bank: renderBank, biz: renderBizMenu, garage: renderGarage, election: renderElection, dice: renderDice, runs: renderRuns, govbc: renderGovBc }[menuTab] || (() => {}))(body);
}

function renderBank(body) {
  $('menu-title').textContent = '🏦 Bank';
  body.appendChild(section('Your money'));
  body.appendChild(note(`Cash: ${fmt(me.cash)} • Savings: ${fmt(me.savings)} (2%/day) • Loan: ${fmt(me.loan)} (10%/day)`));
  // item 43: net worth, derived from already-known values — no new storage
  const _nw = (me.cash || 0) + (me.savings || 0) - (me.loan || 0)
    + (myBiz && BIZT[myBiz] ? BIZT[myBiz].cost : 0)
    + (me.vehicle && VEHT[me.vehicle] ? VEHT[me.vehicle].cost : 0);
  body.appendChild(note(`💰 Net worth: ${fmt(_nw)} (cash + savings − loan + business + ride)`));
  // item 62: daily business income, derived from the owned business — display only, no new storage
  body.appendChild(note(`📈 Daily business income: ${fmt(myBiz && BIZT[myBiz] ? BIZT[myBiz].income : 0)}/day`));
  // item 73: rent due today, derived from current housing — display only, no new storage
  body.appendChild(note(`🏠 Rent due today: ${fmt(HOUSING[me.housing] ? HOUSING[me.housing].rent : 0)}/day`));
  // item 81: tomorrow's savings interest preview — 2% of savings, derived display only, no economy change
  body.appendChild(note(`💹 Tomorrow's savings interest: ${fmt(Math.floor((me.savings || 0) * 0.02))} (2% of your savings)`));
  // item 233: total liquid, derived display only (cash + savings) — no new storage
  body.appendChild(note(`💵 Total liquid: ${fmt((me.cash || 0) + (me.savings || 0))} (cash + savings)`));
  // item 110: daily outgoings, derived display only (rent + 10% loan interest) — no new storage
  body.appendChild(note(`💸 Daily outgoings: ${fmt((HOUSING[me.housing] ? HOUSING[me.housing].rent : 0) + Math.floor((me.loan || 0) * 0.10))}/day (rent + loan interest)`));
  const di = numInput('Amount'); const wi = numInput('Amount');
  body.appendChild(section('Deposit / Withdraw'));
  // item 211: quick-amount chips fill the deposit + withdraw inputs on tap
  { const cr = arow();
    for (const amt of [1000, 5000, 10000]) {
      const cb = document.createElement('button'); cb.className = 'go small'; cb.textContent = `₦${amt.toLocaleString()}`;
      cb.onclick = () => { di.value = amt; wi.value = amt; };
      cr.appendChild(cb);
    }
    body.appendChild(cr); }
  let r = arow();
  const db = document.createElement('button');
  db.className = 'go'; db.textContent = 'Deposit';
  db.onclick = () => send({ t: 'act', a: 'bank', op: 'deposit', amount: +di.value });
  r.appendChild(di); r.appendChild(db); body.appendChild(r);
  r = arow();
  const wb = document.createElement('button');
  wb.className = 'go'; wb.textContent = 'Withdraw';
  wb.onclick = () => send({ t: 'act', a: 'bank', op: 'withdraw', amount: +wi.value });
  r.appendChild(wi); r.appendChild(wb); body.appendChild(r);
  body.appendChild(section('Loans — up to ₦100,000'));
  if (me.loan > 0) {
    body.appendChild(note(`Owing: ${fmt(me.loan)}`));
    r = arow();
    const pi = numInput('Repay amount'); const pb = document.createElement('button');
    pb.className = 'go'; pb.textContent = 'Repay';
    pb.onclick = () => send({ t: 'act', a: 'repay', amount: +pi.value });
    r.appendChild(pi); r.appendChild(pb); body.appendChild(r);
  } else {
    r = arow();
    const li = numInput('Loan amount'); const lb = document.createElement('button');
    lb.className = 'go'; lb.textContent = 'Borrow';
    lb.onclick = () => send({ t: 'act', a: 'loan', amount: +li.value });
    r.appendChild(li); r.appendChild(lb); body.appendChild(r);
  }
}

function renderBizMenu(body) {
  $('menu-title').textContent = '🏪 Business';
  if (myBiz && BIZT[myBiz]) {
    const b = BIZT[myBiz];
    body.appendChild(note(`${b.icon} You own a ${b.name} — it earns you ₦${b.income.toLocaleString()} every game day.`));
  } else {
    body.appendChild(section('Buy a business — daily income'));
    for (const [k, b] of Object.entries(BIZT))
      body.appendChild(row(`${b.icon} ${b.name}`, `₦${b.cost.toLocaleString()} • +₦${b.income.toLocaleString()}/day`, 'Buy',
        () => send({ t: 'act', a: 'buy_biz', biz: k }), me.cash < b.cost));
  }
}

function renderGarage(body) {
  $('menu-title').textContent = '🚗 Garage';
  const cur = VEHT[me.vehicle] || VEHT.none;
  body.appendChild(note(`Current: ${cur.icon} ${cur.name} (${speedMult}x speed)`));
  body.appendChild(section('Buy a ride — move faster'));
  for (const [k, v] of Object.entries(VEHT)) {
    if (k === 'none') continue;
    const owned = me.vehicle === k;
    body.appendChild(row(`${v.icon} ${v.name}`, `₦${v.cost.toLocaleString()} • ${v.mult}x speed`, owned ? '✓' : 'Buy',
      () => send({ t: 'act', a: 'buy_vehicle', v: k }), owned || me.cash < v.cost));
  }
}

function renderElection(body) {
  $('menu-title').textContent = '🗳️ Election';
  if (governor) body.appendChild(note(`👑 Current Governor: ${governor.name} (salary ₦25,000/day, daily city broadcast)`));
  if (!election.active) { body.appendChild(note('No election running right now.')); return; }
  body.appendChild(note(`Race ends in ~${election.endsInDays} game day(s). ${election.voted ? 'You have voted ✓' : 'You have not voted yet.'}`));
  body.appendChild(section('Candidates'));
  if (!election.candidates.length) body.appendChild(note('No candidates yet. Be the first!'));
  for (const c of election.candidates) {
    const isGov = governor && Number(c.player_id) === governor.id;
    body.appendChild(row(`${isGov ? '👑 ' : ''}${c.username}`, `${c.votes} vote(s)`,
      election.voted ? '🗳' : 'Vote',
      () => send({ t: 'act', a: 'vote', candidate: c.player_id }), election.voted));
  }
  body.appendChild(section('Run for Governor'));
  if (election.running) body.appendChild(note('You are on the ballot! Campaign in the city chat.'));
  else body.appendChild(row('Join the race', '₦50,000 campaign fee', 'Run',
    () => { if (confirm('Pay ₦50,000 campaign fee to run for Governor?')) send({ t: 'act', a: 'run' }); },
    me.cash < 50000));
}

let dicePick = 0;
function renderDice(body) {
  $('menu-title').textContent = '🎲 Dice';
  body.appendChild(note('Pick 1–6. Roll your number, win 5x your stake! Stake: ₦100 – ₦10,000.'));
  const picks = document.createElement('div'); picks.className = 'dice-picks';
  for (let i = 1; i <= 6; i++) {
    const b = document.createElement('button');
    b.className = 'dice-btn' + (dicePick === i ? ' sel' : '');
    b.textContent = i;
    b.onclick = () => { dicePick = i; renderMenuBody(); };
    picks.appendChild(b);
  }
  body.appendChild(picks);
  const r = arow();
  const inp = numInput('Stake'); inp.value = 500;
  const go = document.createElement('button'); go.className = 'go'; go.textContent = 'Roll 🎲';
  go.onclick = () => {
    if (!dicePick) return toast('Pick a number first!');
    send({ t: 'act', a: 'bet', amount: +inp.value, pick: dicePick });
  };
  r.appendChild(inp); r.appendChild(go); body.appendChild(r);
}

function renderRuns(body) {
  $('menu-title').textContent = '🏃 Street Runs';
  body.appendChild(note('Risky street hustle. 60% chance you score ₦3k–₦8k. Sometimes police dodge am, sometimes wahala: ₦10,000 "bail" or 3 minutes detention. Cooldown 2 min.'));
  const b = document.createElement('button'); b.className = 'primary'; b.textContent = 'Do street runs 🏃';
  b.style.marginTop = '10px';
  b.onclick = () => send({ t: 'act', a: 'runs' });
  body.appendChild(b);
}

function renderGovBc(body) {
  $('menu-title').textContent = '👑 Governor Broadcast';
  body.appendChild(note('As Governor, your word carries weight. Address the city (once per day):'));
  const r = arow();
  const inp = document.createElement('input'); inp.placeholder = 'Announcement…'; inp.maxLength = 200;
  const go = document.createElement('button'); go.className = 'go'; go.textContent = 'Send';
  go.onclick = () => { if (inp.value.trim()) { send({ t: 'act', a: 'gov_broadcast', text: inp.value }); inp.value = ''; } };
  r.appendChild(inp); r.appendChild(go); body.appendChild(r);
}

// ============================================================
// DMS
// ============================================================
let dmWith = null, dmWithName = '';
$('btn-dm').onclick = () => { $('dm-panel').classList.remove('hidden'); dmWith = null; send({ t: 'dm_threads' }); };
$('dm-close').onclick = () => $('dm-panel').classList.add('hidden');
$('dm-back').onclick = () => { dmWith = null; send({ t: 'dm_threads' }); };

function updateDmBadge() {
  const b = $('dm-badge');
  if (unreadDm > 0) { b.textContent = unreadDm > 9 ? '9+' : unreadDm; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

function renderThreads(threads) {
  dmWith = null;
  $('dm-back').classList.add('hidden');
  const body = $('dm-body'); body.innerHTML = '';
  if (!threads.length) body.appendChild(note('No messages yet. Tap any player on the map to message them.'));
  for (const th of threads) {
    const d = document.createElement('div'); d.className = 'dm-thread';
    const b = document.createElement('b'); b.textContent = th.username;
    const prev = document.createElement('span'); prev.className = 'dm-prev'; prev.textContent = th.last_text || '';
    d.appendChild(b); d.appendChild(document.createTextNode(' ')); d.appendChild(prev);
    if (th.unread > 0) {
      const tag = document.createElement('span'); tag.className = 'tag on'; tag.textContent = th.unread + ' new';
      d.appendChild(document.createTextNode(' ')); d.appendChild(tag);
    }
    d.onclick = () => { dmWith = th.pid; dmWithName = th.username; send({ t: 'dm_history', with: th.pid }); };
    body.appendChild(d);
  }
}

function renderConversation(withId, withName, msgs) {
  $('dm-back').classList.remove('hidden');
  const body = $('dm-body'); body.innerHTML = '';
  const box = document.createElement('div'); box.id = 'dm-conv';
  for (const m of msgs) {
    const d = document.createElement('div');
    d.className = 'msg' + (m.from_id === me.id ? ' me' : '');
    d.appendChild(document.createTextNode(m.text));
    box.appendChild(d);
  }
  body.appendChild(box);
  box.scrollTop = box.scrollHeight;
  const r = arow();
  const inp = document.createElement('input'); inp.placeholder = `Message ${withName}…`; inp.maxLength = 200;
  const go = document.createElement('button'); go.className = 'go'; go.textContent = '➤';
  const sendDm = () => {
    const t = inp.value.trim(); if (!t) return;
    send({ t: 'dm', to: withId, text: t });
    const d = document.createElement('div'); d.className = 'msg me'; d.textContent = t;
    box.appendChild(d); box.scrollTop = box.scrollHeight; inp.value = '';
  };
  go.onclick = sendDm;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDm(); });
  r.appendChild(inp); r.appendChild(go); body.appendChild(r);
  send({ t: 'dm_read' });
}

// ============================================================
// PROFILES
// ============================================================
function openProfile(id) {
  send({ t: 'profile', id });
  $('profile-modal').classList.remove('hidden');
  $('profile-title').textContent = '👤';
  $('profile-body').innerHTML = '<p style="color:#8a6d4a">Loading…</p>';
}
$('profile-close').onclick = () => $('profile-modal').classList.add('hidden');

function renderProfile(p) {
  $('profile-title').textContent = (p.gov ? '👑 ' : '') + p.username;
  const body = $('profile-body'); body.innerHTML = '';
  const v = (VEHT && VEHT[p.vehicle]) || { icon: '🚶', name: 'On foot' };
  const rows = [
    ['Status', p.online ? '🟢 online' : '⚫ offline'],
    ['Level', `⭐ Lv ${p.level || levelOf(p.xp)}`],
    ['XP', `${Number(p.xp) || 0} XP — ${(p.level || levelOf(p.xp)) * 150 - (Number(p.xp) || 0)} to next level`],
    ['Cash', fmt(p.cash)],
    ['Housing', ((HOUSING || {})[p.housing] || {}).name || p.housing],
    ['Vehicle', `${v.icon} ${v.name}`],
    ['Business', p.biz && BIZT[p.biz] ? `${BIZT[p.biz].icon} ${BIZT[p.biz].name}` : '—'],
    ['Education', p.cert ? '🎓 Certified' : '—'],
  ];
  for (const [k, val] of rows) {
    const d = document.createElement('div'); d.className = 'prof-row';
    const s = document.createElement('span'); s.textContent = k;
    const b = document.createElement('b'); b.textContent = val;
    d.appendChild(s); d.appendChild(b); body.appendChild(d);
  }
  if (p.badges && p.badges.length) {
    body.appendChild(section('🏅 Achievements'));
    for (const bd of p.badges) {
      const d = document.createElement('div'); d.className = 'prof-row';
      const s2 = document.createElement('span'); s2.textContent = `${bd.icon} ${bd.label}`;
      const v2 = document.createElement('b'); v2.textContent = bd.earned ? '✓ Earned' : 'Not yet';
      d.appendChild(s2); d.appendChild(v2); body.appendChild(d);
    }
  }
  if (p.id !== me.id) {
    const b = document.createElement('button'); b.className = 'primary';
    b.style.marginTop = '12px'; b.textContent = `✉️ Message ${p.username}`;
    b.onclick = () => {
      $('profile-modal').classList.add('hidden');
      $('dm-panel').classList.remove('hidden');
      dmWith = p.id; dmWithName = p.username;
      send({ t: 'dm_history', with: p.id });
    };
    body.appendChild(b);
  }
}

// ============================================================
// LIVE COUNTERS on the auth screen
// ============================================================
async function loadStats() {
  try {
    const r = await fetch('/api/stats');
    const s = await r.json();
    $('live-counts').textContent =
      `🟢 ${s.online} online now • 👥 ${(s.visits || 0).toLocaleString()} visits` +
      (s.governor ? ` • 👑 Gov ${s.governor}` : '');
  } catch {}
}
loadStats();
setInterval(loadStats, 30000);

// ============================================================
// SOCIAL: friends & topic rooms
// ============================================================
function updateSocialBadge() {
  const reqN = friends.filter(f => f.incoming).length;
  const roomN = rooms.reduce((a, r) => a + (r.unread || 0), 0);
  const n = reqN + roomN;
  const b = $('social-badge');
  b.textContent = n > 99 ? '99+' : n;
  b.classList.toggle('hidden', n === 0);
  const rb = $('req-badge');
  rb.textContent = reqN;
  rb.classList.toggle('hidden', reqN === 0);
}
function openSocial(tab) {
  $('social-panel').classList.remove('hidden');
  document.querySelectorAll('.sp-tab-btn').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  document.querySelectorAll('.sp-tab').forEach(x => x.classList.add('hidden'));
  $('sp-' + tab).classList.remove('hidden');
  if (tab === 'friends') renderFriends();
  if (tab === 'rooms') { send({ t: 'rooms' }); renderRooms(); }
  if (tab === 'requests') renderRequests();
}
function spEmpty(text) {
  const d = document.createElement('div');
  d.className = 'sp-empty'; d.textContent = text;
  return d;
}
function renderFriends() {
  const list = $('friends-list');
  list.innerHTML = '';
  const accepted = friends.filter(f => f.status === 'accepted');
  const pendingOut = friends.filter(f => f.status === 'pending' && !f.incoming);
  if (!accepted.length && !pendingOut.length) {
    list.appendChild(spEmpty('No friends yet — add someone by username above 👆'));
    return;
  }
  for (const f of [...accepted, ...pendingOut]) {
    const div = document.createElement('div');
    div.className = 'sp-row';
    const dot = document.createElement('span');
    dot.className = 'online-dot' + (f.online ? ' on' : '');
    dot.title = f.online ? 'Online' : 'Offline';
    const nm = document.createElement('b'); nm.textContent = f.other_username;
    div.append(dot, nm);
    if (f.status === 'pending') {
      const s = document.createElement('span'); s.className = 'muted'; s.textContent = 'request sent…';
      div.append(s);
    } else {
      if (f.online && f.lat != null) {
        const walk = document.createElement('button');
        walk.className = 'go small'; walk.textContent = '📍'; walk.title = 'Walk to friend';
        walk.onclick = () => {
          clickTarget = { lat: f.lat, lng: f.lng };
          toast(`🚶 Heading to ${f.other_username}`);
          $('social-panel').classList.add('hidden');
        };
        div.append(walk);
      }
      const dm = document.createElement('button');
      dm.className = 'go small'; dm.textContent = '✉️'; dm.title = 'Message';
      dm.onclick = () => {
        $('social-panel').classList.add('hidden');
        $('dm-panel').classList.remove('hidden');
        dmWith = f.other_id; dmWithName = f.other_username;
        send({ t: 'dm_history', with: f.other_id });
      };
      const rm = document.createElement('button');
      rm.className = 'go small danger'; rm.textContent = '✕'; rm.title = 'Remove friend';
      rm.onclick = () => { if (confirm(`Remove ${f.other_username} from friends?`)) send({ t: 'friend_remove', playerId: f.other_id }); };
      div.append(dm, rm);
    }
    list.appendChild(div);
  }
}
function renderRequests() {
  const list = $('requests-list');
  list.innerHTML = '';
  const inc = friends.filter(f => f.incoming);
  if (!inc.length) { list.appendChild(spEmpty('No pending friend requests.')); return; }
  for (const f of inc) {
    const div = document.createElement('div');
    div.className = 'sp-row';
    const nm = document.createElement('b'); nm.textContent = f.other_username;
    const acc = document.createElement('button'); acc.className = 'go small'; acc.textContent = 'Accept';
    acc.onclick = () => send({ t: 'friend_accept', playerId: f.other_id });
    const dec = document.createElement('button'); dec.className = 'go small danger'; dec.textContent = 'Decline';
    dec.onclick = () => send({ t: 'friend_decline', playerId: f.other_id });
    div.append(nm, acc, dec);
    list.appendChild(div);
  }
}
function renderRooms() {
  const list = $('rooms-list');
  if (!list) return;
  list.innerHTML = '';
  const city = document.createElement('div');
  city.className = 'sp-row static';
  const c1 = document.createElement('span'); c1.textContent = '🌆';
  const c2 = document.createElement('b'); c2.textContent = 'City Chat';
  const c3 = document.createElement('span'); c3.className = 'muted'; c3.textContent = 'the general — always on';
  city.append(c1, c2, c3);
  list.appendChild(city);
  for (const r of rooms) {
    const div = document.createElement('div');
    div.className = 'sp-row' + (r.joined ? ' joined' : '');
    const ic = document.createElement('span'); ic.className = 'sp-ricon'; ic.textContent = r.icon;
    const info = document.createElement('div'); info.className = 'sp-rinfo';
    const nm = document.createElement('b'); nm.textContent = r.name;
    const tp = document.createElement('span'); tp.className = 'muted';
    tp.textContent = (r.topic ? r.topic + ' • ' : '') + r.members + (Number(r.members) === 1 ? ' member' : ' members');
    info.append(nm, tp);
    div.append(ic, info);
    if (r.unread > 0) {
      const b = document.createElement('span'); b.className = 'badge static';
      b.textContent = r.unread > 99 ? '99+' : r.unread;
      div.append(b);
    }
    const btn = document.createElement('button');
    btn.className = 'go small';
    btn.textContent = r.joined ? 'Open' : 'Join';
    btn.onclick = () => {
      if (!r.joined) send({ t: 'join_room', roomId: r.id });
      else openRoomView(Number(r.id));
    };
    div.append(btn);
    list.appendChild(div);
  }
}
function openRoomView(roomId) {
  openRoomId = roomId;
  const r = rooms.find(x => Number(x.id) === roomId);
  $('room-title').textContent = `${r ? r.icon : '💬'} ${r ? r.name : 'Room'}`;
  $('room-topic').textContent = r && r.topic ? r.topic : '';
  $('room-msgs').innerHTML = '';
  $('room-members-list').classList.add('hidden');
  $('room-members-list').innerHTML = '';
  for (const m of (roomHist.get(roomId) || [])) appendRoomMsg(m);
  $('room-panel').classList.remove('hidden');
  $('social-panel').classList.add('hidden');
  send({ t: 'room_read', roomId });
  if (r) { r.unread = 0; renderRooms(); updateSocialBadge(); }
}
function closeRoomView() {
  openRoomId = null;
  $('room-panel').classList.add('hidden');
}
function appendRoomMsg(m) {
  const box = $('room-msgs');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'msg' + (m.name === myName ? ' me' : '');
  const who = document.createElement('span'); who.className = 'who';
  who.textContent = m.name + (m.gov ? ' 👑' : '');
  const tx = document.createElement('span'); tx.textContent = ': ' + m.text;
  d.append(who, tx);
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}
function renderRoomMembers(roomId, members) {
  const box = $('room-members-list');
  box.classList.remove('hidden');
  box.innerHTML = '';
  const r = rooms.find(x => Number(x.id) === roomId);
  const canMod = (r && Number(r.creator_id) === me.id) || (me && me.is_admin);
  const title = document.createElement('div');
  title.className = 'sp-mtitle'; title.textContent = `Members (${members.length})`;
  box.appendChild(title);
  for (const mb of members) {
    const div = document.createElement('div'); div.className = 'sp-row';
    const dot = document.createElement('span');
    dot.className = 'online-dot' + (mb.online ? ' on' : '');
    const nm = document.createElement('b'); nm.textContent = mb.username;
    div.append(dot, nm);
    if (mb.role === 'owner') { const s = document.createElement('span'); s.className = 'muted'; s.textContent = 'owner'; div.append(s); }
    if (Date.now() < mb.muted_until) { const s = document.createElement('span'); s.className = 'muted'; s.textContent = '🔇 muted'; div.append(s); }
    if (canMod && mb.player_id !== me.id) {
      const kick = document.createElement('button'); kick.className = 'go small danger'; kick.textContent = 'Kick';
      kick.onclick = () => send({ t: 'kick_room', roomId, playerId: mb.player_id });
      const mute = document.createElement('button'); mute.className = 'go small'; mute.textContent = 'Mute 10m';
      mute.onclick = () => send({ t: 'mute_room', roomId, playerId: mb.player_id, minutes: 10 });
      div.append(kick, mute);
    }
    box.appendChild(div);
  }
}
$('btn-social').onclick = () => openSocial('friends');
$('social-close').onclick = () => $('social-panel').classList.add('hidden');
document.querySelectorAll('.sp-tab-btn').forEach(b => { b.onclick = () => openSocial(b.dataset.tab); });
$('friend-add-btn').onclick = () => {
  const v = $('friend-search').value.trim();
  if (v) { send({ t: 'friend_add', username: v }); $('friend-search').value = ''; }
};
$('friend-search').addEventListener('keydown', e => { if (e.key === 'Enter') $('friend-add-btn').click(); });
$('room-create-btn').onclick = () => {
  const name = $('room-name').value.trim();
  if (!name) return toast('Give the room a name.');
  send({ t: 'create_room', name, topic: $('room-topic').value.trim(), icon: '💬' });
  $('room-name').value = ''; $('room-topic').value = '';
};
$('room-close').onclick = () => closeRoomView();
$('room-leave-btn').onclick = () => { if (openRoomId) send({ t: 'leave_room', roomId: openRoomId }); };
$('room-members-btn').onclick = () => {
  const box = $('room-members-list');
  if (!openRoomId) return;
  if (box.classList.contains('hidden')) send({ t: 'room_members', roomId: openRoomId });
  else { box.classList.add('hidden'); box.innerHTML = ''; }
};
const sendRoomChat = () => {
  const v = $('room-input').value.trim();
  if (v && openRoomId) { send({ t: 'room_chat', roomId: openRoomId, text: v }); $('room-input').value = ''; }
};
$('room-send').onclick = sendRoomChat;
$('room-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendRoomChat(); });
