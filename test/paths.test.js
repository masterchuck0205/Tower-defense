// Upgrade paths: every troop has two paths, the first upgrade picks one and locks the other, perks work, and server/client stay in sync.
const { createEngine } = require('../lib/engine-host');
const H = require('path').join(__dirname, '..', 'public', 'index.html');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const srv = createEngine(H), cli = createEngine(H), SC = srv.__SC;
const defs = SC.TOWER_TYPES;
// ---- data ----
let bad = [];
for (const d of defs) { const P = SC.pathsFor(d); if (P.length !== 2 || P.some(p => !p.title || p.steps.length !== 3 || p.steps.some(s => !s.n || !SC.stepDesc(s))) || P[0].title === P[1].title) bad.push(d.id); }
ok(bad.length === 0, 'every one of the ' + defs.length + ' troops has two distinct, fully described 3-step paths' + (bad.length ? ' (bad: ' + bad.join(',') + ')' : ''));
ok(new Set(defs.map(d => SC.pathsFor(d).map(p => p.title).join('/'))).size === defs.length, 'every troop\u2019s pair of paths is unique to that troop');
// ---- engine ----
const cfg = { seed: 21, map: SC.MAPS[0].id, mode: 'classic', diff: 'easy', hostSlot: 0, players: [0, 1].map(i => ({ slot: i, pid: 'p' + i, name: 'P' + i, avatar: 'archer', squad: defs.map(d => d.id) })) };
srv.__MPCORE.begin({ ...cfg, me: -1 }); cli.__MPCORE.begin({ ...cfg, me: 1 });
const S = srv.__MPCORE, C = cli.__MPCORE; let desync = false; C.onDesync = () => { desync = true; };
for (const e of [srv, cli]) { e.__SC.game.pg[0] = 9e7; e.__SC.game.pg[1] = 9e7; e.__SC.game.lives = 999; }
let seq = 0, lastRej = [];
const turn = (cmds = []) => { const r = S.serverTurn(cmds); lastRej = r.rejected || []; C.addTurn(r.n, r.cmds, r.h); let k = 0; while (C.tick < C.known * 6 && k++ < 1000) if (!C.advance()) break; return r; };
const g = srv.__SC.game;
const spots = []; for (let y = 90; y <= 640; y += 46) for (let x = 90; x <= 1150; x += 70) spots.push([x, y]);
let si = 0;
const place = id => { for (let tries = 0; tries < spots.length; tries++) { const [x, y] = spots[si++ % spots.length]; const n = g.towers.length; turn([{ p: 0, seq: ++seq, t: 'place', type: id, x, y }]); if (g.towers.length > n) return g.towers[g.towers.length - 1]; } return null; };
const up = (t, path) => turn([{ p: 0, seq: ++seq, t: 'upgrade', tid: t.tid, path }]);
const fieldOf = { crit: 'pCrit', exec: 'pExec', boss: 'pBoss', gold: 'pGold', stun: 'pStun', multi: 'pMulti', spec: 'pSpec', ult: 'pUlt' };
// ---- locking ----
{
  const t = place('archer'); const P = SC.pathsFor(defs.find(d => d.id === 'archer'));
  up(t, 7); ok(t.tier === 1 && lastRej.length > 0, 'an invalid path is rejected at the first upgrade');
  up(t, 1); ok(t.tier === 2 && t.path === 1, 'the first upgrade picks the chosen path (Path B)');
  up(t, 0); ok(t.tier === 3 && t.path === 1, 'asking for the other path later is ignored: the path stays locked');
  up(t, 0); ok(t.tier === 4 && t.path === 1, 'the troop reaches level 4 on its own path');
  up(t, 1); ok(t.tier === 4, 'there is no level 5');
  const wantCrit = P[1].steps.reduce((a, s) => a + (s.p.crit || 0), 0), wantMulti = P[1].steps.reduce((a, s) => a + (s.p.multi || 0), 0);
  ok(Math.abs((t.pCrit || 0) - wantCrit) < 1e-9 && (t.pMulti || 0) === wantMulti, 'only the chosen path\u2019s perks were applied (crit ' + (t.pCrit || 0).toFixed(2) + ', extra shots ' + (t.pMulti || 0) + ')');
}
// ---- every troop, both paths ----
let allOk = true, why = '';
for (const d of defs) for (const pi of [0, 1]) {
  const t = place(d.id); if (!t) { allOk = false; why = 'cannot place ' + d.id; break; }
  const base = { dmg: t.damage, range: t.range }, P = SC.pathsFor(d)[pi], O = SC.pathsFor(d)[1 - pi];
  up(t, pi); up(t, 1 - pi); up(t, 1 - pi);
  const bad2 = [];
  if (t.tier !== 4 || t.path !== pi) bad2.push('tier/path');
  if (!Number.isFinite(t.damage) || !Number.isFinite(t.range) || !Number.isFinite(t.fireRate)) bad2.push('non-finite stats');
  if (!(t.range > base.range)) bad2.push('range did not grow');
  if (base.dmg > 0 && !(t.damage > base.dmg * 1.5)) bad2.push('damage did not grow');
  for (const k in fieldOf) { const want = P.steps.reduce((a, s) => a + (s.p[k] || 0), 0); if (Math.abs((t[fieldOf[k]] || 0) - want) > 1e-9) bad2.push(k + ' ' + (t[fieldOf[k]] || 0) + '!=' + want); }
  if (bad2.length) { allOk = false; why = d.id + ' path ' + pi + ': ' + bad2.join('; '); break; }
  turn([{ p: 0, seq: ++seq, t: 'sell', tid: t.tid }]);
}
ok(allOk, 'every troop upgrades to level 4 down either path with only that path\u2019s perks' + (why ? ' (' + why + ')' : ''));
// ---- perks in combat (on a separate engine, so the direct calls cannot disturb the server/client sync below) ----
{
  const ue = createEngine(H); ue.__MPCORE.begin({ ...cfg, me: -1 }); const ug = ue.__SC.game, dm = ue.__SC.damageEnemy; ug.pg[0] = 9e7; ug.pg[1] = 9e7;
  const mk = (hp, maxHp, boss) => ({ hp, maxHp, armor: 0, x: 0, y: 0, color: '#fff', reward: 5, isBoss: !!boss, petrifyTimer: 0, smokedTimer: 0, markTimer: 0, stunTimer: 0, path: [], dead: false });
  ue.__MPCORE.serverTurn([{ p: 0, seq: 1, t: 'place', type: 'archer', x: 90, y: 90 }, { p: 0, seq: 2, t: 'place', type: 'archer', x: 160, y: 90 }]);
  const tw = ug.towers[0];
  let a = mk(250, 1000), b = mk(250, 1000); dm(a, 10, true, tw); tw.pExec = 1; dm(b, 10, true, tw); tw.pExec = 0;
  ok((250 - b.hp) > (250 - a.hp) * 1.9, 'Executioner perk: bonus damage to enemies under 30% HP (' + (250 - a.hp).toFixed(1) + ' -> ' + (250 - b.hp).toFixed(1) + ')');
  a = mk(900, 1000, true); b = mk(900, 1000, true); dm(a, 10, true, tw); tw.pBoss = 0.5; dm(b, 10, true, tw); tw.pBoss = 0;
  ok((900 - b.hp) > (900 - a.hp) * 1.4, 'Boss-hunter perk: bonus damage to bosses');
  a = mk(900, 1000); tw.pStun = 1; tw.pStunD = 0.5; dm(a, 10, true, tw); tw.pStun = 0; tw.pStunD = 0;
  ok(a.stunTimer > 0.9, 'Stun perk: hits can stun (' + a.stunTimer.toFixed(2) + 's)');
  const tot = () => ug.pg[0] + ug.pg[1], t0 = tot(); dm(mk(1, 1000), 99, true, tw); const d0 = tot() - t0; tw.pGold = 5; const t1 = tot(); dm(mk(1, 1000), 99, true, tw); const d1 = tot() - t1; tw.pGold = 0;
  ok(d1 - d0 === 5, 'Gold perk: +5g on a kill (' + d0 + ' -> ' + d1 + ')');
}
// ---- the upgrade panel renders at every level without errors ----
{
  let err = null; const tw = place('warDrummer');
  try { for (let lv = 1; lv <= 4; lv++) { g.inspectedTower = tw; SC.refreshInspector(); if (lv < 4) up(tw, 1); } g.inspectedTower = null; } catch (e) { err = e; }
  ok(!err && tw.tier === 4, 'the path-choice / upgrade panel renders at levels 1 to 4' + (err ? ' (' + err.message + ')' : ''));
  turn([{ p: 0, seq: ++seq, t: 'sell', tid: tw.tid }]);
}
// ---- full match with a squad of upgraded troops down mixed paths: server and client stay in sync ----
const squad = ['archer', 'tesla', 'cannon', 'frost', 'banner', 'chuck', 'kitsune', 'warDrummer', 'fenrir', 'prismWarden'], mine = [];
squad.forEach((id, i) => { const t = place(id); if (t) { mine.push(t); up(t, i % 2); up(t, i % 2); up(t, i % 2); } });
ok(mine.length === squad.length && mine.every(t => t.tier === 4), 'a mixed squad of ' + mine.length + ' was built and fully upgraded');
for (let w = 0; w < 3 && !g.over; w++) { if (!g.waveActive) turn([{ p: 0, seq: ++seq, t: 'wave' }]); for (let i = 0; i < 900 && g.waveActive && !g.over; i++) turn(); }
ok(g.towers.reduce((a, t) => a + (t.kills || 0), 0) > 0, 'the upgraded squad fought and killed enemies');
ok(!desync, 'server and client stay in sync (' + C.verified + ' hashes verified)');
console.log(fails ? 'FAILS ' + fails : 'ALL OK'); process.exit(fails ? 1 : 0);
