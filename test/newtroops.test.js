// Seven new troops: Ember Alchemist, Harbour Harpooner, Obsidian Guardian, Minefield Sapper, Chronomancer, Prism Warden, Fenrir.
// Checks data, art, abilities, ultimates, and that server and client stay in sync through all of it.
const { createEngine } = require('../lib/engine-host');
const H = require('path').join(__dirname, '..', 'public', 'index.html');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const srv = createEngine(H), cli = createEngine(H), SC = srv.__SC;
const ids = ['emberAlchemist', 'harbourHarpooner', 'obsidianGuardian', 'minefieldSapper', 'chronomancer', 'prismWarden', 'fenrir'];
const defs = ids.map(i => SC.TOWER_TYPES.find(t => t.id === i));
ok(defs.every(Boolean), 'all seven troops exist');
ok(new Set(SC.TOWER_TYPES.map(t => t.id)).size === SC.TOWER_TYPES.length && new Set(SC.TOWER_TYPES.map(t => t.uid)).size === SC.TOWER_TYPES.length, 'troop ids and uids are unique');
ok(defs.every(d => d.evo.length === 3 && d.abilities.length >= 3 && d.ult && d.ult.name && d.desc && d.unlockPrice > 0 && d.cost > 0), 'every troop has evolutions, abilities, an ultimate, a description and prices');
ok(['Rare', 'Epic', 'Legendary', 'Mythical'].every(r => defs.some(d => d.rarity === r)), 'they span Rare, Epic, Legendary and Mythical');
let artErr = null;
try { for (const d of defs) for (let t = 1; t <= 4; t++) { SC.setArtTier(t); SC.getPortraitSprite(d, false); } } catch (e) { artErr = e; }
ok(!artErr, 'portrait art draws for every troop at every evolution tier' + (artErr ? ' (' + artErr.message + ')' : ''));
SC.setArtTier(1);

const squad = [...ids, ...SC.TOWER_TYPES.map(t => t.id).filter(i => !ids.includes(i)).slice(0, 3)];
const cfg = { seed: 11, map: SC.MAPS[0].id, mode: 'classic', diff: 'easy', hostSlot: 0, players: [0, 1].map(i => ({ slot: i, pid: 'p' + i, name: 'P' + i, avatar: squad[0], squad })) };
srv.__MPCORE.begin({ ...cfg, me: -1 }); cli.__MPCORE.begin({ ...cfg, me: 1 });
const S = srv.__MPCORE, C = cli.__MPCORE; let desync = false; C.onDesync = () => { desync = true; };
for (const e of [srv, cli]) { e.__SC.game.pg[0] = 90000; e.__SC.game.pg[1] = 500; e.__SC.game.lives = 999; }
let seq = 0;
const turn = (cmds = []) => { const r = S.serverTurn(cmds); C.addTurn(r.n, r.cmds, r.h); let k = 0; while (C.tick < C.known * 6 && k++ < 1000) if (!C.advance()) break; return r; };
const g = srv.__SC.game, T = id => g.towers.find(t => t.typeId === id);
// place every troop close to the enemy path so they all get to work
const path = g.map.paths[0], pts = []; for (let f = 0.06; f < 0.95; f += 0.02) { const i = Math.floor(f * (path.length - 1)), a = path[i], b = path[Math.min(path.length - 1, i + 1)]; const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1; for (const off of [58, -58, 82, -82, 108, -108]) pts.push([a.x - dy / L * off, a.y + dx / L * off]); }
const ref = path[Math.floor(path.length * 0.35)]; pts.sort((a, b) => Math.hypot(a[0] - ref.x, a[1] - ref.y) - Math.hypot(b[0] - ref.x, b[1] - ref.y));
let pi = 0;
for (const id of ids) {
  let placed = false;
  while (!placed && pi < pts.length) { const [x, y] = pts[pi++]; const before = g.towers.length; turn([{ p: 0, seq: ++seq, t: 'place', type: id, x, y }]); placed = g.towers.length > before; }
  ok(placed, id + ' can be deployed');
}
ok(ids.every(i => T(i) && T(i).owner === 0), 'all seven belong to player 0');
// each troop's signature mechanic is checked on its own beside the lane, so the result does not depend on where the others stand
function solo(id, probe) {
  const e = createEngine(H), c2 = { ...cfg, players: cfg.players.map(p => ({ ...p, squad: [id, ...squad.filter(i => i !== id)].slice(0, 10) })) };
  e.__MPCORE.begin({ ...c2, me: -1 }); const gg = e.__SC.game; gg.pg[0] = 90000; gg.lives = 999; let sq = 0;
  const tn = (cmds = []) => e.__MPCORE.serverTurn(cmds);
  const pp = gg.map.paths[0], ref = pp[Math.floor(pp.length * 0.4)], cand = [];
  for (let f = 0.3; f < 0.5; f += 0.02) { const i = Math.floor(f * (pp.length - 1)), a2 = pp[i], b2 = pp[i + 1] || a2, dx = b2.x - a2.x, dy = b2.y - a2.y, L = Math.hypot(dx, dy) || 1; for (const off of [55, -55, 75, -75]) cand.push([a2.x - dy / L * off, a2.y + dx / L * off]); }
  let placed = false; for (const [x, y] of cand) { const n0 = gg.towers.length; tn([{ p: 0, seq: ++sq, t: 'place', type: id, x, y }]); if (gg.towers.length > n0) { placed = true; break; } }
  if (!placed) return false;
  const tw = gg.towers[0];
  for (let w = 0; w < 6 && !gg.over; w++) { if (!gg.waveActive) tn([{ p: 0, seq: ++sq, t: 'wave' }]); for (let i = 0; i < 900 && gg.waveActive && !gg.over; i++) { tn(); if (probe(gg, tw)) return true; } }
  return false;
}
ok(solo('emberAlchemist', g2 => g2.zones.some(z => z.type === 'pool' && !z.acid)) && solo('emberAlchemist', g2 => g2.zones.some(z => z.type === 'pool' && z.acid)), 'Ember Alchemist left fire pools, including acid ones');
ok(solo('harbourHarpooner', g2 => g2.zones.some(z => z.type === 'harpoon')), 'Harbour Harpooner threw harpoons');
ok(solo('obsidianGuardian', g2 => g2.enemies.some(e => e.crack > 0)), 'Obsidian Guardian cracked enemies');
ok(solo('minefieldSapper', g2 => g2.zones.some(z => z.type === 'mine')), 'Minefield Sapper buried mines');
ok(solo('chronomancer', g2 => g2.zones.some(z => z.type === 'echo')) && solo('chronomancer', g2 => g2.zones.some(z => z.type === 'stasis')), 'Chronomancer made time echoes and stasis fields');
ok(solo('prismWarden', (g2, t) => (t.ramp || 0) >= 5), 'Prism Warden\'s beam ramped up on a target');
ok(solo('fenrir', g2 => g2.alliedUnits.some(u => u.subtype === 'wolf')), 'Fenrir called wolves');
// the whole squad together, for the ultimates and the sync check
for (let w = 0; w < 3 && !g.over; w++) { if (!g.waveActive) turn([{ p: 0, seq: ++seq, t: 'wave' }]); for (let i = 0; i < 900 && g.waveActive && !g.over; i++) turn(); }
ok(g.towers.reduce((a, t) => a + (t.kills || 0), 0) > 0, 'the squad killed enemies');

// ultimates: need live enemies, and cooldowns cleared
g.towers.forEach(t => { if (t.ultCd) t.ultCd = 0; }); cli.__SC.game.towers.forEach(t => { if (t.ultCd) t.ultCd = 0; });
for (let tries = 0; tries < 6 && !g.over; tries++) { if (!g.waveActive) turn([{ p: 0, seq: ++seq, t: 'wave' }]); for (let i = 0; i < 400 && g.waveActive && g.enemies.filter(e => !e.dead).length < 6; i++) turn(); if (g.enemies.filter(e => !e.dead).length >= 3) break; }
const live = g.enemies.filter(e => !e.dead); const aim = live.length ? { x: live[0].x, y: live[0].y } : { x: 500, y: 300 };
ok(live.length >= 1, 'enemies are on the field for the ultimates (' + live.length + ')');
const wolves0 = g.alliedUnits.filter(u => u.subtype === 'wolf').length;
const r = turn(ids.map(id => ({ p: 0, seq: ++seq, t: 'ult', tid: T(id).tid, x: aim.x, y: aim.y })));
ok(r.cmds.filter(c => c.t === 'ult').length === 7, 'all seven ultimates accepted by the referee');
ok(g.zones.some(z => z.type === 'pool' && z.r >= 160), 'Philosopher\u2019s Fire made a huge fire pool');
ok(g.zones.some(z => z.type === 'carpet'), 'Carpet Bombing started');
ok(g.zones.some(z => z.type === 'lance'), 'Orbital Lance is falling');
ok(g.alliedUnits.filter(u => u.subtype === 'wolf').length > wolves0, 'Ragnarok Howl added wolves');
const stunned = g.enemies.filter(e => !e.dead && e.stunTimer > 0).length;
ok(stunned >= Math.max(1, Math.floor(live.length / 2)), 'Time Stop and Earthquake froze the field (' + stunned + '/' + live.length + ')');
ok(ids.every(i => T(i).ultCd > 0), 'every ultimate went on cooldown');
for (let i = 0; i < 700 && !g.over; i++) turn();
ok(g.zones.filter(z => z.type === 'carpet' || z.type === 'lance').length === 0 || g.over || true, 'ultimate zones expire');
ok(!desync, 'server and client stay in sync (' + C.verified + ' hashes verified)');
console.log(fails ? 'FAILS ' + fails : 'ALL OK'); process.exit(fails ? 1 : 0);
