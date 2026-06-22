/* ============================================================
   SERVER — l'arbitro centrale del gioco
   ============================================================
   Novità di questa versione:
     - opzioni decise dall'host in lobby (power-up, meglio di 3)
     - power-up che escono dalle casse (più bombe, fuoco, velocità)
     - serie "al meglio di 3" con punteggio tra i round
     - fino a 4 giocatori
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
const PASSO_BASE   = 140;     // velocità di partenza
const PASSO_MIN    = 70;      // velocità massima raggiungibile
const TICK_MS      = 60;
const VUOTO = 0, MURO = 1, CASSA = 2;

// power-up
const PROB_POWERUP = 0.35;            // probabilità che una cassa lasci un bonus
const TIPI_POWERUP = ['bomba', 'fuoco', 'velocita'];
const MAX_BOMBE_CAP = 6, RAGGIO_CAP = 6;

// serie
const INTERVALLO_MS = 2800;           // pausa fra un round e l'altro

const ANGOLI = [
  { x:1, y:1 }, { x:COLONNE-2, y:1 }, { x:1, y:RIGHE-2 }, { x:COLONNE-2, y:RIGHE-2 }
];
const COLORI = ['#41a6f6', '#ff5d5d', '#5ddf7a', '#ffd454'];

const stanze = {};

function generaCodice(){
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c; do { c=''; for(let i=0;i<4;i++) c+=L[Math.floor(Math.random()*L.length)]; } while(stanze[c]);
  return c;
}

/* ===================== MAPPA ===================== */
function creaMappa(){
  const m = [];
  for(let y=0;y<RIGHE;y++){ const r=[];
    for(let x=0;x<COLONNE;x++){
      if(x===0||y===0||x===COLONNE-1||y===RIGHE-1) r.push(MURO);
      else if(x%2===0 && y%2===0) r.push(MURO);
      else r.push(VUOTO);
    } m.push(r);
  }
  for(let y=1;y<RIGHE-1;y++) for(let x=1;x<COLONNE-1;x++){
    if(m[y][x]!==VUOTO || angoloLibero(x,y)) continue;
    if(Math.random()<0.78) m[y][x]=CASSA;
  }
  return m;
}
function angoloLibero(x,y){
  return ANGOLI.some(a=>{
    const vx=a.x===1?1:-1, vy=a.y===1?1:-1;
    return (x===a.x&&y===a.y)||(x===a.x+vx&&y===a.y)||(x===a.x&&y===a.y+vy);
  });
}

/* ===================== SERIE E ROUND ===================== */
function avviaSerie(stanza){
  stanza.punteggi = {};
  for(const id in stanza.giocatori) stanza.punteggi[id] = 0;
  io.to(stanza.codice).emit('iniziata');
  iniziaRound(stanza);
}

function iniziaRound(stanza){
  stanza.mappa = creaMappa();
  stanza.bombe = []; stanza.fiamme = []; stanza.powerups = [];
  const ids = Object.keys(stanza.giocatori);
  ids.forEach((id,i)=>{
    const g = stanza.giocatori[id], a = ANGOLI[i%4];
    g.x=a.x; g.y=a.y; g.colore=COLORI[i%4]; g.vivo=true;
    g.dir=null; g.ultimoPasso=0;
    g.maxBombe=1; g.raggio=2; g.passoMs=PASSO_BASE;   // statistiche di partenza
  });
  stanza.stato = 'gioco';
  stanza.ultimoIstante = Date.now();
  if(stanza.loop) clearInterval(stanza.loop);
  stanza.loop = setInterval(()=>aggiornaPartita(stanza), TICK_MS);
  io.to(stanza.codice).emit('nuovoRound', { classifica: classifica(stanza), opzioni: stanza.opzioni });
}

function aggiornaPartita(stanza){
  if(stanza.stato!=='gioco') return;
  const ora = Date.now(), delta = ora - stanza.ultimoIstante;
  stanza.ultimoIstante = ora;

  for(const id in stanza.giocatori){
    const g = stanza.giocatori[id];
    if(g.vivo && g.dir && ora - g.ultimoPasso > g.passoMs){ muovi(stanza,g,g.dir); g.ultimoPasso=ora; }
  }
  for(const b of stanza.bombe){ b.tempo-=delta; if(b.tempo<=0) esplodi(stanza,b); }
  stanza.bombe = stanza.bombe.filter(b=>b.tempo>0);
  for(const f of stanza.fiamme) f.tempo-=delta;
  stanza.fiamme = stanza.fiamme.filter(f=>f.tempo>0);

  const vivi = Object.values(stanza.giocatori).filter(g=>g.vivo);
  if(vivi.length<=1){ fineRound(stanza, vivi[0]); return; }

  io.to(stanza.codice).emit('stato', fotografia(stanza));
}

function fineRound(stanza, sopravvissuto){
  if(stanza.loop){ clearInterval(stanza.loop); stanza.loop=null; }

  // troppo pochi giocatori collegati: chiudiamo la serie
  if(Object.keys(stanza.giocatori).length < 2){
    return fineSerie(stanza, sopravvissuto);
  }

  // assegniamo il punto al vincitore del round (se c'è)
  let idVinc = null;
  if(sopravvissuto){
    idVinc = Object.keys(stanza.giocatori).find(id => stanza.giocatori[id] === sopravvissuto);
    if(idVinc) stanza.punteggi[idVinc] = (stanza.punteggi[idVinc]||0) + 1;
  }

  const obiettivo = stanza.opzioni.bestOf3 ? 2 : 1;
  if(idVinc && stanza.punteggi[idVinc] >= obiettivo){
    return fineSerie(stanza, sopravvissuto);   // ha vinto la serie
  }

  // altrimenti: pausa, poi prossimo round
  stanza.stato = 'intervallo';
  io.to(stanza.codice).emit('roundFinito', {
    vincitore: sopravvissuto ? sopravvissuto.nome : null,
    classifica: classifica(stanza)
  });
  setTimeout(()=>{
    if(stanze[stanza.codice] && stanza.stato==='intervallo') iniziaRound(stanza);
  }, INTERVALLO_MS);
}

function fineSerie(stanza, vincitore){
  stanza.stato = 'lobby';
  if(stanza.loop){ clearInterval(stanza.loop); stanza.loop=null; }
  io.to(stanza.codice).emit('fine', {
    vincitore: vincitore ? vincitore.nome : null,
    classifica: classifica(stanza)
  });
}

/* ===================== MOVIMENTO E POWER-UP ===================== */
function muovi(stanza, g, dir){
  let nx=g.x, ny=g.y;
  if(dir==='su') ny--; else if(dir==='giu') ny++;
  else if(dir==='sx') nx--; else if(dir==='dx') nx++;
  if(stanza.mappa[ny][nx]!==VUOTO) return;
  if(stanza.bombe.some(b=>b.x===nx && b.y===ny)) return;
  g.x=nx; g.y=ny;
  raccogli(stanza, g);     // ha calpestato un power-up?
}

function raccogli(stanza, g){
  const i = stanza.powerups.findIndex(p=>p.x===g.x && p.y===g.y);
  if(i<0) return;
  const tipo = stanza.powerups[i].tipo;
  stanza.powerups.splice(i,1);
  if(tipo==='bomba')        g.maxBombe = Math.min(MAX_BOMBE_CAP, g.maxBombe+1);
  else if(tipo==='fuoco')   g.raggio   = Math.min(RAGGIO_CAP, g.raggio+1);
  else if(tipo==='velocita')g.passoMs  = Math.max(PASSO_MIN, g.passoMs-25);
}

/* ===================== BOMBE ED ESPLOSIONI ===================== */
function piazzaBomba(stanza, id){
  const g = stanza.giocatori[id];
  if(!g || !g.vivo) return;
  const attive = stanza.bombe.filter(b=>b.owner===id).length;
  if(attive >= g.maxBombe) return;                          // limite di bombe
  if(stanza.bombe.some(b=>b.x===g.x && b.y===g.y)) return;  // una per casella
  stanza.bombe.push({ x:g.x, y:g.y, tempo:TEMPO_BOMBA, owner:id, raggio:g.raggio });
}

function esplodi(stanza, bomba){
  const colpite = [{x:bomba.x, y:bomba.y}];
  for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
    for(let p=1; p<=bomba.raggio; p++){
      const x=bomba.x+dx*p, y=bomba.y+dy*p;
      if(stanza.mappa[y][x]===MURO) break;
      colpite.push({x,y});
      if(stanza.mappa[y][x]===CASSA){
        stanza.mappa[y][x]=VUOTO;
        // la cassa può lasciare un power-up
        if(stanza.opzioni.powerup && Math.random()<PROB_POWERUP){
          const tipo = TIPI_POWERUP[Math.floor(Math.random()*TIPI_POWERUP.length)];
          stanza.powerups.push({ x, y, tipo });
        }
        break;
      }
    }
  }
  for(const c of colpite){
    stanza.fiamme.push({x:c.x, y:c.y, tempo:TEMPO_FIAMMA});
    // un power-up colpito dal fuoco viene distrutto
    const pi = stanza.powerups.findIndex(p=>p.x===c.x && p.y===c.y);
    if(pi>=0) stanza.powerups.splice(pi,1);
    // reazione a catena
    const altra = stanza.bombe.find(b=>b.x===c.x && b.y===c.y && b.tempo>0);
    if(altra) altra.tempo=0;
    // giocatori colpiti
    for(const id in stanza.giocatori){
      const g = stanza.giocatori[id];
      if(g.vivo && g.x===c.x && g.y===c.y) g.vivo=false;
    }
  }
}

/* ===================== FOTOGRAFIA E CLASSIFICA ===================== */
function fotografia(stanza){
  return {
    mappa: stanza.mappa,
    giocatori: Object.entries(stanza.giocatori).map(([id,g])=>({
      id, nome:g.nome, x:g.x, y:g.y, colore:g.colore, vivo:g.vivo
    })),
    bombe: stanza.bombe.map(b=>({x:b.x, y:b.y, tempo:b.tempo})),
    fiamme: stanza.fiamme.map(f=>({x:f.x, y:f.y})),
    powerups: stanza.powerups.map(p=>({x:p.x, y:p.y, tipo:p.tipo}))
  };
}
function classifica(stanza){
  return Object.entries(stanza.giocatori).map(([id,g])=>({
    nome:g.nome, colore:COLORI[Object.keys(stanza.giocatori).indexOf(id)%4],
    punti: (stanza.punteggi && stanza.punteggi[id]) || 0
  }));
}

/* ===================== CONNESSIONI ===================== */
io.on('connection', (socket)=>{

  socket.on('creaPartita', (nome)=>{
    const codice = generaCodice();
    stanze[codice] = {
      codice, hostId:socket.id, giocatori:{}, stato:'lobby', loop:null,
      opzioni:{ powerup:false, bestOf3:false }, punteggi:{}
    };
    stanze[codice].giocatori[socket.id] = { nome:nome||'Host' };
    socket.join(codice); socket.data.codice=codice;
    socket.emit('partitaCreata', codice);
    inviaLobby(codice);
  });

  socket.on('entra', ({codice, nome})=>{
    codice = (codice||'').toUpperCase();
    const s = stanze[codice];
    if(!s){ socket.emit('erroreEntrata','Codice non valido'); return; }
    if(s.stato!=='lobby'){ socket.emit('erroreEntrata','La partita è già iniziata'); return; }
    if(Object.keys(s.giocatori).length>=4){ socket.emit('erroreEntrata','La stanza è piena (4 max)'); return; }
    s.giocatori[socket.id] = { nome:nome||'Giocatore' };
    socket.join(codice); socket.data.codice=codice;
    socket.emit('entrato', codice);
    inviaLobby(codice);
  });

  // l'host cambia le opzioni in lobby
  socket.on('opzioni', (opz)=>{
    const s = stanze[socket.data.codice];
    if(!s || s.hostId!==socket.id || s.stato!=='lobby') return;
    s.opzioni = { powerup: !!opz.powerup, bestOf3: !!opz.bestOf3 };
    inviaLobby(s.codice);
  });

  socket.on('avvia', ()=>{
    const s = stanze[socket.data.codice];
    if(!s || s.hostId!==socket.id) return;
    if(Object.keys(s.giocatori).length<2) return;
    avviaSerie(s);
  });

  socket.on('muovi', (dir)=>{
    const s = stanze[socket.data.codice];
    if(!s || s.stato!=='gioco') return;
    const g = s.giocatori[socket.id];
    if(!g || !g.vivo) return;
    g.dir = dir;
    if(dir){ muovi(s,g,dir); g.ultimoPasso=Date.now(); }
  });

  socket.on('bomba', ()=>{
    const s = stanze[socket.data.codice];
    if(!s || s.stato!=='gioco') return;
    piazzaBomba(s, socket.id);
  });

  socket.on('disconnect', ()=>{
    const codice = socket.data.codice, s = stanze[codice];
    if(!s) return;
    delete s.giocatori[socket.id];
    if(Object.keys(s.giocatori).length===0){
      if(s.loop) clearInterval(s.loop);
      delete stanze[codice]; return;
    }
    if(s.hostId===socket.id) s.hostId = Object.keys(s.giocatori)[0];
    if(s.stato==='lobby') inviaLobby(codice);
  });
});

function inviaLobby(codice){
  const s = stanze[codice];
  if(!s) return;
  const lista = Object.entries(s.giocatori).map(([id,g])=>({ nome:g.nome, host:id===s.hostId }));
  io.to(codice).emit('lobby', { codice, giocatori:lista, opzioni:s.opzioni });
}

const PORTA = process.env.PORT || 3000;
server.listen(PORTA, ()=>console.log('Server acceso! http://localhost:'+PORTA));
