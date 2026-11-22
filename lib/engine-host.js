'use strict';
// Runs the game's real simulation headlessly (Node vm + chainable DOM stub). Used by the server as the authoritative referee.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

function mkStub() {
  const f = function () {};
  const p = new Proxy(f, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then' || k === 'toJSON') return undefined;
      if (k === 'length') return 0;
      return mkStub();
    },
    apply: () => mkStub(), construct: () => mkStub(), set: () => true, has: () => true
  });
  return p;
}

function extractGameScript(html) {
  // the game engine is the largest inline <script> that defines TOWER_TYPES (the IIFE); the sprite-data and intro splash scripts are skipped
  const re = /<script>([\s\S]*?)<\/script>/g; let m, best = '';
  while ((m = re.exec(html))) if (m[1].length > best.length && m[1].indexOf('TOWER_TYPES') >= 0) best = m[1];   // skip the big sprite-data script
  return best;
}

let cachedScript = null;
function loadScript(htmlPath) {
  if (!cachedScript || cachedScript.p !== htmlPath) cachedScript = { p: htmlPath, code: extractGameScript(fs.readFileSync(htmlPath, 'utf8')) };
  return cachedScript.code;
}

function createEngine(htmlPath) {
  const store = {};
  const ls = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }, clear() { for (const k in store) delete store[k]; } };
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    localStorage: ls, sessionStorage: ls,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    navigator: { userAgent: 'headless', maxTouchPoints: 0 },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    document: mkStub(), Image: mkStub(), Path2D: mkStub(), OffscreenCanvas: mkStub(), AudioContext: mkStub(), webkitAudioContext: mkStub(),
    CanvasRenderingContext2D: mkStub(), HTMLElement: mkStub(), getComputedStyle: () => mkStub()
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(loadScript(htmlPath), sandbox, { filename: 'game.js' }); }
  catch (e) { if (!sandbox.__MPCORE && !sandbox.__SC) throw e; /* boot-time UI code may fail on stubs: engine hooks are defined before it */ }
  return sandbox;
}

module.exports = { createEngine, extractGameScript };
