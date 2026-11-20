const { FakeServer } = require('./fakeio');
const { attach } = require('../lib/rooms');
const { createStore } = require('../lib/store');
const { createEngine } = require('../lib/engine-host');
const H=require('path').join(__dirname,'..','public','index.html');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0; const ok=(c,m)=>{ console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++; };
(async()=>{
  const probe=createEngine(H); const squad=probe.__SC.TOWER_TYPES.slice(0,10).map(t=>t.id);
  const store=createStore({}); await store.init();
  const slow=store.getProfile.bind(store); store.getProfile=async p=>{ await sleep(60); return slow(p); };   // simulate DB latency
  const io=new FakeServer();
  const mgr=attach(io,{store,htmlPath:H,opts:{minPlayers:2,gracePlayMs:4000,graceLobbyMs:300,hostMs:200}});
  const mk=async(name,extra={})=>{ const s=io.connect({name,squad,avatar:squad[0],...extra}); await s.ready; await sleep(5); s.pid=s.last('welcome').pid; s.token=s.last('welcome').token; return s; };

  // 1. returning player (stored pid) sends an event IMMEDIATELY after connecting despite slow DB
  const A0=await mk('Alice'); const A=io.connect({pid:A0.pid,token:A0.token,name:'Alice',squad,avatar:squad[0]});
  A0.drop(); await A.ready; let r=await A.send('room:create',{isPublic:false});
  ok(r.ok,'event sent right after connect is handled (no lost message): '+JSON.stringify(r));
  const code=r.code; A.pid=A0.pid; A.token=A0.token;
  const B=await mk('Bob'); await B.send('room:join',{code}); await B.send('room:ready',{ready:true});

  // 2. empty squad blocks start
  const store2=mgr; const room=mgr.rooms.get(code);
  room.find(B.pid).squad=[]; r=await A.send('room:start',{}); ok(!r.ok && /no troops/.test(r.error),'empty squad blocks start: '+r.error);
  room.find(B.pid).squad=squad;
  r=await A.send('room:start',{}); ok(r.ok,'start ok');

  // real client engine for Bob, consuming turns like multiplayer.js does
  const cli=createEngine(H); const C=cli.__MPCORE; C.begin({...B.last('game:start').cfg});
  let desync=false; C.onDesync=()=>{desync=true;};
  const pump=()=>{ let g=0; C.ended=!!C.ended; while(C.tick<C.known*6 && g++<400000){ if(!C.advance()) break; } };
  const feed=s=>{ s.client.on('game:turn',t=>{ if(!C.addTurn(t.n,t.cmds,t.h)) s.gap=true; }); s.client.on('game:catchup',d=>{ for(let n=d.from;n<d.total;n++) C.addTurn(n,(d.cmds&&d.cmds[n])||[],d.hashes?d.hashes[n]:undefined); if(d.ended) C.ended=true; s.gap=false; s.gotCatchup=(s.gotCatchup||0)+1; }); };
  feed(B);
  A.fire('game:cmd',{seq:1,c:{t:'wave'}});
  for(let i=0;i<6;i++){ B.fire('game:cmd',{seq:i+1,c:{t:'place',type:squad[i%squad.length],x:300+i*70,y:260}}); await sleep(120); }
  pump();
  // 3. Bob drops ~1s (misses turns), reconnects, resumes
  const knownBefore=C.known; B.drop(); await sleep(600);
  const turnsDuringDrop=room.log.total-knownBefore;
  const B2=io.connect({pid:B.pid,token:B.token,name:'Bob',squad,avatar:squad[0]}); await B2.ready; await sleep(5); feed(B2);
  ok(B2.last('welcome').state==='playing','welcome reports match state=playing');
  ok(B2.count('game:log')===0,'no automatic full replay on reconnect');
  r=await B2.send('game:resume',{from:C.known}); ok(r.ok,'resume accepted');
  await sleep(250); pump();
  ok(B2.gotCatchup===1,'catch-up delivered; missed '+turnsDuringDrop+' turns while offline');
  ok(C.known===room.log.total||room.log.total-C.known<=2,'client caught up (known '+C.known+' / server '+room.log.total+')');
  ok(!desync,'no desync after resume');
  // bad resume
  r=await B2.send('game:resume',{from:99999999}); ok(r.ok===false,'resume from the future rejected (client falls back to full sync)');
  // full sync still works
  r=await B2.send('game:sync',{}); ok(r.ok && B2.last('game:log').cfg.me===1,'full sync still works');

  // 4. host (Alice) drops in match -> host migrates after hostMs, Bob can start next wave
  ok(room.hostPid===A.pid,'Alice is host'); A.drop(); await sleep(60); ok(room.hostPid===A.pid,'not migrated instantly (grace for blips)');
  await sleep(300); ok(room.hostPid===B.pid,'host migrated to Bob after a few seconds');
  ok(B2.last('room:state').hostPid===B.pid,'clients told about the new host');

  // 5. everyone offline -> match is held, not advanced
  B2.drop(); await sleep(50); const t0=room.log.total; await sleep(400); ok(room.log.total===t0,'turns paused while all players are offline ('+t0+'->'+room.log.total+')');
  const B3=io.connect({pid:B.pid,token:B.token,name:'Bob',squad,avatar:squad[0]}); await B3.ready; await sleep(400);
  ok(room.log.total>t0,'turns resume when a player returns');
  ok(mgr.rooms.has(code),'room survived all-offline period < grace');

  // 6. store outage doesn't block connecting
  store.getProfile=async()=>{throw new Error('db down')}; store.saveProfile=async()=>{throw new Error('db down')};
  const Z=io.connect({name:'Zed',squad,avatar:squad[0]}); await Z.ready; await sleep(5); ok(!!Z.last('welcome'),'connects even if the database is down');

  // 7. final lockstep integrity: client state must equal server state when fully caught up
  B3.client.on('game:turn',()=>{}); feed(B3); const rr=await B3.send('game:resume',{from:C.known}); await sleep(150); pump();
  ok(!desync,'still no desync at the end ('+C.verified+' hashes verified)');
  console.log(fails?('FAILS: '+fails):'ALL OK'); process.exit(fails?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
