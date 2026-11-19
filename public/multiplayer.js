/* Stone & Crown online multiplayer client: menu, lobby, networking glue and in-match HUD.
   The game simulation itself lives in index.html (window.__MPCORE); this file only moves commands and turns over Socket.IO. */
(function () {
  'use strict';
  const SC = window.__SC, CORE = window.__MPCORE;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (!SC || !CORE) return;

  // ---------- profile ----------
  const KEY = 'sc_mp_profile_v1';
  let session = {}; try { session = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { session = {}; }
  const saveSession = () => { try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* private mode */ } };
  const mySquad = () => { try { return SC.saveState.selectedSquad.filter(id => SC.PlayerData.isUnlocked(id)).slice(0, 10); } catch (e) { return []; } };
  const def = id => SC.TOWER_TYPES.find(t => t.id === id);
  if (!session.name) session.name = 'Player' + (1000 + Math.floor(Math.random() * 9000));
  if (!session.avatar || !def(session.avatar)) session.avatar = mySquad()[0] || SC.TOWER_TYPES[0].id;

  const cache = new Map();
  function portrait(id, size) {                                   // troop bust as a cached image (used for avatars and squads)
    const k = id + ':' + size; if (cache.has(k)) return cache.get(k);
    const c = document.createElement('canvas'); c.width = c.height = size * 2;
    try { SC.drawPortrait(c.getContext('2d'), size * 2, size * 2, def(id), 1.2, true); } catch (e) { /* ignore */ }
    const u = c.toDataURL(); cache.set(k, u); return u;
  }

  // ---------- state ----------
  let sock = null, seq = 0, room = null, view = 'menu', msg = '', msgOk = false, syncing = false, resyncs = 0, lastSync = 0, friends = { friends: [], requests: [] }, netState = 'idle', pickAvatar = false;
  const screen = document.createElement('section'); screen.id = 'mpScreen'; document.body.appendChild(screen);
  const hud = document.createElement('div'); hud.id = 'mpHud'; document.body.appendChild(hud);
  const bossEl = document.createElement('div'); bossEl.id = 'mpBoss'; document.body.appendChild(bossEl);
  const netEl = document.createElement('div'); netEl.id = 'mpNet'; document.body.appendChild(netEl);
  const toast = t => { try { SC.showToast ? SC.showToast(t) : null; } catch (e) { /* ignore */ } const el = $('toast'); if (el) { el.textContent = t; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); } };
  const open = v => { view = v; screen.classList.add('open'); render(); };
  const close = () => screen.classList.remove('open');
  const me = () => room && room.players.find(p => p.pid === session.pid);
  const isHost = () => room && room.hostPid === session.pid;

  // ---------- networking ----------
  function connect() {
    if (sock) return;
    if (typeof window.io !== 'function') { netState = 'missing'; msg = 'Multiplayer needs the game server. Open the game from its website address.'; return; }
    netState = 'connecting';
    sock = window.io({ auth: cb => cb({ pid: session.pid, token: session.token, name: session.name, avatar: session.avatar, squad: mySquad() }) });
    sock.on('connect', () => { netState = 'online'; seq = 0; netEl.classList.remove('on'); render(); });
    sock.on('connect_error', () => { netState = 'retry'; render(); });
    sock.on('disconnect', () => {
      netState = 'retry'; render();
      if (CORE.active && SC.game && !SC.game.over) { netEl.innerHTML = 'Connection lost &mdash; reconnecting&hellip;<small>The match keeps running. You will rejoin automatically.</small>'; netEl.classList.add('on'); }
    });
    sock.on('fatal', d => { msg = d.error || 'Connection refused.'; netState = 'error'; render(); });
    sock.on('welcome', d => {
      session.pid = d.pid; if (d.token) session.token = d.token; session.name = d.name; session.avatar = d.avatar; saveSession();
      if (d.inRoom) { open('lobby'); }                              // resumed an existing room; a game:log follows if a match is running
      refreshFriends(); render();
    });
    sock.on('room:state', s => {
      const was = room; room = s;
      if (CORE.active && CORE.cfg) { const h = s.players.find(p => p.pid === s.hostPid); if (h && h.slot >= 0) CORE.cfg.hostSlot = h.slot; SC.game && SC.game.waveActive !== undefined && CORE.hudFix(); }
      if (s.state === 'lobby' && was && was.state !== 'lobby' && !CORE.active) open('lobby');
      if (screen.classList.contains('open')) { view = 'lobby'; render(); }
      else if (view !== 'lobby' && !CORE.active && s.state === 'lobby') open('lobby');
    });
    sock.on('room:kicked', d => { room = null; toast(d.reason || 'Removed from the room.'); msg = d.reason || ''; open('menu'); });
    sock.on('game:start', d => { enterMatch(d.cfg, null); });
    sock.on('game:log', d => { syncing = false; enterMatch(d.cfg, d); });
    sock.on('game:turn', t => { if (!CORE.active) return; if (!CORE.addTurn(t.n, t.cmds, t.h)) requestSync('gap'); });
    sock.on('game:end', () => { CORE.ended = true; });
    sock.on('game:reject', r => {
      const m = { gold: 'Not enough gold.', blocked: 'Cannot deploy on the path, water or another unit.', type: 'That troop is not in your squad.', position: 'Invalid position.', owner: 'That troop belongs to another player.', host: 'Only the host can start waves.', rate: 'Slow down a little.', wave: 'A wave is already running.', max: 'Already at max level.', ultimate: 'Ultimate not ready.', aim: 'No target in range.', tower: 'That troop is gone.', over: 'The match is over.' };
      toast(m[r.why] || 'Action rejected.');
    });
  }
  function requestSync(why) {
    const now = Date.now(); if (syncing || now - lastSync < 1500) return; syncing = true; lastSync = now;
    if (why === 'desync') { resyncs++; if (resyncs > 4) { netEl.innerHTML = 'This match went out of sync.<small>Please leave and rejoin the room.</small>'; netEl.classList.add('on'); return; } }
    sock.emit('game:sync', {}, r => { if (!r || !r.ok) syncing = false; });
  }
  const rpc = (ev, data) => new Promise(res => { if (!sock || !sock.connected) return res({ ok: false, error: 'Not connected to the server yet.' }); sock.emit(ev, data || {}, r => res(r || { ok: false, error: 'No response.' })); });

  // ---------- entering / leaving a match ----------
  let initialLag = 1;
  function enterMatch(cfg, log) {
    close(); $('modalOverlay').classList.remove('visible'); netEl.classList.remove('on');
    CORE.onSend = c => { if (!sock || !sock.connected) { toast('Not connected: action not sent.'); return; } sock.emit('game:cmd', { seq: ++seq, c }); };
    CORE.onDesync = () => { netEl.innerHTML = 'Resynchronising with the match&hellip;'; netEl.classList.add('on'); requestSync('desync'); };
    CORE.onLeaveRequest = () => { $('modalOverlay').classList.remove('visible'); $('backToMapsBtn').click(); };
    CORE.onProgress = lag => {
      if (lag > 150) { if (!netEl.classList.contains('on')) { initialLag = lag; } const pct = Math.max(0, Math.min(99, Math.round((1 - lag / Math.max(initialLag, lag)) * 100))); netEl.innerHTML = `Syncing with the match&hellip; ${pct}%`; netEl.classList.add('on'); }
      else if (netEl.dataset.sync !== 'x' && netEl.classList.contains('on') && sock && sock.connected && !/lost|out of sync/.test(netEl.textContent)) netEl.classList.remove('on');
    };
    CORE.begin(cfg);
    if (log) { CORE.known = log.total; CORE.cmds = log.cmds || {}; CORE.ended = !!log.ended; initialLag = log.total * CORE.TT; netEl.innerHTML = 'Syncing with the match&hellip;'; netEl.classList.add('on'); }
    try { sessionStorage.setItem('sc_mp_active', '1'); } catch (e) { /* ignore */ }
    buildHud();
  }
  $('backToMapsBtn').addEventListener('click', e => {
    if (!CORE.active) return;
    const over = SC.game && SC.game.over;
    if (!over && !confirm('Leave this multiplayer match? Your troops stay and keep fighting for your team.')) { e.stopImmediatePropagation(); e.preventDefault(); return; }
    CORE.end(); hud.classList.remove('on'); bossEl.classList.remove('on'); netEl.classList.remove('on');
    if (over) setTimeout(() => open('lobby'), 0);
    else { try { sessionStorage.removeItem('sc_mp_active'); } catch (er) { /* ignore */ } if (sock) sock.emit('room:leave', {}); room = null; setTimeout(() => open('menu'), 0); }
  }, true);

  // ---------- in-match HUD (players, coins, base health, shared boss bar) ----------
  function buildHud() { hud.classList.add('on'); updateHud(); }
  function updateHud() {
    const g = SC.game;
    if (!CORE.active || !g || !g.pg) { hud.classList.remove('on'); bossEl.classList.remove('on'); return; }
    const rows = CORE.players.map(p => {
      const rp = room && room.players.find(x => x.pid === p.pid), conn = rp ? (rp.connected && !rp.left) : true, towers = g.towers.filter(t => t.owner === p.slot).length;
      return `<div class="mph-p${p.slot === CORE.me ? ' me' : ''}${conn ? '' : ' dc'}" style="border-left-color:${CORE.slotColor[p.slot % 4]}"><img src="${portrait(p.avatar, 28)}" alt=""><span class="n">${esc(p.name)}${room && room.hostPid === p.pid ? ' &#9813;' : ''}</span><span class="t">${conn ? towers + ' troops' : (rp && rp.left ? 'left' : 'offline')}</span><span class="g">${Math.floor(g.pg[p.slot] || 0)}g</span></div>`;
    }).join('');
    const pct = Math.max(0, Math.min(100, g.lives / Math.max(1, g.startLives) * 100));
    hud.innerHTML = rows + `<div class="mph-base">Shared base: ${Math.max(0, g.lives)} / ${g.startLives}<div class="mph-bar"><i style="width:${pct}%"></i></div></div>`;
    let hp = 0, mx = 0, nm = '';
    for (const e of g.enemies) if (e.isBoss && !e.dead) { hp += Math.max(0, e.hp); mx += e.maxHp; nm = e.name || 'Boss'; }
    if (mx > 0) { bossEl.innerHTML = `${esc(String(nm).toUpperCase())}<div class="bar"><i style="width:${Math.max(0, hp / mx * 100)}%"></i></div>`; bossEl.classList.add('on'); } else bossEl.classList.remove('on');
  }
  setInterval(updateHud, 120);

  // ---------- screens ----------
  const statusHtml = () => {
    const m = { idle: ['', 'Offline'], connecting: ['warn', 'Connecting&hellip;'], online: ['on', 'Online'], retry: ['warn', 'Reconnecting&hellip;'], error: ['off', 'Error'], missing: ['off', 'Server unavailable'] }[netState] || ['', ''];
    return `<span class="mp-status"><span class="mp-dot ${m[0]}"></span>${m[1]}</span>`;
  };
  function squadRow(sq) { return `<div class="mp-squad">${(sq || []).map(id => `<img src="${portrait(id, 32)}" title="${esc((def(id) || {}).name || id)}" alt="">`).join('')}</div>`; }
  function render() {
    if (!screen.classList.contains('open')) return;
    screen.innerHTML = `<div class="mp-top"><button class="btn" id="mpBack">&larr; ${view === 'lobby' ? 'Leave room' : 'Back'}</button><h2>${view === 'lobby' ? 'MULTIPLAYER LOBBY' : 'MULTIPLAYER'}</h2>${statusHtml()}</div><div class="mp-body">${view === 'lobby' && room ? lobbyHtml() : menuHtml()}</div>`;
    wire();
  }
  function menuHtml() {
    const fr = friends.friends.map(f => `<div class="mp-friend"><img src="${portrait(f.avatar || session.avatar, 34)}" alt=""><span style="flex:1">${esc(f.name)}</span><button class="btn" disabled title="Room invitations are coming soon">Invite</button></div>`).join('') || '<div class="mp-note">No friends yet.</div>';
    const rq = friends.requests.map(f => `<div class="mp-friend"><span style="flex:1">${esc(f.name)} wants to be friends</span><button class="btn btn-gold" data-acc="${esc(f.pid)}">Accept</button></div>`).join('');
    return `<div class="mp-grid"><div class="mp-card"><h3>PLAY WITH OTHERS</h3><div class="mp-profile" style="margin-bottom:16px"><img class="mp-avatar" id="mpAvatar" src="${portrait(session.avatar, 72)}" title="Change profile picture" alt=""><div style="flex:1"><div class="mp-note" style="margin-bottom:5px">YOUR NAME</div><input class="mp-input" id="mpName" maxlength="16" value="${esc(session.name)}" style="letter-spacing:0;text-align:left;text-transform:none"></div></div>${pickAvatar ? `<div class="mp-avatars">${SC.TOWER_TYPES.filter(t => SC.PlayerData.isUnlocked(t.id)).map(t => `<img data-av="${t.id}" class="${t.id === session.avatar ? 'sel' : ''}" src="${portrait(t.id, 54)}" title="${esc(t.name)}" alt="">`).join('')}</div>` : ''}
      <div class="mp-actions" style="margin-top:14px"><button class="btn btn-gold mp-btn-big" id="mpCreate">Create Private Room <small>share a code with friends</small></button><button class="btn mp-btn-big" id="mpQuick">Public Matchmaking <small>join a waiting room</small></button>
      <div class="mp-row"><input class="mp-input" id="mpCode" maxlength="5" placeholder="ROOM CODE" autocomplete="off"><button class="btn mp-btn-big" id="mpJoin" style="justify-content:center">Join Room</button></div></div><div class="mp-msg${msgOk ? ' ok' : ''}" id="mpMsg" style="margin-top:12px">${esc(msg)}</div>
      <div class="mp-note" style="margin-top:6px">Your squad of ${mySquad().length} troops comes with you. Up to 4 players defend one realm together; each has their own gold.</div></div>
      <div class="mp-card"><h3>FRIENDS</h3><div class="mp-note">Your player ID (share it so friends can add you):</div><div class="mp-row" style="margin:8px 0 14px"><input class="mp-input" readonly value="${esc(session.pid || '')}" style="letter-spacing:0;font-size:.72rem;text-transform:none"><button class="btn" id="mpCopyId">Copy</button></div>
      <div class="mp-row"><input class="mp-input" id="mpFriendWho" placeholder="Player name or ID" style="letter-spacing:0;text-transform:none;text-align:left"><button class="btn" id="mpAddFriend">Add</button></div>${rq}${fr}<div class="mp-note" style="margin-top:10px">Friend requests are stored on the server. Inviting friends straight into a room is planned for a later update.</div></div></div>`;
  }
  function lobbyHtml() {
    const r = room, host = isHost(), mine = me(), inEnded = r.state === 'ended', playing = r.state === 'playing';
    const slots = []; for (let i = 0; i < r.max; i++) {
      const p = r.players[i];
      if (!p) { slots.push('<div class="mp-slot empty">WAITING FOR PLAYER&hellip;</div>'); continue; }
      const badges = `${p.pid === r.hostPid ? '<span class="mp-badge host">HOST</span>' : ''}${!p.connected ? '<span class="mp-badge dc">DISCONNECTED</span>' : (p.ready ? '<span class="mp-badge rdy">READY</span>' : '<span class="mp-badge">NOT READY</span>')}`;
      slots.push(`<div class="mp-slot${p.ready && p.connected ? ' ready' : ''}${p.pid === session.pid ? ' me' : ''}"><div class="mp-slot-head"><img class="mp-avatar" src="${portrait(p.avatar, 56)}" alt=""><div><div class="mp-name">${esc(p.name)}</div><div class="mp-badges">${badges}</div></div></div>${squadRow(p.squad)}${host && p.pid !== session.pid && !playing ? `<button class="btn mp-kick" data-kick="${esc(p.pid)}">Remove</button>` : ''}</div>`);
    }
    const maps = SC.MAPS.map(m => `<option value="${m.id}"${m.id === r.cfg.map ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
    const sel = (id, opts, cur) => `<select class="mp-input" id="${id}" ${host && r.state === 'lobby' ? '' : 'disabled'} style="letter-spacing:0;text-transform:none;text-align:left">${opts.map(o => `<option value="${o[0]}"${o[0] === cur ? ' selected' : ''}>${o[1]}</option>`).join('')}</select>`;
    const diffs = Object.values(SC.DIFFS).map(d => [d.id, d.name]);
    const others = r.players.filter(p => p.pid !== r.hostPid), allReady = others.every(p => p.ready && p.connected), enough = r.players.length >= r.minPlayers;
    let action = '';
    if (playing) action = '<span class="mp-note">Match in progress &mdash; reconnecting&hellip;</span>';
    else if (inEnded) action = host ? '<button class="btn btn-gold mp-btn-big" id="mpRematch">Return everyone to the lobby</button>' : '<span class="mp-note">Match finished. Waiting for the host to open the lobby again&hellip;</span>';
    else if (host) action = `<button class="btn btn-gold mp-btn-big" id="mpStart" ${enough && allReady ? '' : 'disabled'}>Start Match <small>${!enough ? `need ${r.minPlayers} players` : (allReady ? 'everyone is ready' : 'waiting for players to ready up')}</small></button>`;
    else action = `<button class="btn ${mine && mine.ready ? '' : 'btn-gold'} mp-btn-big" id="mpReady">${mine && mine.ready ? 'Not ready' : 'READY'}</button>`;
    return `<div class="mp-card"><div class="mp-code"><div><div class="mp-note">ROOM CODE</div><b id="mpRoomCode">${esc(r.code)}</b></div><button class="btn" id="mpCopyCode">Copy code</button><button class="btn" id="mpCopyLink">Copy invite link</button><span class="mp-badge" style="margin-left:auto">${r.isPublic ? 'PUBLIC' : 'PRIVATE'} &bull; ${r.players.length}/${r.max} PLAYERS</span></div></div>
      <div class="mp-players">${slots.join('')}</div>
      <div class="mp-card"><h3>MATCH SETTINGS ${host ? '' : '<span class="mp-note">(host controls these)</span>'}</h3><div class="mp-settings"><label>Realm${sel('mpMap', SC.MAPS.map(m => [m.id, m.name]), r.cfg.map)}</label><label>Mode${sel('mpMode', [['classic', 'Classic (15 waves)'], ['endless', 'Endless'], ['hardcore', 'Hardcore']], r.cfg.mode)}</label><label>Difficulty${sel('mpDiff', diffs, r.cfg.diff)}</label><label>Visibility${sel('mpVis', [['0', 'Private (code only)'], ['1', 'Public (matchmaking)']], r.isPublic ? '1' : '0')}</label></div></div>
      <div class="mp-foot"><div class="mp-msg${msgOk ? ' ok' : ''}" id="mpMsg">${esc(msg)}</div>${action}</div>`;
  }
  function wire() {
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('mpBack', async () => { if (view === 'lobby' && room) { await rpc('room:leave'); room = null; msg = ''; view = 'menu'; render(); } else close(); });
    const nameEl = $('mpName'); if (nameEl) nameEl.addEventListener('change', () => { session.name = nameEl.value.trim().slice(0, 16) || session.name; saveSession(); rpc('profile', { name: session.name, avatar: session.avatar, squad: mySquad() }); });
    on('mpAvatar', () => { pickAvatar = !pickAvatar; render(); });
    screen.querySelectorAll('[data-av]').forEach(i => i.addEventListener('click', () => { session.avatar = i.dataset.av; saveSession(); pickAvatar = false; rpc('profile', { name: session.name, avatar: session.avatar, squad: mySquad() }); render(); }));
    const go = async (ev, data) => { msg = ''; const r = await rpc(ev, data); if (!r.ok) { msg = r.error || 'Something went wrong.'; msgOk = false; render(); return false; } msgOk = true; return true; };
    const sync = async () => { await rpc('profile', { name: session.name, avatar: session.avatar, squad: mySquad() }); };
    on('mpCreate', async () => { await sync(); if (await go('room:create', { isPublic: false })) { view = 'lobby'; render(); } });
    on('mpQuick', async () => { await sync(); if (await go('room:quick')) { view = 'lobby'; render(); } });
    on('mpJoin', async () => { const c = ($('mpCode').value || '').trim(); if (c.length < 4) { msg = 'Enter a room code.'; render(); return; } await sync(); if (await go('room:join', { code: c })) { view = 'lobby'; render(); } });
    const codeEl = $('mpCode'); if (codeEl) codeEl.addEventListener('keydown', e => { if (e.key === 'Enter') $('mpJoin').click(); e.stopPropagation(); });
    on('mpCopyId', () => { navigator.clipboard && navigator.clipboard.writeText(session.pid || ''); toast('Player ID copied.'); });
    on('mpAddFriend', async () => { const r = await rpc('friends:request', { who: $('mpFriendWho').value }); msg = r.ok ? 'Friend request sent.' : (r.error || 'Could not send.'); msgOk = !!r.ok; render(); });
    screen.querySelectorAll('[data-acc]').forEach(b => b.addEventListener('click', async () => { await rpc('friends:accept', { pid: b.dataset.acc }); refreshFriends(); }));
    on('mpCopyCode', () => { navigator.clipboard && navigator.clipboard.writeText(room.code); toast('Room code copied.'); });
    on('mpCopyLink', () => { const u = location.origin + location.pathname + '?room=' + room.code; navigator.clipboard && navigator.clipboard.writeText(u); toast('Invite link copied.'); });
    on('mpReady', async () => { const m = me(); await rpc('room:ready', { ready: !(m && m.ready) }); });
    on('mpStart', async () => { await go('room:start'); });
    on('mpRematch', async () => { await rpc('room:rematch'); });
    screen.querySelectorAll('[data-kick]').forEach(b => b.addEventListener('click', () => rpc('room:kick', { pid: b.dataset.kick })));
    const cfgChange = () => rpc('room:config', { map: $('mpMap').value, mode: $('mpMode').value, diff: $('mpDiff').value, isPublic: $('mpVis').value === '1' });
    ['mpMap', 'mpMode', 'mpDiff', 'mpVis'].forEach(id => { const el = $(id); if (el) el.addEventListener('change', cfgChange); });
  }
  async function refreshFriends() { const r = await rpc('friends:list'); if (r.ok) { friends = { friends: r.friends, requests: r.requests }; if (screen.classList.contains('open') && view === 'menu') render(); } }

  // ---------- entry points ----------
  function addButton() {
    const anchor = $('openCollectionBtn'); if (!anchor || $('openMultiplayerBtn')) return;
    const b = document.createElement('button'); b.id = 'openMultiplayerBtn'; b.className = 'btn btn-gold'; b.textContent = 'Multiplayer';
    anchor.parentNode.insertBefore(b, anchor);
    b.addEventListener('click', () => { connect(); open(room ? 'lobby' : 'menu'); });
  }
  addButton();
  const params = new URLSearchParams(location.search);
  let resume = false; try { resume = sessionStorage.getItem('sc_mp_active') === '1'; } catch (e) { /* ignore */ }
  if (params.get('room') || resume) {
    connect();
    const code = (params.get('room') || '').toUpperCase();
    if (code) { const t = setInterval(async () => { if (sock && sock.connected && session.pid) { clearInterval(t); open('menu'); const r = await rpc('room:join', { code }); if (r.ok) { view = 'lobby'; render(); } else { msg = r.error; render(); } history.replaceState(null, '', location.pathname); } }, 200); }
  }
  window.__MP = { get room() { return room; }, get session() { return session; }, connect, open, rpc, get sock() { return sock; } };
})();
