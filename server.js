/* ============================================================
   SERVER — l'arbitro centrale del gioco
   ============================================================
   Ora fa TUTTO:
     1) crea le stanze con un codice (lobby)
     2) tiene la mappa, i giocatori, le bombe e le esplosioni
     3) ad ogni "tick" aggiorna la partita e manda la fotografia
        a tutti i giocatori della stanza

   I telefoni non decidono niente: mandano solo "mi muovo" o
   "piazzo una bomba". La verità sta qui.

   Avvio:  node server.js
   ============================================================ */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io      = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   CONFIGURAZIONE (gli stessi numeri del gioco offline)
   ============================================================ */
const COLONNE = 13;
const RIGHE   = 11;
const RAGGIO_BOMBA = 2;
const TEMPO_BOMBA  = 2200;   // ms prima dell'esplosione
const TEMPO_FIAMMA = 500;    // ms di durata della fiamma
const PASSO_MS     = 140;    // ms tra un passo e l'altro
const TICK_MS      = 60;     // ogni quanto il server aggiorna la partita

const VUOTO = 0, MURO = 1, CASSA = 2;

// I quattro angoli dove nascono i giocatori
const ANGOLI = [
  { x: 1,           y: 1 },
  { x: COLONNE - 2, y: 1 },
  { x: 1,           y: RIGHE - 2 },
  { x: COLONNE - 2, y: RIGHE - 2 }
];
// Quattro colori, uno per giocatore (in ordine di ingresso)
const COLORI = ['#41a6f6', '#ff5d5d', '#5ddf7a', '#ffd454'];

const stanze = {};

function generaCodice(){
  const lettere = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let codice;
  do {
    codice = '';
    for(let i = 0; i < 4; i++) codice += lettere[Math.floor(Math.random() * lettere.length)];
  } while(stanze[codice]);
  return codice;
}

/* ============================================================
   COSTRUZIONE DELLA MAPPA (uguale alla versione offline)
   ============================================================ */
function creaMappa(){
  const mappa = [];
  for(let y = 0; y < RIGHE; y++){
    const riga = [];
    for(let x = 0; x < COLONNE; x++){
      if(x === 0 || y === 0 || x === COLONNE-1 || y === RIGHE-1) riga.push(MURO);
      else if(x % 2 === 0 && y % 2 === 0) riga.push(MURO);
      else riga.push(VUOTO);
    }
    mappa.push(riga);
  }
  // casse a caso, ma lasciando liberi tutti e quattro gli angoli
  for(let y = 1; y < RIGHE-1; y++){
    for(let x = 1; x < COLONNE-1; x++){
      if(mappa[y][x] !== VUOTO) continue;
      if(angoloLibero(x, y)) continue;
      if(Math.random() < 0.78) mappa[y][x] = CASSA;
    }
  }
  return mappa;
}
// Tiene liberi l'angolo e le due caselle accanto, per ogni angolo
function angoloLibero(x, y){
  return ANGOLI.some(a => {
    const versoX = a.x === 1 ? 1 : -1;
    const versoY = a.y === 1 ? 1 : -1;
    return (x === a.x && y === a.y) ||
           (x === a.x + versoX && y === a.y) ||
           (x === a.x && y === a.y + versoY);
  });
}

/* ============================================================
   AVVIO DELLA PARTITA per una stanza
   ============================================================ */
function avviaPartita(stanza){
  stanza.mappa  = creaMappa();
  stanza.bombe  = [];
  stanza.fiamme = [];
  stanza.stato  = 'gioco';

  // mettiamo ogni giocatore nel suo angolo, vivo
  const ids = Object.keys(stanza.giocatori);
  ids.forEach((id, i) => {
    const g = stanza.giocatori[id];
    const angolo = ANGOLI[i % 4];
    g.x = angolo.x;
    g.y = angolo.y;
    g.colore = COLORI[i % 4];
    g.vivo = true;
    g.dir = null;          // direzione tenuta premuta
    g.ultimoPasso = 0;
  });

  io.to(stanza.codice).emit('iniziata');

  // facciamo partire il "battito" della partita
  if(stanza.loop) clearInterval(stanza.loop);
  stanza.ultimoIstante = Date.now();
  stanza.loop = setInterval(() => aggiornaPartita(stanza), TICK_MS);
}

/* ============================================================
   IL TICK: il battito che fa avanzare la partita
   ============================================================ */
function aggiornaPartita(stanza){
  if(stanza.stato !== 'gioco') return;
  const ora = Date.now();
  const delta = ora - stanza.ultimoIstante;
  stanza.ultimoIstante = ora;

  // 1) movimento dei giocatori che tengono premuta una direzione
  for(const id in stanza.giocatori){
    const g = stanza.giocatori[id];
    if(g.vivo && g.dir && ora - g.ultimoPasso > PASSO_MS){
      muovi(stanza, g, g.dir);
      g.ultimoPasso = ora;
    }
  }

  // 2) timer delle bombe
  for(const b of stanza.bombe){
    b.tempo -= delta;
    if(b.tempo <= 0) esplodi(stanza, b);
  }
  stanza.bombe = stanza.bombe.filter(b => b.tempo > 0);

  // 3) timer delle fiamme
  for(const f of stanza.fiamme) f.tempo -= delta;
  stanza.fiamme = stanza.fiamme.filter(f => f.tempo > 0);

  // 4) c'è un vincitore?
  const vivi = Object.values(stanza.giocatori).filter(g => g.vivo);
  if(vivi.length <= 1){
    finePartita(stanza, vivi[0]);
    return;
  }

  // 5) mandiamo la fotografia aggiornata a tutti
  io.to(stanza.codice).emit('stato', fotografia(stanza));
}

function muovi(stanza, g, dir){
  let nx = g.x, ny = g.y;
  if(dir === 'su') ny--; else if(dir === 'giu') ny++;
  else if(dir === 'sx') nx--; else if(dir === 'dx') nx++;
  // si può andare solo su pavimento libero e senza bombe
  if(stanza.mappa[ny][nx] !== VUOTO) return;
  if(stanza.bombe.some(b => b.x === nx && b.y === ny)) return;
  g.x = nx; g.y = ny;
}

function esplodi(stanza, bomba){
  const colpite = [{ x: bomba.x, y: bomba.y }];
  for(const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
    for(let p = 1; p <= RAGGIO_BOMBA; p++){
      const x = bomba.x + dx*p, y = bomba.y + dy*p;
      if(stanza.mappa[y][x] === MURO) break;
      colpite.push({ x, y });
      if(stanza.mappa[y][x] === CASSA){ stanza.mappa[y][x] = VUOTO; break; }
    }
  }
  for(const c of colpite){
    stanza.fiamme.push({ x: c.x, y: c.y, tempo: TEMPO_FIAMMA });
    // reazione a catena: il fuoco fa esplodere altre bombe
    const altra = stanza.bombe.find(b => b.x === c.x && b.y === c.y && b.tempo > 0);
    if(altra) altra.tempo = 0;
    // chi viene preso dal fuoco muore
    for(const id in stanza.giocatori){
      const g = stanza.giocatori[id];
      if(g.vivo && g.x === c.x && g.y === c.y) g.vivo = false;
    }
  }
}

function finePartita(stanza, vincitore){
  stanza.stato = 'lobby';
  if(stanza.loop){ clearInterval(stanza.loop); stanza.loop = null; }
  io.to(stanza.codice).emit('fine', {
    vincitore: vincitore ? vincitore.nome : null   // null = pareggio
  });
}

// Prepara la "fotografia" della partita da mandare ai client
function fotografia(stanza){
  return {
    mappa: stanza.mappa,
    giocatori: Object.entries(stanza.giocatori).map(([id, g]) => ({
      id, nome: g.nome, x: g.x, y: g.y, colore: g.colore, vivo: g.vivo
    })),
    bombe:  stanza.bombe.map(b => ({ x: b.x, y: b.y, tempo: b.tempo })),
    fiamme: stanza.fiamme.map(f => ({ x: f.x, y: f.y }))
  };
}

/* ============================================================
   CONNESSIONI
   ============================================================ */
io.on('connection', (socket) => {

  socket.on('creaPartita', (nome) => {
    const codice = generaCodice();
    stanze[codice] = { codice, hostId: socket.id, giocatori: {}, stato: 'lobby', loop: null };
    stanze[codice].giocatori[socket.id] = { nome: nome || 'Host' };
    socket.join(codice);
    socket.data.codice = codice;
    socket.emit('partitaCreata', codice);
    inviaLobby(codice);
  });

  socket.on('entra', ({ codice, nome }) => {
    codice = (codice || '').toUpperCase();
    const stanza = stanze[codice];
    if(!stanza){ socket.emit('erroreEntrata', 'Codice non valido'); return; }
    if(stanza.stato !== 'lobby'){ socket.emit('erroreEntrata', 'La partita è già iniziata'); return; }
    if(Object.keys(stanza.giocatori).length >= 4){ socket.emit('erroreEntrata', 'La stanza è piena'); return; }
    stanza.giocatori[socket.id] = { nome: nome || 'Giocatore' };
    socket.join(codice);
    socket.data.codice = codice;
    socket.emit('entrato', codice);
    inviaLobby(codice);
  });

  socket.on('avvia', () => {
    const stanza = stanze[socket.data.codice];
    if(!stanza || stanza.hostId !== socket.id) return;
    if(Object.keys(stanza.giocatori).length < 2) return;
    avviaPartita(stanza);
  });

  // --- INGRESSO COMANDI DAL GIOCATORE ---
  socket.on('muovi', (dir) => {
    const stanza = stanze[socket.data.codice];
    if(!stanza || stanza.stato !== 'gioco') return;
    const g = stanza.giocatori[socket.id];
    if(!g || !g.vivo) return;
    g.dir = dir;                 // dir = 'su'/'giu'/'sx'/'dx' oppure null (fermo)
    if(dir){ muovi(stanza, g, dir); g.ultimoPasso = Date.now(); } // primo passo subito
  });

  socket.on('bomba', () => {
    const stanza = stanze[socket.data.codice];
    if(!stanza || stanza.stato !== 'gioco') return;
    const g = stanza.giocatori[socket.id];
    if(!g || !g.vivo) return;
    if(stanza.bombe.some(b => b.x === g.x && b.y === g.y)) return;
    stanza.bombe.push({ x: g.x, y: g.y, tempo: TEMPO_BOMBA });
  });

  socket.on('disconnect', () => {
    const codice = socket.data.codice;
    const stanza = stanze[codice];
    if(!stanza) return;
    delete stanza.giocatori[socket.id];
    if(Object.keys(stanza.giocatori).length === 0){
      if(stanza.loop) clearInterval(stanza.loop);
      delete stanze[codice];
      return;
    }
    if(stanza.hostId === socket.id) stanza.hostId = Object.keys(stanza.giocatori)[0];
    if(stanza.stato === 'lobby') inviaLobby(codice);
  });
});

function inviaLobby(codice){
  const stanza = stanze[codice];
  if(!stanza) return;
  const lista = Object.entries(stanza.giocatori).map(([id, g]) => ({
    nome: g.nome, host: id === stanza.hostId
  }));
  io.to(codice).emit('lobby', { codice, giocatori: lista });
}

const PORTA = process.env.PORT || 3000;
server.listen(PORTA, () => console.log('Server acceso! http://localhost:' + PORTA));
