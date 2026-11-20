const { EventEmitter } = require('events');
class FakeServer extends EventEmitter {
  constructor(){ super(); this.roomsMap=new Map(); this.socks=new Set(); this.mw=[]; }
  use(fn){ this.mw.push(fn); }
  to(code){ return { emit:(ev,d)=>{ for(const s of this.roomsMap.get(code)||[]) s._recv(ev,d); } }; }
  connect(auth){ const s=new FakeSocket(this,auth); this.socks.add(s);
    s.ready=(async()=>{ for(const fn of this.mw){ await new Promise((res,rej)=>fn(s,e=>e?rej(e):res()).catch?.(rej)); } this.emit('connection',s); })().catch(e=>{ s.error=e; s.connected=false; s.client.emit('connect_error',e); });
    return s; }
}
class FakeSocket {
  constructor(io,auth){ this.io=io; this.handshake={auth}; this.data={}; this.client=new EventEmitter(); this.srv=new EventEmitter(); this.log=[]; this.connected=true; this.rooms=new Set(); }
  on(ev,fn){ this.srv.on(ev,fn); }
  join(c){ if(!this.io.roomsMap.has(c)) this.io.roomsMap.set(c,new Set()); this.io.roomsMap.get(c).add(this); this.rooms.add(c); }
  leave(c){ const s=this.io.roomsMap.get(c); if(s) s.delete(this); this.rooms.delete(c); }
  emit(ev,d){ this._recv(ev,d); }                 // server -> client
  _recv(ev,d){ if(!this.connected) return; this.log.push([ev,d]); this.client.emit(ev,d); }
  disconnect(){ this.drop(); }
  drop(){ if(!this.connected) return; this.connected=false; for(const c of [...this.rooms]) this.leave(c); this.srv.emit('disconnect'); }
  // client -> server
  send(ev,d){ return new Promise(res=>{ let done=false; const t=setTimeout(()=>{ if(!done) res({timeout:true}); },300); this.srv.emit(ev,d,r=>{done=true;clearTimeout(t);res(r);}); }); }
  fire(ev,d){ this.srv.emit(ev,d); }
  last(ev){ for(let i=this.log.length-1;i>=0;i--) if(this.log[i][0]===ev) return this.log[i][1]; }
  count(ev){ return this.log.filter(l=>l[0]===ev).length; }
}
module.exports={FakeServer};
