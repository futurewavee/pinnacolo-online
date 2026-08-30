const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let matchmakingQueue = null;
const rooms = {};

// Helper carte per il server
const SUITS = ['HEARTS', 'DIAMONDS', 'CLUBS', 'SPADES'];

function createFullDeck() {
  const d = [];
  let idCount = 1;
  for (let p = 1; p <= 2; p++) {
    for (const sKey of SUITS) {
      for (let v = 1; v <= 13; v++) {
        const isMattino = (v === 2 && (sKey === 'SPADES' || sKey === 'CLUBS'));
        let pts = 5;
        if (isMattino) pts = 20;
        else if (v === 1) pts = 15;
        else if (v >= 7 && v <= 13) pts = 10;
        
        d.push({
          id: `c-${idCount++}`,
          val: v,
          suitKey: sKey,
          isJoker: false,
          isMattino,
          points: pts
        });
      }
    }
    d.push({ id: `j-${idCount++}`, val: 0, suitKey: null, isJoker: true, isMattino: false, points: 30 });
    d.push({ id: `j-${idCount++}`, val: 0, suitKey: null, isJoker: true, isMattino: false, points: 30 });
  }
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

io.on('connection', (socket) => {
  console.log('Giocatore connesso:', socket.id);

  // 1. MATCHMAKING
  socket.on('join_matchmaking', (userData) => {
    socket.userData = userData || { name: "Giocatore", score: 1250 };

    if (!matchmakingQueue) {
      matchmakingQueue = socket;
      socket.emit('mm_waiting');
    } else {
      const p1 = matchmakingQueue;
      const p2 = socket;
      matchmakingQueue = null;

      const roomId = `room_${p1.id}_${p2.id}`;
      p1.join(roomId);
      p2.join(roomId);

      const deck = createFullDeck();
      const handSize = 19;
      const p1Hand = deck.splice(0, handSize);
      const p2Hand = deck.splice(0, handSize);
      const initialDiscard = [deck.pop()];
      const starter = Math.random() < 0.5 ? 'p1' : 'p2';

      rooms[roomId] = {
        roomId,
        p1: { socket: p1, name: p1.userData.name, score: p1.userData.score },
        p2: { socket: p2, name: p2.userData.name, score: p2.userData.score },
        deck,
        discardPile: initialDiscard,
        currentTurn: starter
      };

      p1.emit('game_started', {
        roomId,
        role: 'p1',
        yourTurn: starter === 'p1',
        yourHand: p1Hand,
        opponentHandCount: p2Hand.length,
        opponentData: { name: p2.userData.name, score: p2.userData.score, avatar: "👤" },
        discardPile: initialDiscard,
        deckCount: deck.length
      });

      p2.emit('game_started', {
        roomId,
        role: 'p2',
        yourTurn: starter === 'p2',
        yourHand: p2Hand,
        opponentHandCount: p1Hand.length,
        opponentData: { name: p1.userData.name, score: p1.userData.score, avatar: "👤" },
        discardPile: initialDiscard,
        deckCount: deck.length
      });
    }
  });

  socket.on('cancel_matchmaking', () => {
    if (matchmakingQueue === socket) {
      matchmakingQueue = null;
    }
  });

  // 2. AZIONI DI GIOCO ONLINE

  // Pesca dal mazzo
  socket.on('action_draw_deck', (data) => {
    const room = rooms[data.roomId];
    if (!room) return;
    if (room.deck.length === 0) {
      io.to(data.roomId).emit('game_ended', { reason: 'deck_empty' });
      return;
    }
    const drawnCard = room.deck.pop();
    socket.emit('draw_deck_result', { card: drawnCard, deckCount: room.deck.length });
    socket.to(data.roomId).emit('opponent_drew_deck', { deckCount: room.deck.length });
  });

  // Raccogli dagli scarti
  socket.on('action_draw_discard', (data) => {
    const room = rooms[data.roomId];
    if (!room) return;
    const pickedCards = room.discardPile.splice(data.idx);
    socket.emit('draw_discard_result', { pickedCards, discardPile: room.discardPile });
    socket.to(data.roomId).emit('opponent_drew_discard', {
      discardPile: room.discardPile,
      pickedCount: pickedCards.length
    });
  });

  // Nuova calata
  socket.on('action_play_meld', (data) => {
    socket.to(data.roomId).emit('opponent_played_meld', {
      meld: data.meld,
      oppHandCount: data.remainingCards
    });
  });

  // Attacco carta a calata esistente
  socket.on('action_attach_card', (data) => {
    socket.to(data.roomId).emit('opponent_attached_card', {
      meldIndex: data.meldIndex,
      isPlayerTarget: data.isOpponentTarget, // Invertito per chi riceve
      updatedMeld: data.updatedMeld,
      oppHandCount: data.remainingCards
    });
  });

  // Scarto e cambio turno
  socket.on('action_discard', (data) => {
    const room = rooms[data.roomId];
    if (room) {
      room.discardPile.push(data.card);
      socket.to(data.roomId).emit('opponent_discarded', {
        card: data.card,
        discardPile: room.discardPile,
        oppHandCount: data.remainingCards
      });
      // Passa il turno
      socket.emit('set_turn', false);
      socket.to(data.roomId).emit('set_turn', true);
    }
  });

  // Chiusura partita
  socket.on('action_round_closed', (data) => {
    socket.to(data.roomId).emit('round_over_winner', {
      winnerRole: data.winnerRole,
      winnerHand: data.hand
    });
  });

  // Disconnessione
  socket.on('disconnect', () => {
    if (matchmakingQueue === socket) {
      matchmakingQueue = null;
    }
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.p1.socket === socket || room.p2.socket === socket) {
        socket.to(roomId).emit('opponent_disconnected', 'L\'avversario si è disconnesso dalla partita.');
        delete rooms[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Pinnacolo Server online su http://localhost:${PORT}`);
});