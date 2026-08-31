const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const io = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.RECONNECT_LIVE_TEST_PORT || 18089);
const URL = 'http://127.0.0.1:' + PORT;

function waitForStart(output) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (output().includes('server is running on port ' + PORT)) return resolve();
      if (Date.now() - started > 7000) return reject(new Error('等待断线恢复服务启动超时'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function waitEvent(socket, eventName, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error('等待事件超时：' + eventName));
    }, timeoutMs);
    const onEvent = data => {
      clearTimeout(timer);
      socket.off(eventName, onEvent);
      resolve(data);
    };
    socket.once(eventName, onEvent);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectUser(name, guestId, sockets) {
  const socket = io(URL, { transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  await waitEvent(socket, 'connect');
  const login = waitEvent(socket, 'LOGIN_SUCCESS');
  socket.emit('LOGIN', { userName: name, guestId });
  await login;
  return socket;
}

async function startRoom(gameType, name, guestId, sockets) {
  const owner = await connectUser(name, guestId, sockets);
  const createdEvent = waitEvent(owner, 'ROOM_CREATED');
  owner.emit('CREATE_ROOM', { gameType, isPrivate: false });
  const room = await createdEvent;
  const sitEvent = waitEvent(owner, 'SITDOWN_SUCCESS');
  owner.emit('SITDOWN', { deskId: room.deskId, posId: 0 });
  await sitEvent;

  // AI 填满其余座位，让每种玩法都进入真实对局状态，随后测试恢复快照。
  owner.emit('ADD_BOTS');
  await delay(80);
  const gameStart = waitEvent(owner, 'GAME_START', 8000);
  const prepare = waitEvent(owner, 'PREPARE_SUCCESS');
  owner.emit('PREPARE');
  await prepare;
  await gameStart;
  return { owner, room };
}

async function auditPlayerResume(gameType, sockets) {
  const suffix = gameType + '-' + process.pid;
  const name = '断线恢复玩家-' + suffix;
  const guestId = 'reconnect-player-' + suffix;
  const started = await startRoom(gameType, name, guestId, sockets);
  const oldSocket = started.owner;

  oldSocket.disconnect();
  // 等待服务端完成断线处理并建立暂停/回归槽。
  await delay(180);

  const replacement = await connectUser(name, guestId, sockets);
  const resumeSuccess = waitEvent(replacement, 'SITDOWN_SUCCESS');
  const gameResumed = waitEvent(replacement, 'GAME_RESUMED');
  replacement.emit('RESUME_ROOM', {
    mode: 'player',
    deskId: started.room.deskId,
    roomCode: started.room.roomCode,
    posId: 0,
    gameType,
  });
  const payload = await resumeSuccess;
  await gameResumed;

  assert.strictEqual(payload.resumed, true, gameType + ' 玩家恢复未标记 resumed');
  assert.strictEqual(Number(payload.posId), 0, gameType + ' 玩家未恢复原座位');
  assert.strictEqual(payload.gameType, gameType, gameType + ' 恢复玩法不一致');
  assert.strictEqual(payload.gameInProgress, true, gameType + ' 恢复后未识别进行中的牌局');
  assert(payload.snapshot, gameType + ' 恢复没有返回当前牌局快照');
  assert(payload.paused === null || payload.paused, gameType + ' 恢复暂停字段异常');
  return { gameType, resumedPosId: Number(payload.posId), hasSnapshot: !!payload.snapshot };
}

async function auditSpectatorResume(gameType, sockets) {
  const suffix = gameType + '-' + process.pid;
  const ownerName = '观战恢复房主-' + suffix;
  const ownerId = 'reconnect-owner-' + suffix;
  const spectatorName = '观战恢复观众-' + suffix;
  const spectatorId = 'reconnect-spectator-' + suffix;
  const started = await startRoom(gameType, ownerName, ownerId, sockets);

  const spectator = await connectUser(spectatorName, spectatorId, sockets);
  const spectateSuccess = waitEvent(spectator, 'SPECTATE_SUCCESS');
  spectator.emit('SPECTATE', { deskId: started.room.deskId });
  await spectateSuccess;
  spectator.disconnect();
  await delay(120);

  const replacement = await connectUser(spectatorName, spectatorId, sockets);
  const resume = waitEvent(replacement, 'SPECTATE_SUCCESS');
  replacement.emit('RESUME_ROOM', {
    mode: 'spectator',
    deskId: started.room.deskId,
    roomCode: started.room.roomCode,
    posId: 'spec',
    gameType,
  });
  const payload = await resume;
  assert.strictEqual(payload.resumed, true, gameType + ' 观战恢复未标记 resumed');
  assert.strictEqual(payload.gameType, gameType, gameType + ' 观战恢复玩法不一致');
  assert.strictEqual(Number(payload.positions.length), gameType === 'doudizhu' ? 3 : 4, gameType + ' 观战恢复座位不完整');
  assert(payload.snapshot, gameType + ' 观战恢复没有当前快照');
  return { gameType, resumed: true, positions: payload.positions.length };
}

async function run() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DB_DISABLE: '1',
      NODE_ENV: 'test',
      JWT_SECRET: 'reconnect-live-test-secret',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const sockets = [];

  try {
    await waitForStart(() => stdout);
    const player = [];
    const spectator = [];
    for (const [gameType] of [['doudizhu'], ['guandan'], ['mahjong']]) {
      player.push(await auditPlayerResume(gameType, sockets));
      spectator.push(await auditSpectatorResume(gameType, sockets));
    }
    console.log('Reconnect live regression tests passed: player and spectator state resumes in all three game modes.');
    if (process.env.RECONNECT_LIVE_TEST_VERBOSE === '1') console.log(JSON.stringify({ player, spectator }));
  } finally {
    sockets.forEach(socket => {
      try { socket.disconnect(); } catch (error) {}
    });
    if (child && !child.killed) child.kill();
  }
  if (stderr && /EADDRINUSE|SyntaxError|TypeError/.test(stderr)) {
    throw new Error('断线恢复服务异常：' + stderr.slice(-1600));
  }
}

run().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
