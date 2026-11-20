const { FakeServer } = require('./fakeio');
const { attach } = require('../lib/rooms');
const { createStore } = require('../lib/store');
const { createEngine } = require('../lib/engine-host');
const H=require('path').join(__dirname,'..','public','index.html');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const squad=createEngine(H).__SC.TOWER_TYPES.slice(0,10).map(t=>t.id);
  const store=createStore({}); await store.init(); const io=new FakeServer();
  const mgr=attach(io,{store,htmlPath:H,opts:{minPlayers:2,turnMs:3,gracePlayMs:5000}});
  const mk=async n=>{ const s=io.connect({name:n,squad,avatar:squad[0]}); await s.ready; await sleep(5); s.pid=s.last('welcome').pid; s.token=s.last('welcome').token; return s; };
  const A=await mk('Al'), B=await mk('Bo'); const {code}=await A.send('room:create',{}); await B.send('room:join',{code}); await B.send('room:ready',{ready:true}); await A.send('room:start',{});
  const room=mgr.rooms.get(code);
  const C=createEngine(H).__MPCORE; C.begin({...B.last('game:start').cfg}); let desync=false; C.onDesync=()=>{desync=true};
  const pump=()=>{ let g=0; while(C.tick<C.known*6 && g++<2e6){ if(!C.advance()) break; } };
  const feed=s=>{ s.client.on('game:turn',t=>{ if(!C.addTurn(t.n,t.cmds,t.h)) s.gap=true; }); s.client.on('game:catchup',d=>{ for(let n=d.from;n<d.total;n++) C.addTurn(n,(d.cmds&&d.cmds[n])||[],d.hashes?d.hashes[n]:undefined); }); };
  feed(B);
  A.fire('game:cmd',{seq:1,c:{t:'wave'}});
  for(let i=0;i<8;i++){ (i%2?A:B).fire('game:cmd',{seq:10+i,c:{t:'place',type:squad[i],x:260+i*60,y:250+(i%3)*40}}); await sleep(15); }
  let cur=B, drops=0;
  for(let round=0;round<6;round++){
    await sleep(120); pump();
    cur.drop(); drops++; await sleep(150);                        // offline: server keeps going, client misses turns
    cur=io.connect({pid:B.pid,token:B.token,name:'Bo',squad,avatar:squad[0]}); await cur.ready; await sleep(5); feed(cur);
    const r=await cur.send('game:resume',{from:C.known}); await sleep(40); pump();
    if(!(await cur.send('room:ready',{ready:true}))) {}
  }
  await sleep(200); pump();
  console.log('server turns',room.log.total,'| client known',C.known,'tick',C.tick,'| drops',drops,'| hashes verified',C.verified,'| desync',desync,'| wave',C.tick&&createEngine&&0);
  process.exit(desync||C.verified<5?1:0);
})();
