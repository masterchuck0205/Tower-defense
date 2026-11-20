// The HUD gold / upgrade-button / deck affordability must always reflect the LOCAL player's purse,
// even while the sim applies a teammate's command or steps the shared simulation.
const { createEngine } = require('../lib/engine-host');
const H = process.argv[2] || require('path').join(__dirname, '..', 'public', 'index.html');
const e = createEngine(H), C = e.__MPCORE, SC = e.__SC;
const squad = SC.TOWER_TYPES.slice(0, 10).map(t => t.id);
const texts = {}, mkEl = id => new Proxy({}, { get: (t, k) => k === 'textContent' ? texts[id] : (k === 'classList' ? { add() {}, remove() {}, toggle() {}, contains: () => false } : (k === 'style' ? {} : (() => mkEl(id)))), set: (t, k, v) => { if (k === 'textContent') texts[id] = v; if (k === 'disabled') texts[id + '.disabled'] = v; return true; } });
const base = e.document; e.document = new Proxy(base, { get: (t, k) => k === 'getElementById' ? (id => mkEl(id)) : t[k] });
const cfg = { seed: 7, map: SC.MAPS[0].id, mode: 'classic', diff: 'normal', hostSlot: 0, me: 1, players: [0, 1].map(i => ({ slot: i, pid: 'p' + i, name: 'P' + i, avatar: squad[0], squad })) };
C.begin(cfg);
const g = SC.game; g.pg[0] = 5000; g.pg[1] = 77;
let bad = 0, checks = 0;
for (let i = 0; i < 6; i++) {
  C.exec({ p: 0, seq: i, t: 'place', type: squad[i % squad.length], x: 300 + i * 70, y: 250 });   // teammate buys -> UI refreshes inside exec
  checks++; if (String(texts.hudGold) !== '77') { bad++; console.log('HUD showed', texts.hudGold, 'expected 77 after teammate action', i); }
}
C.exec({ p: 0, t: 'wave', seq: 99 });
for (let i = 0; i < 1200; i++) { C.stepTick(); if (texts.hudGold !== undefined && String(texts.hudGold) !== String(Math.floor(g.pg[1]))) { bad++; console.log('HUD showed', texts.hudGold, 'but my gold is', Math.floor(g.pg[1]), 'at tick', i); break; } }
console.log(bad ? 'FAIL: HUD showed another player\'s gold (' + bad + ' times)' : 'PASS: HUD always shows my own gold');
process.exit(bad ? 1 : 0);
