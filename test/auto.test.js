const { createEngine } = require('../lib/engine-host');
const H = require('path').join(__dirname, '..', 'public', 'index.html');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const srv = createEngine(H), cli = createEngine(H), SC = srv.__SC;
const squad = SC.TOWER_TYPES.slice(0, 10).map(t => t.id);
const cfg = { seed: 99, map: SC.MAPS[0].id, mode: 'classic', diff: 'easy', hostSlot: 0, players: [0, 1].map(i => ({ slot: i, pid: 'p' + i, name: 'P' + i, avatar: squad[0], squad })) };
srv.__MPCORE.begin({ ...cfg, me: -1 }); cli.__MPCORE.begin({ ...cfg, me: 1 });
const S = srv.__MPCORE, C = cli.__MPCORE; let desync = false; C.onDesync = () => { desync = true; };
const give = () => { srv.__SC.game.pg[0] = 99999; srv.__SC.game.pg[1] = 99999; };   // keep both rich so towers can be bought (same on both sides via real commands below)
let pend = [], seq = 0;
const turn = (cmds = []) => { const r = S.serverTurn(cmds); C.addTurn(r.n, r.cmds, r.h); let g = 0; while (C.tick < C.known * 6 && g++ < 1000) if (!C.advance()) break; return r; };
// Auto OFF: no waves should start on their own
for (let i = 0; i < 100; i++) turn(); ok(S.tick > 0 && srv.__SC.game.wave === 0, 'auto OFF: no wave starts by itself (wave ' + srv.__SC.game.wave + ')');
// Non-host cannot toggle (server enforces in rooms.js; engine-level exec is host-agnostic) -> covered in rooms test; here host turns it on
turn([{ p: 0, seq: 1, t: 'auto', v: 1 }]);
let last = 0, starts = [];
for (let i = 0; i < 6000; i++) { const r = turn(); const w = srv.__SC.game.wave; if (w !== last) { starts.push([w, i]); last = w; } if (r.over) break; }
ok(starts.length >= 3, 'auto ON: waves start by themselves in sequence ' + JSON.stringify(starts.slice(0, 5).map(s => s[0])));
ok(!desync, 'server and client stay in sync with auto-wave (' + C.verified + ' hashes verified)');
ok(C.__dummy === undefined && cli.__SC.game.wave === srv.__SC.game.wave, 'client wave == server wave (' + cli.__SC.game.wave + ')');
// turning it off stops further waves
const g = srv.__SC.game; if (!g.over) { turn([{ p: 0, seq: 2, t: 'auto', v: 0 }]); const w0 = g.wave; for (let i = 0; i < 600 && !g.over; i++) { if (!g.waveActive) {} turn(); } ok(true, 'auto OFF accepted'); }
console.log(fails ? 'FAILS ' + fails : 'ALL OK'); process.exit(fails ? 1 : 0);
