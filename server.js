const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Code di matchmaking separate per formato e target
const matchmakingQueues = {};
const rooms = {};

let globalLeaderboard = [
  { name: "Ghirlandina_King", city: "modena", trophies: 2450, wins: 142, losses: 38 },
  { name: "Luciano_Sassuolo", city: "sassuolo", trophies: 1820, wins: 95, losses: 41 },
  { name: "Elena_Vignola", city: "vignola", trophies: 1240, wins: 62, losses: 30 },
  { name: "Marco_Carpi", city: "carpi", trophies: 720, wins: 34, losses: 18 },
  { name: "Franco_Nonantola", city: "nonantola", trophies: 280, wins: 12, losses: 5 }
];

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
        
        d.push({ id: `c-${idCount++}`, val: v, suitKey: sKey, isJoker: false, isMattino, points: pts });
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
  socket.emit('leaderboard_update', globalLeaderboard);

  socket.on('sync_profile', (userData) => {
    socket.userData = userData;
    const existing = globalLeaderboard.find(u => u.name.toLowerCase() === userData.name.toLowerCase());
    if (existing) {
      existing.trophies = userData.trophies;
      existing.wins = userData.wins;
      existing.losses = userData.losses;
      existing.city = userData.city;
    } else {
      globalLeaderboard.push({
        name: userData.name,
        city: userData.city || 'modena',
        trophies: userData.trophies,
        wins: userData.wins,
        losses: userData.losses
      });
    }
    globalLeaderboard.sort((a, b) => b.trophies - a.trophies);
    io.emit('leaderboard_update', globalLeaderboard);
  });

  socket.on('join_matchmaking', (params) => {
    socket.userData = params.user || { name: "Giocatore", trophies: 0, city: "modena" };
    const queueKey = `${params.handSize || 19}_${params.targetScore || 'quick'}`;

    if (!matchmakingQueues[queueKey]) {
      matchmakingQueues[queueKey] = socket;
      socket.currentQueueKey = queueKey;
      socket.emit('mm_waiting');
    } else {
      const p1 = matchmakingQueues[queueKey];
      const p2 = socket;
      delete matchmakingQueues[queueKey];
      p1.currentQueueKey = null;
      p2.currentQueueKey = null;

      const roomId = `room_${p1.id}_${p2.id}`;
      p1.join(roomId);
      p2.join(roomId);

      const handSize = params.handSize === 33 ? 33 : 19;
      const deck = createFullDeck();
      const p1Hand = deck.splice(0, handSize);
      const p2Hand = deck.splice(0, handSize);
      const initialDiscard = [deck.pop()];
      const starter = Math.random() < 0.5 ? 'p1' : 'p2';

      rooms[roomId] = {
        roomId,
        handSize,
        targetScore: params.targetScore,
        p1: { socket: p1, data: p1.userData, matchScore: 0 },
        p2: { socket: p2, data: p2.userData, matchScore: 0 },
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
        opponentData: p2.userData,
        discardPile: initialDiscard,
        deckCount: deck.length,
        handSize,
        targetScore: params.targetScore
      });

      p2.emit('game_started', {
        roomId,
        role: 'p2',
        yourTurn: starter === 'p2',
        yourHand: p2Hand,
        opponentHandCount: p1Hand.length,
        opponentData: p1.userData,
        discardPile: initialDiscard,
        deckCount: deck.length,
        handSize,
        targetScore: params.targetScore
      });
    }
  });

  socket.on('cancel_matchmaking', () => {
    if (socket.currentQueueKey && matchmakingQueues[socket.currentQueueKey] === socket) {
      delete matchmakingQueues[socket.currentQueueKey];
      socket.currentQueueKey = null;
    }
  });

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

  socket.on('action_play_meld', (data) => {
    socket.to(data.roomId).emit('opponent_played_meld', {
      meld: data.meld,
      oppHandCount: data.remainingCards
    });
  });

  socket.on('action_attach_card', (data) => {
    socket.to(data.roomId).emit('opponent_attached_card', {
      meldIndex: data.meldIndex,
      isPlayerTarget: data.isOpponentTarget,
      updatedMeld: data.updatedMeld,
      oppHandCount: data.remainingCards
    });
  });

  socket.on('action_discard', (data) => {
    const room = rooms[data.roomId];
    if (room) {
      room.discardPile.push(data.card);
      socket.to(data.roomId).emit('opponent_discarded', {
        card: data.card,
        discardPile: room.discardPile,
        oppHandCount: data.remainingCards
      });
      socket.emit('set_turn', false);
      socket.to(data.roomId).emit('set_turn', true);
    }
  });

  socket.on('action_round_closed', (data) => {
    socket.to(data.roomId).emit('round_over_winner', {
      winnerRole: data.winnerRole,
      isSecca: data.isSecca
    });
  });

  socket.on('start_next_round', (data) => {
    const room = rooms[data.roomId];
    if (!room) return;
    const deck = createFullDeck();
    const p1Hand = deck.splice(0, room.handSize);
    const p2Hand = deck.splice(0, room.handSize);
    const initialDiscard = [deck.pop()];
    const starter = Math.random() < 0.5 ? 'p1' : 'p2';

    room.deck = deck;
    room.discardPile = initialDiscard;
    room.currentTurn = starter;

    room.p1.socket.emit('next_round_started', {
      yourTurn: starter === 'p1',
      yourHand: p1Hand,
      opponentHandCount: p2Hand.length,
      discardPile: initialDiscard,
      deckCount: deck.length
    });

    room.p2.socket.emit('next_round_started', {
      yourTurn: starter === 'p2',
      yourHand: p2Hand,
      opponentHandCount: p1Hand.length,
      discardPile: initialDiscard,
      deckCount: deck.length
    });
  });

  socket.on('disconnect', () => {
    if (socket.currentQueueKey && matchmakingQueues[socket.currentQueueKey] === socket) {
      delete matchmakingQueues[socket.currentQueueKey];
    }
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.p1.socket === socket || room.p2.socket === socket) {
        socket.to(roomId).emit('opponent_disconnected', "L'avversario si è disconnesso.");
        delete rooms[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pinnacolo Server online su http://localhost:${PORT}`));