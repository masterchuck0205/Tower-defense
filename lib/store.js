'use strict';
// Persistence layer. PostgreSQL when DATABASE_URL is set, otherwise an in-memory store (data is lost on restart).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');

class MemoryStore {
  constructor() { this.kind = 'memory'; this.profiles = new Map(); this.friends = new Map(); this.matches = []; }
  async init() {}
  async getProfile(pid) { const p = this.profiles.get(pid); return p ? { ...p } : null; }
  async saveProfile(p) { this.profiles.set(p.pid, { ...p }); }
  async findByName(name) { for (const p of this.profiles.values()) if (p.name.toLowerCase() === String(name).toLowerCase()) return { ...p }; return null; }
  async recordMatch(m) { this.matches.push(m); if (this.matches.length > 500) this.matches.shift(); }
  // friends: structure for future invitations (requests are stored; room invitations are not implemented yet)
  async requestFriend(from, to) {
    if (from === to) return { ok: false, error: 'You cannot add yourself.' };
    const k = [from, to].sort().join('|'), cur = this.friends.get(k);
    if (cur) return { ok: false, error: cur.status === 'accepted' ? 'Already friends.' : 'Request already pending.' };
    this.friends.set(k, { a: from, b: to, status: 'pending', requester: from }); return { ok: true };
  }
  async acceptFriend(pid, other) {
    const k = [pid, other].sort().join('|'), cur = this.friends.get(k);
    if (!cur || cur.status !== 'pending' || cur.requester === pid) return { ok: false, error: 'No such request.' };
    cur.status = 'accepted'; return { ok: true };
  }
  async listFriends(pid) {
    const friends = [], requests = [];
    for (const f of this.friends.values()) {
      if (f.a !== pid && f.b !== pid) continue;
      const other = f.a === pid ? f.b : f.a, op = this.profiles.get(other);
      const row = { pid: other, name: op ? op.name : 'Unknown', avatar: op ? op.avatar : null };
      if (f.status === 'accepted') friends.push(row); else if (f.requester !== pid) requests.push(row);
    }
    return { friends, requests };
  }
}

class PgStore {
  constructor(url, ssl) {
    const { Pool } = require('pg');                       // only required when a database is configured
    this.kind = 'postgres';
    this.pool = new Pool({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : undefined, max: 8 });
  }
  async init() { await this.pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8')); }
  async getProfile(pid) {
    const r = await this.pool.query('SELECT pid, token_hash AS "tokenHash", name, avatar, squad FROM players WHERE pid = $1', [pid]);
    return r.rows[0] || null;
  }
  async saveProfile(p) {
    await this.pool.query(
      `INSERT INTO players (pid, token_hash, name, avatar, squad) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (pid) DO UPDATE SET name = EXCLUDED.name, avatar = EXCLUDED.avatar, squad = EXCLUDED.squad, last_seen = now()`,
      [p.pid, p.tokenHash, p.name, p.avatar, JSON.stringify(p.squad || [])]);
  }
  async findByName(name) {
    const r = await this.pool.query('SELECT pid, name, avatar FROM players WHERE lower(name) = lower($1) LIMIT 1', [name]);
    return r.rows[0] || null;
  }
  async recordMatch(m) {
    await this.pool.query('INSERT INTO matches (room_code, map_id, mode, difficulty, victory, wave, players, duration_s) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [m.code, m.map, m.mode, m.diff, m.victory, m.wave, JSON.stringify(m.players), m.durationS]);
  }
  async requestFriend(from, to) {
    if (from === to) return { ok: false, error: 'You cannot add yourself.' };
    const ex = await this.pool.query('SELECT status FROM friendships WHERE (player_a=$1 AND player_b=$2) OR (player_a=$2 AND player_b=$1)', [from, to]);
    if (ex.rows[0]) return { ok: false, error: ex.rows[0].status === 'accepted' ? 'Already friends.' : 'Request already pending.' };
    await this.pool.query('INSERT INTO friendships (player_a, player_b, requester, status) VALUES ($1,$2,$1,$3)', [from, to, 'pending']);
    return { ok: true };
  }
  async acceptFriend(pid, other) {
    const r = await this.pool.query(`UPDATE friendships SET status='accepted' WHERE status='pending' AND requester=$2 AND ((player_a=$1 AND player_b=$2) OR (player_a=$2 AND player_b=$1))`, [pid, other]);
    return r.rowCount ? { ok: true } : { ok: false, error: 'No such request.' };
  }
  async listFriends(pid) {
    const r = await this.pool.query(
      `SELECT f.status, f.requester, p.pid, p.name, p.avatar FROM friendships f
       JOIN players p ON p.pid = CASE WHEN f.player_a = $1 THEN f.player_b ELSE f.player_a END
       WHERE f.player_a = $1 OR f.player_b = $1`, [pid]);
    const friends = [], requests = [];
    for (const x of r.rows) { const row = { pid: x.pid, name: x.name, avatar: x.avatar }; if (x.status === 'accepted') friends.push(row); else if (x.requester !== pid) requests.push(row); }
    return { friends, requests };
  }
}

function createStore(env) {
  if (env.DATABASE_URL) return new PgStore(env.DATABASE_URL, env.DATABASE_SSL !== 'false');
  return new MemoryStore();
}
module.exports = { createStore, MemoryStore, PgStore, sha };
