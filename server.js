/* ============================================================
   SERVER — l'arbitro centrale del gioco
   ============================================================
   Per ora fa due cose:
     1) crea le "stanze" identificate da un codice
     2) gestisce la lobby (chi entra, chi esce)
   Il gioco vero (movimento, bombe) lo aggiungiamo al passo 2.

   Si avvia dal terminale con:  node server.js
   ============================================================ */

// --- Carichiamo le librerie che ci servono ---
const express = require('express');                 // per servire le pagine web
const http    = require('http');
const { Server } = require('socket.io');            // per parlare in tempo reale
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// Serviamo i file del client (tutto ciò che sta nella cartella "public")
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------
   Qui dentro teniamo TUTTE le stanze aperte.
   La chiave è il codice (es. "GHKP"), il valore sono i dati.
   ------------------------------------------------------------ */
const stanze = {};

// Genera un codice di 4 lettere, tipo "GHKP".
// Evitiamo I, O, 0, 1 perché si confondono leggendoli.
function generaCodice(){
  const lettere = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let codice;
  do {
    codice = '';
    for(let i = 0; i < 4; i++){
      codice += lettere[Math.floor(Math.random() * lettere.length)];
    }
  } while(stanze[codice]);   // nell'improbabile caso esista già, riprova
  return codice;
}

/* ------------------------------------------------------------
   Ogni volta che un browser si collega, entriamo qui dentro.
   "socket" è il filo diretto con QUEL singolo giocatore.
   ------------------------------------------------------------ */
io.on('connection', (socket) => {
  console.log('Collegato:', socket.id);

  /* --- CREA PARTITA -------------------------------------- */
  socket.on('creaPartita', (nome) => {
    const codice = generaCodice();
    stanze[codice] = {
      codice,
      hostId: socket.id,        // chi ha creato la stanza comanda
      giocatori: {},            // qui mettiamo tutti i partecipanti
      stato: 'lobby'            // lobby -> gioco -> fine
    };
    stanze[codice].giocatori[socket.id] = { nome: nome || 'Host' };

    socket.join(codice);          // <-- la stanza di Socket.IO È il nostro codice!
    socket.data.codice = codice;  // ci ricordiamo dove sta questo giocatore

    socket.emit('partitaCreata', codice);   // rispondiamo a chi ha creato
    inviaLobby(codice);
  });

  /* --- ENTRA CON UN CODICE ------------------------------- */
  socket.on('entra', ({ codice, nome }) => {
    codice = (codice || '').toUpperCase();
    const stanza = stanze[codice];

    // controlli: codice giusto? partita non ancora iniziata? non piena?
    if(!stanza){               socket.emit('erroreEntrata', 'Codice non valido'); return; }
    if(stanza.stato !== 'lobby'){ socket.emit('erroreEntrata', 'La partita è già iniziata'); return; }
    if(Object.keys(stanza.giocatori).length >= 4){ socket.emit('erroreEntrata', 'La stanza è piena'); return; }

    stanza.giocatori[socket.id] = { nome: nome || 'Giocatore' };
    socket.join(codice);
    socket.data.codice = codice;

    socket.emit('entrato', codice);
    inviaLobby(codice);
  });

  /* --- AVVIA LA PARTITA (solo l'host può) ---------------- */
  socket.on('avvia', () => {
    const codice = socket.data.codice;
    const stanza = stanze[codice];
    if(!stanza || stanza.hostId !== socket.id) return;   // solo l'host
    if(Object.keys(stanza.giocatori).length < 2) return; // servono almeno 2

    stanza.stato = 'gioco';
    io.to(codice).emit('iniziata');
    // PASSO 2: qui dentro faremo partire la partita vera e propria.
  });

  /* --- QUALCUNO SI SCOLLEGA ------------------------------ */
  socket.on('disconnect', () => {
    const codice = socket.data.codice;
    const stanza = stanze[codice];
    if(!stanza) return;

    delete stanza.giocatori[socket.id];

    // se non resta più nessuno, buttiamo via la stanza
    if(Object.keys(stanza.giocatori).length === 0){
      delete stanze[codice];
      return;
    }
    // se se n'è andato l'host, promuoviamo il primo rimasto
    if(stanza.hostId === socket.id){
      stanza.hostId = Object.keys(stanza.giocatori)[0];
    }
    inviaLobby(codice);
  });
});

/* ------------------------------------------------------------
   Manda a TUTTI nella stanza la lista aggiornata dei giocatori.
   io.to(codice) = "parla solo a chi è in questa stanza".
   ------------------------------------------------------------ */
function inviaLobby(codice){
  const stanza = stanze[codice];
  if(!stanza) return;
  const lista = Object.entries(stanza.giocatori).map(([id, g]) => ({
    nome: g.nome,
    host: id === stanza.hostId
  }));
  io.to(codice).emit('lobby', { codice, giocatori: lista });
}

// --- Accendiamo il server ---
const PORTA = process.env.PORT || 3000;
server.listen(PORTA, () => {
  console.log('Server acceso! Apri il browser su http://localhost:' + PORTA);
});
