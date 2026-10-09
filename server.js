const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_, res) => res.send('ok'));

const ROLE_NAMES = { werewolf: 'Werewolf', villager: 'Villager', seer: 'Seer', doctor: 'Doctor', hunter: 'Hunter' };
const rooms = {};

const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const alive = r => r.players.filter(p => p.alive);
const byId = (r, id) => r.players.find(p => p.id === id);
const say = (r, m) => { r.log.push(m); if (r.log.length > 100) r.log.shift(); };
const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16);
const validPid = p => typeof p === 'string' && /^[\w-]{8,64}$/.test(p);

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); } while (rooms[c]);
  return c;
}

function buildRoles(n) {
  const roles = Array(Math.max(1, Math.floor(n / 4))).fill('werewolf');
  roles.push('seer');
  if (n >= 5) roles.push('doctor');
  if (n >= 7) roles.push('hunter');
  while (roles.length < n) roles.push('villager');
  return shuffle(roles);
}
function roleCounts(n) { const c = {}; buildRoles(n).forEach(r => c[r] = (c[r] || 0) + 1); return c; }

const newPlayer = (id, name, sock) => ({ id, name, sock, role: null, alive: true, seen: [] });

/* ---------- views ---------- */
function actionFor(room, me) {
  if (room.phase === 'hunter') return room.hunterId === me.id ? 'shoot' : null;
  if (!me.alive) return null;
  if (room.phase === 'day') return 'vote';
  if (room.phase === 'night') {
    const n = room.night;
    if (me.role === 'werewolf') return 'kill';
    if (me.role === 'seer' && !n.seerDone) return 'inspect';
    if (me.role === 'doctor' && !n.doctorDone) return 'protect';
  }
  return null;
}

function view(room, me) {
  const over = room.phase === 'over';
  const wolf = me.role === 'werewolf';
  const v = {
    code: room.code, phase: room.phase, round: room.round,
    isHost: room.hostId === me.id,
    me: { id: me.id, name: me.name, role: me.role, alive: me.alive, seen: me.role === 'seer' ? me.seen : undefined },
    players: room.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive, online: !!p.sock, host: p.id === room.hostId,
      role: (over || !p.alive || p.id === me.id || (wolf && p.role === 'werewolf')) ? p.role : null
    })),
    log: room.log, chat: room.chat, winner: room.winner,
    action: actionFor(room, me),
    votes: room.phase === 'day' ? room.votes : {}
  };
  if (room.phase === 'lobby') v.roleCounts = roleCounts(room.players.length);
  if (wolf) { v.wolfChat = room.wolfChat; if (room.phase === 'night') v.wolfVotes = room.night.wolfVotes; }
  return v;
}

function broadcast(room) {
  room.touched = Date.now();
  for (const p of room.players) if (p.sock) io.to(p.sock).emit('state', view(room, p));
}

/* ---------- game flow ---------- */
function checkWin(room) {
  const a = alive(room);
  const w = a.filter(p => p.role === 'werewolf').length;
  if (w === 0) return 'villagers';
  if (w >= a.length - w) return 'werewolves';
  return null;
}

function endGame(room, winner) {
  room.phase = 'over'; room.winner = winner;
  say(room, winner === 'villagers' ? '🏘️ All the werewolves are dead. The villagers win!' : '🐺 The werewolves have overrun the village!');
  broadcast(room);
}

function startNight(room) {
  room.phase = 'night'; room.round++; room.votes = {};
  const has = role => alive(room).some(p => p.role === role);
  room.night = { wolfVotes: {}, seerDone: !has('seer'), doctorDone: !has('doctor'), protect: null };
  say(room, `🌙 Night ${room.round} falls. The village goes to sleep…`);
  broadcast(room);
}

function startDay(room) {
  room.phase = 'day'; room.votes = {};
  say(room, `🗳️ Day ${room.round}: discuss, then vote to execute someone.`);
  broadcast(room);
}

function advance(room, next) {
  const w = checkWin(room);
  if (w) return endGame(room, w);
  if (next === 'day') startDay(room); else startNight(room);
}

function eliminate(room, p, msg, next) {
  p.alive = false;
  say(room, `${p.name} ${msg} They were a ${ROLE_NAMES[p.role]}.`);
  if (p.role === 'hunter') {
    room.phase = 'hunter'; room.hunterId = p.id; room.next = next;
    say(room, `🏹 ${p.name} is the Hunter and takes a final shot…`);
    return broadcast(room);
  }
  advance(room, next);
}

function resolveNight(room) {
  const n = room.night;
  const wolves = alive(room).filter(p => p.role === 'werewolf');
  if (!wolves.every(w => n.wolfVotes[w.id]) || !n.seerDone || !n.doctorDone) return broadcast(room);
  const tally = {};
  wolves.forEach(w => { const t = n.wolfVotes[w.id]; tally[t] = (tally[t] || 0) + 1; });
  const max = Math.max(...Object.values(tally));
  const top = Object.keys(tally).filter(k => tally[k] === max);
  const target = byId(room, top[Math.floor(Math.random() * top.length)]);
  say(room, '☀️ Dawn breaks.');
  if (target.id === n.protect) {
    say(room, 'Nobody died in the night. Someone was protected!');
    return advance(room, 'day');
  }
  eliminate(room, target, 'was killed by the werewolves in the night.', 'day');
}

function removePlayer(room, id) {
  room.players = room.players.filter(p => p.id !== id);
  if (!room.players.length) { delete rooms[room.code]; return; }
  if (room.hostId === id) room.hostId = (room.players.find(p => p.sock) || room.players[0]).id;
  broadcast(room);
}

/* ---------- sockets ---------- */
io.on('connection', socket => {
  let code = null, pid = null;
  const err = m => socket.emit('err', m);
  const ctx = () => { const room = rooms[code]; return [room, room && byId(room, pid)]; };
  const attach = (room, p) => { code = room.code; pid = p; };

  function leaveRoom() {
    const [room, me] = ctx();
    if (room && me) {
      if (room.phase === 'lobby') removePlayer(room, pid);
      else { me.sock = null; broadcast(room); }
    }
    code = null;
  }

  socket.on('list', cb => {
    if (typeof cb !== 'function') return;
    cb(Object.values(rooms)
      .filter(r => r.phase === 'lobby' && r.players.some(p => p.sock))
      .map(r => ({ code: r.code, host: (byId(r, r.hostId) || {}).name, count: r.players.length })));
  });

  socket.on('create', ({ name, pid: p } = {}) => {
    if (!validPid(p)) return err('Bad session');
    name = cleanName(name); if (!name) return err('Enter a name');
    leaveRoom();
    const room = {
      code: makeCode(), hostId: p, players: [newPlayer(p, name, socket.id)], phase: 'lobby', round: 0,
      night: null, votes: {}, log: [], chat: [], wolfChat: [], winner: null, hunterId: null, next: null, touched: Date.now()
    };
    rooms[room.code] = room;
    attach(room, p);
    broadcast(room);
  });

  socket.on('join', ({ name, pid: p, code: c } = {}) => {
    if (!validPid(p)) return err('Bad session');
    name = cleanName(name); if (!name) return err('Enter a name');
    c = String(c || '').toUpperCase().trim();
    const room = rooms[c];
    if (!room) return err('Game not found');
    if (code && code !== c) leaveRoom();
    let me = byId(room, p);
    if (me) { me.sock = socket.id; }
    else {
      if (room.phase !== 'lobby') return err('That game has already started');
      if (room.players.length >= 16) return err('Game is full');
      if (room.players.some(x => x.name.toLowerCase() === name.toLowerCase())) return err('That name is taken in this game');
      room.players.push(newPlayer(p, name, socket.id));
    }
    attach(room, p);
    broadcast(room);
  });

  socket.on('leave', () => { leaveRoom(); socket.emit('left'); });

  socket.on('start', () => {
    const [room, me] = ctx();
    if (!me || room.phase !== 'lobby' || room.hostId !== me.id) return;
    if (room.players.length < 4) return err('Need at least 4 players');
    const roles = buildRoles(room.players.length);
    room.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.seen = []; });
    Object.assign(room, { round: 0, log: [], chat: [], wolfChat: [], winner: null, hunterId: null });
    say(room, `The game begins with ${room.players.length} players.`);
    startNight(room);
  });

  socket.on('nightAction', targetId => {
    const [room, me] = ctx();
    if (!me || room.phase !== 'night' || !me.alive) return;
    const t = byId(room, targetId);
    if (!t || !t.alive) return;
    const n = room.night;
    if (me.role === 'werewolf') {
      if (t.role === 'werewolf') return err('Pick a villager');
      n.wolfVotes[me.id] = t.id;
    } else if (me.role === 'seer' && !n.seerDone) {
      if (t.id === me.id) return;
      me.seen.push({ name: t.name, wolf: t.role === 'werewolf' });
      n.seerDone = true;
    } else if (me.role === 'doctor' && !n.doctorDone) {
      n.protect = t.id; n.doctorDone = true;
    } else return;
    resolveNight(room);
  });

  socket.on('vote', targetId => {
    const [room, me] = ctx();
    if (!me || room.phase !== 'day' || !me.alive) return;
    if (targetId !== 'skip') {
      const t = byId(room, targetId);
      if (!t || !t.alive || t.id === me.id) return;
    }
    room.votes[me.id] = targetId;
    if (!alive(room).every(p => room.votes[p.id])) return broadcast(room);
    const tally = {}; let skips = 0;
    Object.values(room.votes).forEach(t => t === 'skip' ? skips++ : (tally[t] = (tally[t] || 0) + 1));
    const max = Math.max(0, ...Object.values(tally));
    const top = Object.keys(tally).filter(k => tally[k] === max);
    if (max === 0 || skips >= max || top.length !== 1) {
      say(room, 'The village could not agree. No one was executed.');
      return advance(room, 'night');
    }
    eliminate(room, byId(room, top[0]), 'was executed by the village.', 'night');
  });

  socket.on('hunterShot', targetId => {
    const [room, me] = ctx();
    if (!me || room.phase !== 'hunter' || room.hunterId !== me.id) return;
    const t = byId(room, targetId);
    if (!t || !t.alive) return;
    const next = room.next;
    room.hunterId = null;
    t.alive = false;
    say(room, `🏹 ${me.name} shoots ${t.name}, who was a ${ROLE_NAMES[t.role]}.`);
    advance(room, next);
  });

  socket.on('chat', ({ text, wolf } = {}) => {
    const [room, me] = ctx();
    if (!me) return;
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    if (wolf) {
      if (me.role !== 'werewolf' || !me.alive || room.phase !== 'night') return;
      room.wolfChat.push({ name: me.name, text });
      if (room.wolfChat.length > 100) room.wolfChat.shift();
      return broadcast(room);
    }
    const ok = room.phase === 'lobby' || room.phase === 'over' || (room.phase === 'day' && me.alive);
    if (!ok) return;
    room.chat.push({ name: me.name, text });
    if (room.chat.length > 100) room.chat.shift();
    broadcast(room);
  });

  socket.on('restart', () => {
    const [room, me] = ctx();
    if (!me || room.phase !== 'over') return;
    const host = byId(room, room.hostId);
    if (room.hostId !== me.id && host && host.sock) return;
    room.players = room.players.filter(p => p.sock);
    room.hostId = me.id;
    room.players.forEach(p => { p.role = null; p.alive = true; p.seen = []; });
    Object.assign(room, { phase: 'lobby', round: 0, log: [], chat: [], wolfChat: [], winner: null, hunterId: null, votes: {} });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const [room, me] = ctx();
    if (!me || me.sock !== socket.id) return;
    me.sock = null;
    if (room.phase === 'lobby') {
      const c = room.code, id = pid;
      setTimeout(() => {
        const r = rooms[c], p = r && byId(r, id);
        if (p && !p.sock && r.phase === 'lobby') removePlayer(r, id);
      }, 15000);
    }
    broadcast(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const c in rooms) if (!rooms[c].players.some(p => p.sock) && now - rooms[c].touched > 3600000) delete rooms[c];
}, 600000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Werewolves running on port ' + PORT));
