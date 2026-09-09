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

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const MAX_PLAYERS = 100;
const MAX_CARDS = 200;

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

function cleanLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels.map(v => String(v ?? '').trim().slice(0, 100)).filter(Boolean).slice(0, MAX_CARDS);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    unlockAt: room.unlockAt,
    cardCount: room.cards.length,
    cards: room.cards.map(c => ({ id: c.id, claimed: !!c.claimedBy })),
    players: [...room.players.values()].map(p => ({ name: p.name, picked: p.cardId !== null, online: !!p.socketId })),
    pickedCount: room.cards.filter(c => c.claimedBy).length
  };
}

function hostState(room) {
  return {
    ...publicState(room),
    results: [...room.players.values()].map(p => ({
      name: p.name,
      picked: p.cardId !== null,
      result: p.cardId === null ? null : room.cards[p.cardId]?.label ?? null,
      cardNumber: p.cardId === null ? null : p.cardId + 1,
      online: !!p.socketId
    }))
  };
}

function emitRoom(room) {
  io.to(room.code).emit('roomState', publicState(room));
  if (room.hostSocketId) io.to(room.hostSocketId).emit('hostState', hostState(room));
}

function getRoom(code) {
  return rooms.get(String(code ?? '').trim().toUpperCase());
}

function isHost(socket, room, token) {
  return !!room && room.hostToken === token && room.hostSocketId === socket.id;
}

io.on('connection', socket => {
  socket.on('createRoom', (payload, cb = () => {}) => {
    const hostName = cleanName(payload?.hostName) || '진행자';
    let labels = cleanLabels(payload?.labels);
    if (labels.length < 2) return cb({ ok: false, error: '뽑기 항목을 2개 이상 넣어주세요.' });
    if (payload?.shuffle !== false) labels = shuffle(labels);

    const code = makeCode();
    const hostToken = crypto.randomBytes(24).toString('hex');
    const room = {
      code,
      hostName,
      hostToken,
      hostSocketId: socket.id,
      phase: 'lobby',
      unlockAt: null,
      cards: labels.map((label, id) => ({ id, label, claimedBy: null })),
      players: new Map(),
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
    if (room.phase !== 'lobby' && !room.players.has(playerKey)) return cb({ ok: false, error: '이미 추첨이 시작되어 새로 입장할 수 없어요.' });

    const duplicate = [...room.players.entries()].find(([key, p]) => key !== playerKey && p.name.toLowerCase() === name.toLowerCase());
    if (duplicate) return cb({ ok: false, error: '같은 이름이 이미 있어요. 이름 뒤에 숫자 등을 붙여주세요.' });

    const existing = room.players.get(playerKey);
    const player = existing || { key: playerKey, name, socketId: null, cardId: null, joinedAt: Date.now() };
    player.name = name;
    player.socketId = socket.id;
    room.players.set(playerKey, player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerKey = playerKey;

    const myResult = player.cardId === null ? null : room.cards[player.cardId]?.label ?? null;
    cb({ ok: true, state: publicState(room), myResult, myCardId: player.cardId });
    emitRoom(room);
  });

  socket.on('startCountdown', (payload, cb = () => {}) => {
    const room = getRoom(payload?.code);
    if (!isHost(socket, room, payload?.hostToken)) return cb({ ok: false, error: '진행자 권한이 없어요.' });
    if (room.phase !== 'lobby') return cb({ ok: false, error: '이미 시작했어요.' });
    if (room.players.size < 1) return cb({ ok: false, error: '참가자가 아직 없어요.' });
    if (room.players.size > room.cards.length) return cb({ ok: false, error: `참가자 ${room.players.size}명인데 카드가 ${room.cards.length}개뿐이에요.` });

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
    if (player.cardId !== null) return cb({ ok: false, error: '이미 하나를 뽑았어요.', result: room.cards[player.cardId]?.label ?? null });

    const card = room.cards[cardId];
    if (card.claimedBy) return cb({ ok: false, error: '앗, 방금 다른 사람이 먼저 뽑았어요. 다른 카드를 골라주세요.', taken: true });

    // Node 한 프로세스의 이벤트 루프에서 이 대입이 원자적으로 먼저 처리되어 같은 카드 중복 배정을 막습니다.
    card.claimedBy = playerKey;
    player.cardId = cardId;
    cb({ ok: true, result: card.label, cardId });
    emitRoom(room);

    const allPlayersPicked = room.players.size > 0 && [...room.players.values()].every(p => p.cardId !== null);
    if (allPlayersPicked) {
      room.phase = 'complete';
      emitRoom(room);
    }
  });

  socket.on('resetRoom', (payload, cb = () => {}) => {
    const room = getRoom(payload?.code);
    if (!isHost(socket, room, payload?.hostToken)) return cb({ ok: false, error: '진행자 권한이 없어요.' });
    clearTimeout(room.timer);
    const labels = shuffle(room.cards.map(c => c.label));
    room.cards = labels.map((label, id) => ({ id, label, claimedBy: null }));
    for (const p of room.players.values()) p.cardId = null;
    room.phase = 'lobby';
    room.unlockAt = null;
    emitRoom(room);
    cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    const playerKey = socket.data.playerKey;
    const room = getRoom(roomCode);
    if (room && playerKey && room.players.has(playerKey)) {
      const p = room.players.get(playerKey);
      if (p.socketId === socket.id) p.socketId = null;
      emitRoom(room);
    }
    const hostRoomCode = socket.data.hostRoom;
    const hostRoom = getRoom(hostRoomCode);
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
