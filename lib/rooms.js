'use strict';
// Rooms, lobby, matchmaking and the authoritative match loop. Transport-agnostic: needs only a Socket.IO-style `io`.
const crypto = require('crypto');
const { createEngine } = require('./engine-host');
const { sha } = require('./store');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 4;

function attach(io, { store, htmlPath, opts = {} }) {
  const cfg = {
    minPlayers: Number(opts.minPlayers ?? 2), graceLobbyMs: Number(opts.graceLobbyMs ?? 20000),
    gracePlayMs: Number(opts.gracePlayMs ?? 120000), maxRooms: Number(opts.maxRooms ?? 40), turnMs: Number(opts.turnMs ?? 100), cmdRate: Number(opts.cmdRate ?? 25), emptyRoomMs: Number(opts.emptyRoomMs ?? 60000)
  };
  // learn what the game contains (troop ids, realms) from a throwaway headless engine
  const probe = createEngine(htmlPath);
  const KNOWN_TROOPS = new Set(probe.__SC.TOWER_TYPES.map(t => t.id));
  const KNOWN_MAPS = new Set(probe.__SC.MAPS.map(m => m.id));
  const MODES = new Set(['classic', 'endless', 'hardcore']), DIFFS = new Set(Object.keys(probe.__SC.DIFFS));

  const rooms = new Map(), byPid = new Map(), sockets = new Map(), stats = { matches: 0 };

  const cleanName = n => { n = String(n || '').replace(/[^\p{L}\p{N} _\-]/gu, '').trim().slice(0, 16); return n.length >= 2 ? n : 'Player' + (1000 + Math.floor(Math.random() * 9000)); };
  const cleanSquad = s => [...new Set((Array.isArray(s) ? s : []).filter(x => typeof x === 'string' && KNOWN_TROOPS.has(x)))].slice(0, 10);
  const cleanAvatar = (a, squad) => (typeof a === 'string' && KNOWN_TROOPS.has(a)) ? a : (squad[0] || [...KNOWN_TROOPS][0]);
  const newCode = () => { for (;;) { let c = ''; for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; if (!rooms.has(c)) return c; } };

  async function identify(auth) {
    auth = auth || {};
    let prof = typeof auth.pid === 'string' ? await store.getProfile(auth.pid) : null, token = null;
    if (prof && sha(auth.token) !== prof.tokenHash) prof = null;               // wrong secret: treat as a brand-new guest
    const squad = cleanSquad(auth.squad);
    if (!prof) {
      token = crypto.randomBytes(24).toString('hex');
      prof = { pid: crypto.randomUUID(), tokenHash: sha(token), name: cleanName(auth.name), avatar: cleanAvatar(auth.avatar, squad), squad };
    } else {
      prof.name = cleanName(auth.name || prof.name); prof.squad = squad.length ? squad : cleanSquad(prof.squad); prof.avatar = cleanAvatar(auth.avatar || prof.avatar, prof.squad);
    }
    await store.saveProfile(prof);
    return { prof, token };
  }

  class Room {
    constructor(code, isPublic) {
      this.code = code; this.isPublic = !!isPublic; this.state = 'lobby'; this.hostPid = null; this.players = [];
      this.cfg = { map: 'kingdom', mode: 'classic', diff: 'normal' }; this.created = Date.now();
      this.engine = null; this.timer = null; this.pending = []; this.log = null; this.startCfg = null; this.emptyTimer = null;
    }
    find(pid) { return this.players.find(p => p.pid === pid); }
    view() {
      return {
        code: this.code, isPublic: this.isPublic, state: this.state, hostPid: this.hostPid, max: MAX_PLAYERS, minPlayers: cfg.minPlayers, cfg: this.cfg,
        players: this.players.map(p => ({ pid: p.pid, name: p.name, avatar: p.avatar, squad: p.squad, ready: p.pid === this.hostPid ? true : p.ready, connected: p.connected, left: !!p.left, slot: p.slot }))
      };
    }
    broadcast() { io.to(this.code).emit('room:state', this.view()); }
    emitTo(pid, ev, data) { const s = sockets.get(pid); if (s) s.emit(ev, data); }
    liveCount() { return this.players.filter(p => !p.left && p.connected).length; }
    activeCount() { return this.players.filter(p => !p.left).length; }
    migrateHost() {
      const next = this.players.find(p => !p.left && p.connected) || this.players.find(p => !p.left);
      this.hostPid = next ? next.pid : null;
      if (this.engine && next) this.startCfg.hostSlot = next.slot;
    }
    logPayload(p) { return { cfg: { ...this.startCfg, me: p.slot }, total: this.log.total, cmds: this.log.cmds, ended: this.state === 'ended' }; }

    // ---- players ----
    add(prof, socket) {
      const p = { pid: prof.pid, name: prof.name, avatar: prof.avatar, squad: prof.squad, ready: false, connected: true, left: false, slot: -1, grace: null, lastSeq: 0, tokens: cfg.cmdRate, tAt: Date.now() };
      this.players.push(p); if (!this.hostPid) this.hostPid = p.pid;
      socket.join(this.code); byPid.set(p.pid, this.code); return p;
    }
    removeFromLobby(pid) {
      const p = this.find(pid); if (!p) return;
      clearTimeout(p.grace); this.players = this.players.filter(x => x !== p); byPid.delete(pid);
      const s = sockets.get(pid); if (s) s.leave(this.code);
      if (this.hostPid === pid) this.migrateHost();
      if (!this.players.length) return destroy(this);
      this.broadcast();
    }
    leave(pid) {
      const p = this.find(pid); if (!p) return;
      if (this.state === 'lobby') return this.removeFromLobby(pid);
      clearTimeout(p.grace); p.left = true; p.connected = false; byPid.delete(pid);
      const s = sockets.get(pid); if (s) s.leave(this.code);
      if (this.hostPid === pid) this.migrateHost();
      if (!this.activeCount()) return destroy(this);
      this.broadcast();
    }
    drop(pid) {                                                    // socket lost: keep the seat for a grace period
      const p = this.find(pid); if (!p || p.left) return;
      p.connected = false; p.ready = this.state === 'lobby' ? false : p.ready;
      if (this.hostPid === pid && this.state === 'lobby') this.migrateHost();
      this.broadcast();
      clearTimeout(p.grace);
      p.grace = setTimeout(() => this.leave(pid), this.state === 'lobby' ? cfg.graceLobbyMs : cfg.gracePlayMs);
      if (!this.liveCount() && this.state !== 'lobby') { clearTimeout(this.emptyTimer); this.emptyTimer = setTimeout(() => { if (!this.liveCount()) destroy(this); }, cfg.emptyRoomMs); }
    }
    reconnect(pid, socket) {
      const p = this.find(pid); if (!p || p.left) return false;
      clearTimeout(p.grace); clearTimeout(this.emptyTimer); p.connected = true; p.lastSeq = 0; socket.join(this.code);
      if (!this.players.find(x => x.pid === this.hostPid && x.connected)) this.migrateHost();
      this.broadcast();
      if (this.state !== 'lobby' && this.log) socket.emit('game:log', this.logPayload(p));
      return true;
    }

    // ---- match ----
    canStart(pid) {
      if (pid !== this.hostPid) return 'Only the host can start the match.';
      if (this.state !== 'lobby') return 'The match has already started.';
      const live = this.players.filter(p => !p.left);
      if (live.length < cfg.minPlayers) return `At least ${cfg.minPlayers} players are needed.`;
      if (live.some(p => !p.connected)) return 'A player is disconnected.';
      if (live.some(p => p.pid !== this.hostPid && !p.ready)) return 'Everyone must be ready.';
      if (!KNOWN_MAPS.has(this.cfg.map)) return 'Unknown realm.';
      return null;
    }
    start() {
      const live = this.players.filter(p => !p.left);
      live.forEach((p, i) => { p.slot = i; });
      this.players = live; this.state = 'playing';
      const host = this.find(this.hostPid);
      this.startCfg = {
        seed: crypto.randomInt(1, 2 ** 31), map: this.cfg.map, mode: this.cfg.mode, diff: this.cfg.diff, hostSlot: host.slot,
        players: live.map(p => ({ slot: p.slot, pid: p.pid, name: p.name, avatar: p.avatar, squad: p.squad }))
      };
      this.engine = createEngine(htmlPath);
      this.engine.__MPCORE.begin({ ...this.startCfg, me: -1 });
      this.log = { total: 0, cmds: {} }; this.pending = []; this.began = Date.now(); stats.matches++;
      for (const p of live) this.emitTo(p.pid, 'game:start', { cfg: { ...this.startCfg, me: p.slot } });
      this.broadcast();
      this.timer = setInterval(() => this.turn(), cfg.turnMs);
    }
    submit(pid, seq, raw) {
      const p = this.find(pid); if (!p || p.left || this.state !== 'playing' || !raw || typeof raw !== 'object') return;
      const now = Date.now(); p.tokens = Math.min(cfg.cmdRate * 1.5, p.tokens + (now - p.tAt) / 1000 * cfg.cmdRate); p.tAt = now;
      if (p.tokens < 1) return this.emitTo(pid, 'game:reject', { seq, why: 'rate' });
      p.tokens -= 1;
      if (!Number.isInteger(seq) || seq <= p.lastSeq) return;      // duplicate / replayed command
      p.lastSeq = seq;
      const t = raw.t, c = { p: p.slot, seq, t };
      if (!['place', 'upgrade', 'sell', 'target', 'ult', 'wave'].includes(t)) return this.emitTo(pid, 'game:reject', { seq, why: 'command' });
      if (t === 'wave' && pid !== this.hostPid) return this.emitTo(pid, 'game:reject', { seq, why: 'host' });
      if (t === 'place') { if (typeof raw.type !== 'string' || raw.type.length > 40) return; c.type = raw.type; c.x = +raw.x; c.y = +raw.y; }
      if (t === 'upgrade' || t === 'sell' || t === 'target' || t === 'ult') { c.tid = raw.tid | 0; }
      if (t === 'target') c.mode = String(raw.mode).slice(0, 10);
      if (t === 'ult' && raw.x !== undefined) { c.x = +raw.x; c.y = +raw.y; }
      if (this.pending.length < 300) this.pending.push(c);
    }
    turn() {
      let r;
      try { r = this.engine.__MPCORE.serverTurn(this.pending.splice(0)); }
      catch (e) { console.error('[room ' + this.code + '] engine error', e); return this.finish({ over: true, wave: 0, lives: 0, error: true }); }
      this.log.total = r.n + 1; if (r.cmds.length) this.log.cmds[r.n] = r.cmds;
      io.to(this.code).emit('game:turn', { n: r.n, cmds: r.cmds, h: r.h });
      for (const rj of r.rejected) { const p = this.players.find(x => x.slot === rj.p); if (p) this.emitTo(p.pid, 'game:reject', { seq: rj.seq, why: rj.why }); }
      if (r.over) this.finish(r);
    }
    finish(r) {
      clearInterval(this.timer); this.timer = null; this.state = 'ended';
      io.to(this.code).emit('game:end', { victory: r.lives > 0 && !r.error, wave: r.wave, turns: this.log ? this.log.total : 0 });
      Promise.resolve(store.recordMatch({ code: this.code, map: this.cfg.map, mode: this.cfg.mode, diff: this.cfg.diff, victory: r.lives > 0, wave: r.wave,
        players: this.players.map(p => ({ pid: p.pid, name: p.name })), durationS: Math.round((Date.now() - this.began) / 1000) })).catch(e => console.error('recordMatch failed', e.message));
      this.engine = null; this.broadcast();
    }
    rematch() { this.state = 'lobby'; this.log = null; this.startCfg = null; this.players = this.players.filter(p => !p.left); this.players.forEach(p => { p.ready = false; p.slot = -1; }); this.broadcast(); }
  }

  function destroy(room) {
    clearInterval(room.timer); clearTimeout(room.emptyTimer); room.players.forEach(p => { clearTimeout(p.grace); byPid.delete(p.pid); });
    rooms.delete(room.code);
  }

  function leaveCurrent(pid) { const code = byPid.get(pid); if (!code) return; const r = rooms.get(code); if (r) r.leave(pid); else byPid.delete(pid); }
  function reply(ack, obj) { if (typeof ack === 'function') ack(obj); }
  const roomOf = pid => rooms.get(byPid.get(pid));

  io.on('connection', async socket => {
    let ident;
    try { ident = await identify(socket.handshake.auth); } catch (e) { console.error('auth failed', e.message); socket.emit('fatal', { error: 'Could not start your session.' }); socket.disconnect(true); return; }
    const { prof, token } = ident, pid = prof.pid;
    const old = sockets.get(pid); sockets.set(pid, socket); socket.data.pid = pid;
    if (old && old !== socket) { old.emit('fatal', { error: 'Signed in from another tab.' }); old.data.replaced = true; old.disconnect(true); }
    const room = roomOf(pid);
    socket.emit('welcome', { pid, token, name: prof.name, avatar: prof.avatar, squad: prof.squad, inRoom: !!room });
    if (room) { const p = room.find(pid); if (p) { p.name = prof.name; p.avatar = prof.avatar; if (room.state === 'lobby') p.squad = prof.squad; } room.reconnect(pid, socket); }

    const on = (ev, fn) => socket.on(ev, async (payload, ack) => {
      try { await fn(payload || {}, ack); } catch (e) { console.error('[' + ev + ']', e); reply(ack, { ok: false, error: 'Server error.' }); }
    });

    on('profile', async (d, ack) => {
      prof.name = cleanName(d.name || prof.name); prof.squad = cleanSquad(d.squad).length ? cleanSquad(d.squad) : prof.squad; prof.avatar = cleanAvatar(d.avatar, prof.squad);
      await store.saveProfile(prof);
      const r = roomOf(pid); const p = r && r.find(pid);
      if (p && r.state === 'lobby') { p.name = prof.name; p.avatar = prof.avatar; p.squad = prof.squad; p.ready = false; r.broadcast(); }
      reply(ack, { ok: true });
    });

    const join = (r, ack) => {
      if (r.state !== 'lobby') return reply(ack, { ok: false, error: 'That match has already started.' });
      if (r.players.length >= MAX_PLAYERS) return reply(ack, { ok: false, error: 'That room is full.' });
      leaveCurrent(pid); r.add(prof, socket); r.broadcast(); reply(ack, { ok: true, code: r.code });
    };
    const create = isPublic => {
      if (rooms.size >= cfg.maxRooms) return null;
      leaveCurrent(pid); const r = new Room(newCode(), isPublic); rooms.set(r.code, r); r.add(prof, socket); return r;
    };

    on('room:create', (d, ack) => {
      const r = create(!!d.isPublic); if (!r) return reply(ack, { ok: false, error: 'The server is busy. Try again soon.' });
      r.broadcast(); reply(ack, { ok: true, code: r.code });
    });
    on('room:join', (d, ack) => {
      const code = String(d.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const r = rooms.get(code); if (!r) return reply(ack, { ok: false, error: 'No room with that code.' });
      if (r.find(pid)) { r.reconnect(pid, socket); return reply(ack, { ok: true, code }); }
      join(r, ack);
    });
    on('room:quick', (d, ack) => {
      const cur = roomOf(pid); if (cur && cur.state === 'lobby' && cur.isPublic) return reply(ack, { ok: true, code: cur.code });
      let best = null;
      for (const r of rooms.values()) if (r.isPublic && r.state === 'lobby' && r.players.length < MAX_PLAYERS && !r.find(pid) && (!best || r.players.length > best.players.length)) best = r;
      if (best) return join(best, ack);
      const r = create(true); if (!r) return reply(ack, { ok: false, error: 'The server is busy. Try again soon.' });
      r.broadcast(); reply(ack, { ok: true, code: r.code });
    });
    on('room:leave', (d, ack) => { leaveCurrent(pid); reply(ack, { ok: true }); });
    on('room:ready', (d, ack) => {
      const r = roomOf(pid), p = r && r.find(pid); if (!p || r.state !== 'lobby') return reply(ack, { ok: false });
      p.ready = !!d.ready; r.broadcast(); reply(ack, { ok: true });
    });
    on('room:config', (d, ack) => {
      const r = roomOf(pid); if (!r || r.hostPid !== pid || r.state !== 'lobby') return reply(ack, { ok: false, error: 'Only the host can change settings.' });
      if (d.map !== undefined) { if (!KNOWN_MAPS.has(d.map)) return reply(ack, { ok: false, error: 'Unknown realm.' }); r.cfg.map = d.map; }
      if (d.mode !== undefined && MODES.has(d.mode)) r.cfg.mode = d.mode;
      if (d.diff !== undefined && DIFFS.has(d.diff)) r.cfg.diff = d.diff;
      if (d.isPublic !== undefined) r.isPublic = !!d.isPublic;
      r.players.forEach(p => { if (p.pid !== pid) p.ready = false; });          // settings changed: everyone re-confirms
      r.broadcast(); reply(ack, { ok: true });
    });
    on('room:kick', (d, ack) => {
      const r = roomOf(pid); if (!r || r.hostPid !== pid || r.state !== 'lobby') return reply(ack, { ok: false, error: 'Only the host can remove players.' });
      if (d.pid === pid || !r.find(d.pid)) return reply(ack, { ok: false });
      const ks = sockets.get(d.pid); r.removeFromLobby(d.pid); if (ks) ks.emit('room:kicked', { reason: 'The host removed you from the room.' });
      reply(ack, { ok: true });
    });
    on('room:start', (d, ack) => {
      const r = roomOf(pid); if (!r) return reply(ack, { ok: false, error: 'You are not in a room.' });
      const err = r.canStart(pid); if (err) return reply(ack, { ok: false, error: err });
      r.start(); reply(ack, { ok: true });
    });
    on('room:rematch', (d, ack) => {
      const r = roomOf(pid); if (!r || r.hostPid !== pid || r.state !== 'ended') return reply(ack, { ok: false });
      r.rematch(); reply(ack, { ok: true });
    });
    socket.on('game:cmd', d => { const r = roomOf(pid); if (r && d) r.submit(pid, d.seq, d.c); });
    on('game:sync', (d, ack) => {
      const r = roomOf(pid), p = r && r.find(pid); if (!p || !r.log) return reply(ack, { ok: false });
      socket.emit('game:log', r.logPayload(p)); reply(ack, { ok: true });
    });

    // friends: structure ready for invitations (requests are stored; inviting to rooms is not implemented yet)
    on('friends:list', async (d, ack) => reply(ack, { ok: true, ...(await store.listFriends(pid)) }));
    on('friends:request', async (d, ack) => {
      const key = String(d.who || '').trim(); if (!key) return reply(ack, { ok: false, error: 'Enter a player ID or name.' });
      const target = (await store.getProfile(key)) || (await store.findByName(key));
      if (!target) return reply(ack, { ok: false, error: 'Player not found.' });
      reply(ack, await store.requestFriend(pid, target.pid));
    });
    on('friends:accept', async (d, ack) => reply(ack, await store.acceptFriend(pid, String(d.pid || ''))));

    socket.on('disconnect', () => {
      if (sockets.get(pid) !== socket) return;
      sockets.delete(pid);
      const r = roomOf(pid); if (r) r.drop(pid);
    });
  });

  return { rooms, byPid, sockets, config: cfg, stats, shutdown() { for (const r of rooms.values()) destroy(r); } };
}

module.exports = { attach, MAX_PLAYERS };
