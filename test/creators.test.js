// Creator class: Chuck (gold support), Lachlan (construct builder), Ozan (golem forger) behave, pay the right player and stay in sync.
const { createEngine } = require('../lib/engine-host');
const H = require('path').join(__dirname, '..', 'public', 'index.html');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const srv = createEngine(H), cli = createEngine(H), SC = srv.__SC;
const ids = ['chuck', 'lachlan', 'ozan'];
ok(ids.every(i => SC.TOWER_TYPES.some(t => t.id === i && t.faction === 'Creator')), 'Chuck, Lachlan and Ozan exist in the Creator class');
ok(new Set(SC.TOWER_TYPES.map(t => t.id)).size === SC.TOWER_TYPES.length && new Set(SC.TOWER_TYPES.map(t => t.uid)).size === SC.TOWER_TYPES.length, 'troop ids and uids are unique');
const squad = [...ids, ...SC.TOWER_TYPES.map(t => t.id).filter(i => !ids.includes(i)).slice(0, 7)];
const cfg = { seed: 5, map: SC.MAPS[0].id, mode: 'classic', diff: 'easy', hostSlot: 0, players: [0, 1].map(i => ({ slot: i, pid: 'p' + i, name: 'P' + i, avatar: squad[0], squad })) };
srv.__MPCORE.begin({ ...cfg, me: -1 }); cli.__MPCORE.begin({ ...cfg, me: 1 });
const S = srv.__MPCORE, C = cli.__MPCORE; let desync = false; C.onDesync = () => { desync = true; };
for (const e of [srv, cli]) { e.__SC.game.pg[0] = 20000; e.__SC.game.pg[1] = 500; }
let seq = 0;
const turn = (cmds = []) => { const r = S.serverTurn(cmds); C.addTurn(r.n, r.cmds, r.h); let g = 0; while (C.tick < C.known * 6 && g++ < 1000) if (!C.advance()) break; return r; };
const g = srv.__SC.game;
// slot 0 owns all three Creators; slot 1 owns nothing, so any gold it receives would be a leak of Chuck's income
const spots = []; for (let y = 120; y <= 620; y += 40) for (let x = 120; x <= 1100; x += 60) spots.push([x, y]);
let si = 0;
for (const id of ids) {
  let placed = false;
  while (!placed && si < spots.length) { const [x, y] = spots[si++]; const before = g.towers.length; turn([{ p: 0, seq: ++seq, t: 'place', type: id, x, y }]); placed = g.towers.length > before; }
  ok(placed, id + ' can be deployed');
}
const T = id => g.towers.find(t => t.typeId === id);
ok(ids.every(i => T(i) && T(i).owner === 0), 'all three belong to player 0');
const p1Start = g.pg[1], p0Start = g.pg[0];
turn([{ p: 0, seq: ++seq, t: 'wave' }]);
let sawConstruct = false, sawGolem = false, midP1, midActive;
for (let i = 0; i < 700 && !g.over; i++) {
  turn();
  if (g.alliedUnits.some(u => u.kind === 'construct')) sawConstruct = true;
  if (g.alliedUnits.some(u => u.subtype === 'golem')) sawGolem = true;
  if (T('chuck').paid > 0 && midP1 === undefined) { midP1 = g.pg[1]; midActive = g.waveActive; }
  if (!g.waveActive) break;
}
ok(T('chuck').paid > 0, 'Chuck paid out gold (' + T('chuck').paid + 'g from Payday and Tip Jar)');
ok(g.pg[0] > p0Start, 'player 0 purse grew (' + p0Start + ' -> ' + Math.floor(g.pg[0]) + ')');
ok(midActive && midP1 === p1Start, 'player 1 received none of Chuck\'s income while the wave was running (' + midP1 + ' vs start ' + p1Start + ')');
ok(sawConstruct, 'Lachlan conjured Constructs');
ok(sawGolem, 'Ozan forged Clay Golems');
// ultimates (they start on a 15 s cooldown, so run the clock down first)
g.towers.forEach(t => { if (t.ultCd) t.ultCd = 0; }); cli.__SC.game.towers.forEach(t => { if (t.ultCd) t.ultCd = 0; });
if (!g.waveActive && !g.over) turn([{ p: 0, seq: ++seq, t: 'wave' }]);
for (let i = 0; i < 40; i++) turn();
const gold0 = g.pg[0], paid0 = T('chuck').paid || 0;
const r = turn(['chuck', 'lachlan', 'ozan'].map(id => ({ p: 0, seq: ++seq, t: 'ult', tid: T(id).tid, x: 500, y: 300 })));
ok(r.cmds.filter(c => c.t === 'ult').length === 3, 'all three ultimates accepted by the referee');
ok(T('chuck').hourT > 0 && g.pg[0] >= gold0 + 60, 'Golden Hour paid a lump sum and started the double-pay window');
for (let i = 0; i < 40; i++) turn();
ok(g.zones.some(z => z.type === 'genesis') || g.alliedUnits.some(u => u.kind === 'construct'), 'Let There Be Light made a Blueprint Realm / Constructs');
ok(g.alliedUnits.filter(u => u.subtype === 'golem').length >= 2, 'Mass Forging raised Golems (' + g.alliedUnits.filter(u => u.subtype === 'golem').length + ')');
for (let i = 0; i < 300 && !g.over; i++) turn();
ok(!desync, 'server and client stay in sync (' + C.verified + ' hashes verified)');
console.log(fails ? 'FAILS ' + fails : 'ALL OK'); process.exit(fails ? 1 : 0);
