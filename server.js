import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 20000, pingInterval: 25000 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const GAMES = [
  { rank: '4등', prize: '오덴세 무드 조명', winners: 3, image: '/images/4th.jpeg' },
  { rank: '3등', prize: '천지연 20만원 식사권', winners: 1, image: '/images/3rd.jpeg' },
  { rank: '2등', prize: '신세계 상품권 30만원권', winners: 1, image: '/images/2nd.jpeg' },
  { rank: '1등', prize: '마샬 액톤4 (완전 신상!!)', winners: 1, image: '/images/1st.jpeg' }
];

const rooms = new Map();
const MAX_PLAYERS = 100;

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
}

function cleanName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
}

function getRoom(code) {
  return rooms.get(String(code ?? '').trim().toUpperCase());
}

function isHost(socket, room, token) {
  return !!room && room.hostToken === token && room.hostSocketId === socket.id;
}

function randomWinnerCardIds(cardCount, winnerCount) {
  const ids = Array.from({ length: cardCount }, (_, i) => i);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, winnerCount);
}

function currentGame(room) {
  return room.gameIndex >= 0 && room.gameIndex < GAMES.length ? GAMES[room.gameIndex] : null;
}

function gameHistory(room) {
  return room.history.map(h => ({ gameIndex: h.gameIndex, rank: GAMES[h.gameIndex].rank, prize: GAMES[h.gameIndex].prize, winners: h.winners }));
}

function publicState(room) {
  const game = currentGame(room);
  const cards = room.cards.map(c => ({ id: c.id, claimed: !!c.claimedBy }));
  const reveal = room.phase === 'reveal' || room.phase === 'finished';
  return {
    code: room.code,
    phase: room.phase,
    gameIndex: room.gameIndex,
    game: game ? { ...game } : null,
    totalGames: GAMES.length,
    unlockAt: room.unlockAt,
    cards,
    cardCount: cards.length,
    playerCount: room.players.size,
    pickedCount: [...room.players.values()].filter(p => p.pickByGame[room.gameIndex] !== undefined).length,
    players: [...room.players.values()].map(p => ({ name: p.name, online: !!p.socketId, picked: p.pickByGame[room.gameIndex] !== undefined })),
    winners: reveal ? room.currentWinners : [],
    history: gameHistory(room),
    rosterLocked: room.rosterLocked
  };
}

function hostState(room) {
  return publicState(room);
}

function emitRoom(room) {
  io.to(room.code).emit('roomState', publicState(room));
  if (room.hostSocketId) io.to(room.hostSocketId).emit('hostState', hostState(room));
}

function prepareGame(room, gameIndex) {
  room.gameIndex = gameIndex;
  room.phase = 'intro';
  room.unlockAt = null;
  room.cards = [];
  room.winningCardIds = [];
  room.currentWinners = [];
  for (const p of room.players.values()) delete p.pickByGame[gameIndex];
}

function completeIfReady(room) {
  if (room.phase !== 'drawing' || room.players.size === 0) return;
  const everyonePicked = [...room.players.values()].every(p => p.pickByGame[room.gameIndex] !== undefined);
  if (!everyonePicked) return;

  const winners = [];
  for (const p of room.players.values()) {
    const cardId = p.pickByGame[room.gameIndex];
    if (room.winningCardIds.includes(cardId)) winners.push({ name: p.name, cardNumber: cardId + 1 });
  }
  winners.sort((a, b) => a.cardNumber - b.cardNumber);
  room.currentWinners = winners;
  room.history.push({ gameIndex: room.gameIndex, winners });
  room.phase = room.gameIndex === GAMES.length - 1 ? 'finished' : 'reveal';
  emitRoom(room);
}

io.on('connection', socket => {
  socket.on('createRoom', (payload, cb = () => {}) => {
    const hostName = cleanName(payload?.hostName) || '진행자';
    const code = makeCode();
    const hostToken = crypto.randomBytes(24).toString('hex');
    const room = {
      code,
      hostName,
      hostToken,
      hostSocketId: socket.id,
      phase: 'intro',
      gameIndex: 0,
      unlockAt: null,
      cards: [],
      winningCardIds: [],
      currentWinners: [],
      players: new Map(),
      rosterLocked: false,
      history: [],
      createdAt: Date.now(),
      timer: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.hostRoom = code;
    cb({ ok: true, code, hostToken, state: hostState(room) });
  });

  socket.on('resumeHost', (payload, cb = () => {}) => {
    const room = getRoom(payload?.code);
    if (!room || room.hostToken !== payload?.hostToken) return cb({ ok: false, error: '진행자 세션을 복구할 수 없어요.' });
    room.hostSocketId = socket.id;
    socket.join(room.code);
    socket.data.hostRoom = room.code;
    cb({ ok: true, state: hostState(room) });
    emitRoom(room);
  });

  socket.on('joinRoom', (payload, cb = () => {}) => {
    const room = getRoom(payload?.code);
    const name = cleanName(payload?.name);
    const playerKey = String(payload?.playerKey ?? '').slice(0, 100);
    if (!room) return cb({ ok: false, error: '방을 찾을 수 없어요. 방 코드를 확인해주세요.' });
    if (!name) return cb({ ok: false, error: '이름을 입력해주세요.' });
    if (!playerKey) return cb({ ok: false, error: '참가자 식별값이 없어요. 새로고침 후 다시 시도해주세요.' });
    if (!room.players.has(playerKey) && room.players.size >= MAX_PLAYERS) return cb({ ok: false, error: '참가 인원이 가득 찼어요.' });
    if (room.rosterLocked && !room.players.has(playerKey)) return cb({ ok: false, error: '첫 게임이 시작되어 새 참가자는 입장할 수 없어요.' });

    const duplicate = [...room.players.entries()].find(([key, p]) => key !== playerKey && p.name.toLowerCase() === name.toLowerCase());
    if (duplicate) return cb({ ok: false, error: '같은 이름이 이미 있어요. 이름 뒤에 숫자 등을 붙여주세요.' });

    const existing = room.players.get(playerKey);
    const player = existing || { key: playerKey, name, socketId: null, joinedAt: Date.now(), pickByGame: {} };
    player.name = name;
    player.socketId = socket.id;
    room.players.set(playerKey, player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerKey = playerKey;

    cb({ ok: true, state: publicState(room), myPick: player.pickByGame[room.gameIndex] ?? null });
    emitRoom(room);
  });

  socket.on('startCountdown', (payload, cb = () => {}) => {
    const room = getRoom(payload?.code);
    if (!isHost(socket, room, payload?.hostToken)) return cb({ ok: false, error: '진행자 권한이 없어요.' });
    if (room.phase !== 'intro') return cb({ ok: false, error: '지금은 시작할 수 없는 상태예요.' });
    const game = currentGame(room);
    if (!game) return cb({ ok: false, error: '게임 정보를 찾을 수 없어요.' });
    if (room.players.size < game.winners) return cb({ ok: false, error: `${game.rank}은 당첨자가 ${game.winners}명이라 참가자가 최소 ${game.winners}명 필요해요.` });

    if (room.gameIndex === 0) room.rosterLocked = true;
    const cardCount = room.players.size;
    room.cards = Array.from({ length: cardCount }, (_, id) => ({ id, claimedBy: null }));
    room.winningCardIds = randomWinnerCardIds(cardCount, game.winners);
    room.currentWinners = [];
    for (const p of room.players.values()) delete p.pickByGame[room.gameIndex];

    room.phase = 'countdown';
    room.unlockAt = Date.now() + 3600;
    emitRoom(room);
    clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      if (!rooms.has(room.code)) return;
      room.phase = 'drawing';
      room.unlockAt = Date.now();
      emitRoom(room);
    }, 3600);
    cb({ ok: true });
  });

  socket.on('pickCard', (payload, cb = () => {}) => {
    const room = getRoom(payload?.code);
    const playerKey = socket.data.playerKey;
    const player = room?.players.get(playerKey);
    const cardId = Number(payload?.cardId);
    if (!room || !player || player.socketId !== socket.id) return cb({ ok: false, error: '참가자 정보를 확인할 수 없어요.' });
    if (room.phase !== 'drawing') return cb({ ok: false, error: '아직 뽑기 시간이 아니에요.' });
    if (!Number.isInteger(cardId) || cardId < 0 || cardId >= room.cards.length) return cb({ ok: false, error: '잘못된 카드예요.' });
    if (player.pickByGame[room.gameIndex] !== undefined) return cb({ ok: false, error: '이번 게임에서는 이미 하나를 골랐어요.' });

    const card = room.cards[cardId];
    if (card.claimedBy) return cb({ ok: false, error: '앗, 방금 다른 사람이 먼저 골랐어요. 다른 카드를 눌러주세요.', taken: true });

    card.claimedBy = playerKey;
    player.pickByGame[room.gameIndex] = cardId;
    cb({ ok: true, cardId });
    emitRoom(room);
    completeIfReady(room);
  });

  socket.on('nextGame', (payload, cb = () => {}) => {
    const room = getRoom(payload?.code);
    if (!isHost(socket, room, payload?.hostToken)) return cb({ ok: false, error: '진행자 권한이 없어요.' });
    if (room.phase !== 'reveal') return cb({ ok: false, error: '현재 게임 결과 공개가 끝난 뒤 넘어갈 수 있어요.' });
    const next = room.gameIndex + 1;
    if (next >= GAMES.length) return cb({ ok: false, error: '모든 게임이 끝났어요.' });
    prepareGame(room, next);
    emitRoom(room);
    cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket.data.roomCode);
    const playerKey = socket.data.playerKey;
    if (room && playerKey && room.players.has(playerKey)) {
      const p = room.players.get(playerKey);
      if (p.socketId === socket.id) p.socketId = null;
      emitRoom(room);
    }
    const hostRoom = getRoom(socket.data.hostRoom);
    if (hostRoom && hostRoom.hostSocketId === socket.id) hostRoom.hostSocketId = null;
  });
});

setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.createdAt < cutoff) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Group Draw running on port ${PORT}`));
