/* ============================================================
   SERVER — l'arbitro centrale del gioco
   ============================================================
   Novità di questa versione:
     - modalità "Gioca da solo": 1 umano + 3 bot autonomi
   Resto invariato: codici sessione, opzioni, power-up, serie.
   ============================================================ */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io      = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

/* ===================== CONFIGURAZIONE ===================== */
const COLONNE = 13, RIGHE = 11;
const TEMPO_BOMBA  = 2200, TEMPO_FIAMMA = 500;
const PASSO_BASE   = 140, PASSO_MIN = 70;
const TICK_MS      = 60;
const VUOTO = 0, MURO = 1, CASSA = 2;

const PROB_POWERUP = 0.35;
const TIPI_POWERUP = ['bomba', 'fuoco', 'velocita'];
const MAX_BOMBE_CAP = 6, RAGGIO_CAP = 6;
const INTERVALLO_MS = 2800;
const MAX_ROUND_MS = 90000;   // durata massima di un round (rete di sicurezza anti-stallo)

const ANGOLI = [ {x:1,y:1}, {x:COLONNE-2,y:1}, {x:1,y:RIGHE-2}, {x:COLONNE-2,y:RIGHE-2} ];
const COLORI = ['#41a6f6', '#ff5d5d', '#5ddf7a', '#ffd454'];
const DIRS = [['su',0,-1],['giu',0,1],['sx',-1,0],['dx',1,0]];
// personaggi disponibili (devono combaciare con quelli disegnati nel client)
const SKINS_OK = ['classico','robot','gatto','fantasma','rana','ninja'];
function validaSkin(s){ return SKINS_OK.includes(s) ? s : 'classico'; }

const stanze = {};

function generaCodice(){
  const L='ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c; do{ c=''; for(let i=0;i<4;i++) c+=L[Math.floor(Math.random()*L.length)]; } while(stanze[c]);
  return c;
}

/* ===================== MAPPA ===================== */
function creaMappa(){
  const m=[];
  for(let y=0;y<RIGHE;y++){ const r=[];
    for(let x=0;x<COLONNE;x++){
      if(x===0||y===0||x===COLONNE-1||y===RIGHE-1) r.push(MURO);
      else if(x%2===0&&y%2===0) r.push(MURO);
      else r.push(VUOTO);
    } m.push(r);
  }
  for(let y=1;y<RIGHE-1;y++) for(let x=1;x<COLONNE-1;x++){
    if(m[y][x]!==VUOTO||angoloLibero(x,y)) continue;
    if(Math.random()<0.78) m[y][x]=CASSA;
  }
  return m;
}
function angoloLibero(x,y){
  return ANGOLI.some(a=>{ const vx=a.x===1?1:-1, vy=a.y===1?1:-1;
    return (x===a.x&&y===a.y)||(x===a.x+vx&&y===a.y)||(x===a.x&&y===a.y+vy); });
}

/* ===================== SERIE E ROUND ===================== */
function avviaSerie(stanza){
  stanza.punteggi={};
  for(const id in stanza.giocatori) stanza.punteggi[id]=0;
  io.to(stanza.codice).emit('iniziata');
  iniziaRound(stanza);
}
function iniziaRound(stanza){
  stanza.mappa=creaMappa(); stanza.bombe=[]; stanza.fiamme=[]; stanza.powerups=[];
  Object.keys(stanza.giocatori).forEach((id,i)=>{
    const g=stanza.giocatori[id], a=ANGOLI[i%4];
    g.x=a.x; g.y=a.y; g.colore=COLORI[i%4]; g.vivo=true;
    g.dir=null; g.ultimoPasso=0; g.maxBombe=1; g.raggio=2; g.passoMs=PASSO_BASE;
  });
  stanza.stato='gioco'; stanza.ultimoIstante=Date.now(); stanza.inizioRound=Date.now();
  if(stanza.loop) clearInterval(stanza.loop);
  stanza.loop=setInterval(()=>aggiornaPartita(stanza), TICK_MS);
  io.to(stanza.codice).emit('nuovoRound', { classifica:classifica(stanza), opzioni:stanza.opzioni });
}
function aggiornaPartita(stanza){
  if(stanza.stato!=='gioco') return;
  const ora=Date.now(), delta=ora-stanza.ultimoIstante;
  stanza.ultimoIstante=ora;

  // movimento dei giocatori umani (seguono la direzione tenuta premuta)
  for(const id in stanza.giocatori){
    const g=stanza.giocatori[id];
    if(!g.bot && g.vivo && g.dir && ora-g.ultimoPasso>g.passoMs){ muovi(stanza,g,g.dir); g.ultimoPasso=ora; }
  }
  // ragionamento dei bot
  for(const id in stanza.giocatori){
    const g=stanza.giocatori[id];
    if(g.bot && g.vivo && ora-g.ultimoPasso>g.passoMs){ decidiBot(stanza,g,id); g.ultimoPasso=ora; }
  }

  for(const b of stanza.bombe){ b.tempo-=delta; if(b.tempo<=0) esplodi(stanza,b); }
  stanza.bombe=stanza.bombe.filter(b=>b.tempo>0);
  for(const f of stanza.fiamme) f.tempo-=delta;
  stanza.fiamme=stanza.fiamme.filter(f=>f.tempo>0);

  const vivi=Object.values(stanza.giocatori).filter(g=>g.vivo);
  if(vivi.length<=1){ fineRound(stanza, vivi[0]); return; }
  if(Date.now()-stanza.inizioRound > MAX_ROUND_MS){ fineSerie(stanza, null); return; }
  io.to(stanza.codice).emit('stato', fotografia(stanza));
}
function fineRound(stanza, sopravvissuto){
  if(stanza.loop){ clearInterval(stanza.loop); stanza.loop=null; }
  if(Object.keys(stanza.giocatori).length<2) return fineSerie(stanza, sopravvissuto);
  let idVinc=null;
  if(sopravvissuto){
    idVinc=Object.keys(stanza.giocatori).find(id=>stanza.giocatori[id]===sopravvissuto);
    if(idVinc) stanza.punteggi[idVinc]=(stanza.punteggi[idVinc]||0)+1;
  }
  const obiettivo=stanza.opzioni.bestOf3?2:1;
  if(idVinc && stanza.punteggi[idVinc]>=obiettivo) return fineSerie(stanza, sopravvissuto);
  stanza.stato='intervallo';
  io.to(stanza.codice).emit('roundFinito', { vincitore:sopravvissuto?sopravvissuto.nome:null, classifica:classifica(stanza) });
  setTimeout(()=>{ if(stanze[stanza.codice] && stanza.stato==='intervallo') iniziaRound(stanza); }, INTERVALLO_MS);
}
function fineSerie(stanza, vincitore){
  stanza.stato='lobby';
  if(stanza.loop){ clearInterval(stanza.loop); stanza.loop=null; }
  io.to(stanza.codice).emit('fine', { vincitore:vincitore?vincitore.nome:null, classifica:classifica(stanza) });
}

/* ===================== MOVIMENTO E POWER-UP ===================== */
function cella(stanza,x,y){ return (stanza.mappa[y]&&stanza.mappa[y][x]!==undefined)?stanza.mappa[y][x]:MURO; }
function camminabile(stanza,x,y){ return cella(stanza,x,y)===VUOTO && !stanza.bombe.some(b=>b.x===x&&b.y===y); }

function muovi(stanza,g,dir){
  let nx=g.x, ny=g.y;
  if(dir==='su') ny--; else if(dir==='giu') ny++; else if(dir==='sx') nx--; else if(dir==='dx') nx++;
  if(cella(stanza,nx,ny)!==VUOTO) return;
  if(stanza.bombe.some(b=>b.x===nx&&b.y===ny)) return;
  g.x=nx; g.y=ny;
  raccogli(stanza,g);
}
function raccogli(stanza,g){
  const i=stanza.powerups.findIndex(p=>p.x===g.x&&p.y===g.y);
  if(i<0) return;
  const tipo=stanza.powerups[i].tipo; stanza.powerups.splice(i,1);
  if(tipo==='bomba') g.maxBombe=Math.min(MAX_BOMBE_CAP,g.maxBombe+1);
  else if(tipo==='fuoco') g.raggio=Math.min(RAGGIO_CAP,g.raggio+1);
  else if(tipo==='velocita') g.passoMs=Math.max(PASSO_MIN,g.passoMs-25);
}

/* ===================== BOMBE ED ESPLOSIONI ===================== */
function piazzaBomba(stanza,id){
  const g=stanza.giocatori[id];
  if(!g||!g.vivo) return;
  if(stanza.bombe.filter(b=>b.owner===id).length>=g.maxBombe) return;
  if(stanza.bombe.some(b=>b.x===g.x&&b.y===g.y)) return;
  stanza.bombe.push({ x:g.x, y:g.y, tempo:TEMPO_BOMBA, owner:id, raggio:g.raggio });
}
function esplodi(stanza,bomba){
  const colpite=[{x:bomba.x,y:bomba.y}]; const casseRotte=[];
  for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
    for(let p=1;p<=bomba.raggio;p++){
      const x=bomba.x+dx*p, y=bomba.y+dy*p;
      if(cella(stanza,x,y)===MURO) break;
      colpite.push({x,y});
      if(cella(stanza,x,y)===CASSA){ stanza.mappa[y][x]=VUOTO; casseRotte.push({x,y}); break; }
    }
  }
  for(const c of colpite){
    stanza.fiamme.push({x:c.x,y:c.y,tempo:TEMPO_FIAMMA});
    const pi=stanza.powerups.findIndex(p=>p.x===c.x&&p.y===c.y);
    if(pi>=0) stanza.powerups.splice(pi,1);
    const altra=stanza.bombe.find(b=>b.x===c.x&&b.y===c.y&&b.tempo>0);
    if(altra) altra.tempo=0;
    for(const id in stanza.giocatori){ const g=stanza.giocatori[id];
      if(g.vivo&&g.x===c.x&&g.y===c.y) g.vivo=false; }
  }
  if(stanza.opzioni.powerup){
    for(const c of casseRotte){
      if(Math.random()<PROB_POWERUP){
        const tipo=TIPI_POWERUP[Math.floor(Math.random()*TIPI_POWERUP.length)];
        stanza.powerups.push({ x:c.x, y:c.y, tipo });
      }
    }
  }
}

/* ===================== INTELLIGENZA DEI BOT ===================== */
function chiave(x,y){ return x+','+y; }

// insieme delle caselle pericolose: fiamme attuali + traiettoria delle bombe
function mappaPericolo(stanza){
  const d=new Set();
  for(const f of stanza.fiamme) d.add(chiave(f.x,f.y));
  for(const b of stanza.bombe){
    d.add(chiave(b.x,b.y));
    for(const [_,dx,dy] of DIRS){
      for(let p=1;p<=b.raggio;p++){
        const x=b.x+dx*p, y=b.y+dy*p;
        if(cella(stanza,x,y)===MURO) break;
        d.add(chiave(x,y));
        if(cella(stanza,x,y)===CASSA) break;
      }
    }
  }
  return d;
}
function adiacenteCassa(stanza,x,y){ return DIRS.some(([_,dx,dy])=>cella(stanza,x+dx,y+dy)===CASSA); }
function nemicoAdiacente(stanza,x,y,self){
  return Object.values(stanza.giocatori).some(o=>o!==self&&o.vivo&&DIRS.some(([_,dx,dy])=>o.x===x+dx&&o.y===y+dy));
}
function scegli(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function decidiBot(stanza,g,id){
  const danger=mappaPericolo(stanza);
  const vicini=DIRS.map(([dir,dx,dy])=>({dir,x:g.x+dx,y:g.y+dy})).filter(v=>camminabile(stanza,v.x,v.y));

  // 1) sono in pericolo? scappo verso la casella sicura più vicina
  if(danger.has(chiave(g.x,g.y))){
    const dir=passoVersoSicuro(stanza,g,danger);
    if(dir) muovi(stanza,g,dir);
    return;
  }
  // 2) ho una cassa o un nemico accanto? piazzo una bomba (se ho una via di fuga)
  const nemicoVicino=Object.values(stanza.giocatori).some(o=>o!==g&&o.vivo&&(o.x===g.x||o.y===g.y)&&Math.abs(o.x-g.x)+Math.abs(o.y-g.y)<=g.raggio);
  const bombeAttive=stanza.bombe.filter(b=>b.owner===id).length;
  if((adiacenteCassa(stanza,g.x,g.y)||nemicoVicino) && bombeAttive<g.maxBombe && haViaDiFuga(stanza,g)){
    piazzaBomba(stanza,id);
    const dir=passoVersoSicuro(stanza,g,mappaPericolo(stanza));
    if(dir) muovi(stanza,g,dir);
    return;
  }
  // 3) altrimenti vado verso la cassa o il nemico più vicino
  const passo=passoVersoObiettivo(stanza,g,danger);
  if(passo){ muovi(stanza,g,passo); return; }
  // 4) ultima spiaggia: passo casuale sicuro
  const sicuri=vicini.filter(v=>!danger.has(chiave(v.x,v.y)));
  if(sicuri.length) muovi(stanza,g,scegli(sicuri).dir);
}
function haViaDiFuga(stanza,g){
  const fut=mappaPericolo(stanza);
  fut.add(chiave(g.x,g.y));
  for(const [_,dx,dy] of DIRS){
    for(let p=1;p<=g.raggio;p++){
      const x=g.x+dx*p, y=g.y+dy*p;
      if(cella(stanza,x,y)===MURO) break;
      fut.add(chiave(x,y));
      if(cella(stanza,x,y)===CASSA) break;
    }
  }
  // esiste una casella SICURA raggiungibile camminando? (anche girando l'angolo)
  return passoVersoSicuro(stanza,g,fut)!==null;
}
// primo passo del percorso verso la casella sicura più vicina (null se non c'è)
function passoVersoSicuro(stanza,g,danger){
  const visto=new Set([chiave(g.x,g.y)]); const coda=[];
  for(const [dir,dx,dy] of DIRS){ const x=g.x+dx,y=g.y+dy;
    if(camminabile(stanza,x,y)){ coda.push({x,y,dir}); visto.add(chiave(x,y)); } }
  let limite=250;
  while(coda.length && limite-->0){
    const n=coda.shift();
    if(!danger.has(chiave(n.x,n.y))) return n.dir;   // raggiunta una casella sicura
    for(const [_,dx,dy] of DIRS){ const x=n.x+dx,y=n.y+dy,k=chiave(x,y);
      if(!visto.has(k)&&camminabile(stanza,x,y)){ visto.add(k); coda.push({x,y,dir:n.dir}); } }
  }
  return null;
}
function passoVersoObiettivo(stanza,g,danger){
  const visto=new Set([chiave(g.x,g.y)]); const coda=[];
  for(const [dir,dx,dy] of DIRS){
    const x=g.x+dx,y=g.y+dy;
    if(camminabile(stanza,x,y)&&!danger.has(chiave(x,y))){ coda.push({x,y,dir}); visto.add(chiave(x,y)); }
  }
  let limite=250;
  while(coda.length && limite-->0){
    const n=coda.shift();
    if(adiacenteCassa(stanza,n.x,n.y)||nemicoAdiacente(stanza,n.x,n.y,g)) return n.dir;
    for(const [_,dx,dy] of DIRS){
      const x=n.x+dx,y=n.y+dy,k=chiave(x,y);
      if(!visto.has(k)&&camminabile(stanza,x,y)){ visto.add(k); coda.push({x,y,dir:n.dir}); }
    }
  }
  return null;
}

/* ===================== FOTOGRAFIA E CLASSIFICA ===================== */
function fotografia(stanza){
  return {
    mappa: stanza.mappa,
    giocatori: Object.entries(stanza.giocatori).map(([id,g])=>({ id, nome:g.nome, x:g.x, y:g.y, colore:g.colore, vivo:g.vivo, bot:!!g.bot, skin:g.skin||'classico' })),
    bombe: stanza.bombe.map(b=>({x:b.x,y:b.y,tempo:b.tempo})),
    fiamme: stanza.fiamme.map(f=>({x:f.x,y:f.y})),
    powerups: stanza.powerups.map(p=>({x:p.x,y:p.y,tipo:p.tipo}))
  };
}
function classifica(stanza){
  return Object.entries(stanza.giocatori).map(([id,g],i)=>({ nome:g.nome, colore:COLORI[i%4], punti:(stanza.punteggi&&stanza.punteggi[id])||0 }));
}

/* ===================== CONNESSIONI ===================== */
io.on('connection', (socket)=>{

  socket.on('creaPartita', (dati)=>{
    const codice=generaCodice();
    stanze[codice]={ codice, hostId:socket.id, giocatori:{}, stato:'lobby', loop:null, opzioni:{powerup:false,bestOf3:false}, punteggi:{}, singolo:false };
    stanze[codice].giocatori[socket.id]={ nome:(dati&&dati.nome)||'Host', skin:validaSkin(dati&&dati.skin) };
    socket.join(codice); socket.data.codice=codice;
    socket.emit('partitaCreata', codice); inviaLobby(codice);
  });

  // NUOVO: modalità in solitaria con 3 bot
  socket.on('creaSingolo', (dati)=>{
    const codice=generaCodice();
    stanze[codice]={ codice, hostId:socket.id, giocatori:{}, stato:'lobby', loop:null, opzioni:{powerup:false,bestOf3:false}, punteggi:{}, singolo:true };
    stanze[codice].giocatori[socket.id]={ nome:(dati&&dati.nome)||'Tu', skin:validaSkin(dati&&dati.skin) };
    for(let i=1;i<=3;i++) stanze[codice].giocatori['bot'+i]={ nome:'Bot '+i, bot:true, skin:SKINS_OK[Math.floor(Math.random()*SKINS_OK.length)] };
    socket.join(codice); socket.data.codice=codice;
    socket.emit('partitaCreata', codice); inviaLobby(codice);
  });

  socket.on('entra', ({codice,nome,skin})=>{
    codice=(codice||'').toUpperCase();
    const s=stanze[codice];
    if(!s){ socket.emit('erroreEntrata','Codice non valido'); return; }
    if(s.singolo){ socket.emit('erroreEntrata','Partita in solitaria'); return; }
    if(s.stato!=='lobby'){ socket.emit('erroreEntrata','La partita è già iniziata'); return; }
    if(Object.keys(s.giocatori).length>=4){ socket.emit('erroreEntrata','La stanza è piena (4 max)'); return; }
    s.giocatori[socket.id]={ nome:nome||'Giocatore', skin:validaSkin(skin) };
    socket.join(codice); socket.data.codice=codice;
    socket.emit('entrato', codice); inviaLobby(codice);
  });

  socket.on('opzioni', (opz)=>{
    const s=stanze[socket.data.codice];
    if(!s||s.hostId!==socket.id||s.stato!=='lobby') return;
    s.opzioni={ powerup:!!opz.powerup, bestOf3:!!opz.bestOf3 };
    inviaLobby(s.codice);
  });

  socket.on('avvia', ()=>{
    const s=stanze[socket.data.codice];
    if(!s||s.hostId!==socket.id) return;
    if(Object.keys(s.giocatori).length<2) return;
    avviaSerie(s);
  });

  socket.on('muovi', (dir)=>{
    const s=stanze[socket.data.codice];
    if(!s||s.stato!=='gioco') return;
    const g=s.giocatori[socket.id];
    if(!g||!g.vivo) return;
    g.dir=dir;
    if(dir){ muovi(s,g,dir); g.ultimoPasso=Date.now(); }
  });

  socket.on('bomba', ()=>{
    const s=stanze[socket.data.codice];
    if(!s||s.stato!=='gioco') return;
    piazzaBomba(s, socket.id);
  });

  socket.on('disconnect', ()=>{
    const codice=socket.data.codice, s=stanze[codice];
    if(!s) return;
    delete s.giocatori[socket.id];
    // se non resta nessun umano (i bot non contano), chiudiamo la stanza
    const umani=Object.values(s.giocatori).filter(g=>!g.bot).length;
    if(umani===0){ if(s.loop) clearInterval(s.loop); delete stanze[codice]; return; }
    if(s.hostId===socket.id) s.hostId=Object.keys(s.giocatori).find(id=>!s.giocatori[id].bot);
    if(s.stato==='lobby') inviaLobby(codice);
  });
});

function inviaLobby(codice){
  const s=stanze[codice];
  if(!s) return;
  const lista=Object.entries(s.giocatori).map(([id,g])=>({ nome:g.nome, host:id===s.hostId, bot:!!g.bot }));
  io.to(codice).emit('lobby', { codice, giocatori:lista, opzioni:s.opzioni, singolo:s.singolo });
}

const PORTA=process.env.PORT||3000;
server.listen(PORTA, ()=>console.log('Server acceso! http://localhost:'+PORTA));
