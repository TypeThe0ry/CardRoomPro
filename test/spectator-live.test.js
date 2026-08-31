const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const io = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SPECTATOR_LIVE_TEST_PORT || 18086);
const URL = 'http://127.0.0.1:' + PORT;

function waitForStart(output) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (output().includes('server is running on port ' + PORT)) return resolve();
      if (Date.now() - started > 7000) return reject(new Error('等待观战回归服务启动超时'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function waitEvent(socket, eventName, timeoutMs = 5000) {
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

async function connectUser(name) {
  const socket = io(URL, { transports: ['websocket'], reconnection: false });
  await waitEvent(socket, 'connect');
  const login = waitEvent(socket, 'LOGIN_SUCCESS');
  socket.emit('LOGIN', { userName: name, guestId: 'spectator-live-' + name });
  await login;
  return socket;
}

async function sit(socket, deskId, posId, label) {
  const success = waitEvent(socket, 'SITDOWN_SUCCESS').catch(error => {
    error.message += ' [' + (label || 'unknown') + ', desk=' + deskId + ', pos=' + posId + ']';
    throw error;
  });
  socket.emit('SITDOWN', { deskId, posId });
  return success;
}

function positionIds(positions) {
  return (positions || []).map(position => Number(position.posId)).sort((a, b) => a - b);
}

async function auditMode(gameType, seatCount, ownerIndex, sockets) {
  const players = [];
  for (let index = 0; index < seatCount; index++) {
    const player = await connectUser('观战审查-' + gameType + '-' + index);
    players.push(player);
    sockets.push(player);
  }
  const earlySpectator = await connectUser('观战审查-早期观众-' + gameType);
  sockets.push(earlySpectator);

  const createdEvent = waitEvent(players[ownerIndex], 'ROOM_CREATED');
  players[ownerIndex].emit('CREATE_ROOM', { gameType, isPrivate: false });
  const created = await createdEvent;
  await sit(players[ownerIndex], created.deskId, ownerIndex, gameType + '-owner');
  for (let index = 0; index < seatCount; index++) {
    if (index === ownerIndex) continue;
    await sit(players[index], created.deskId, index, gameType + '-player-' + index);
  }

  const earlySpectateEvent = waitEvent(earlySpectator, 'SPECTATE_SUCCESS');
  earlySpectator.emit('SPECTATE', { deskId: created.deskId });
  const early = await earlySpectateEvent;
  assert.deepStrictEqual(positionIds(early.positions), Array.from({ length: seatCount }, (_, index) => index), gameType + ' 观战入场缺少座位');
  assert((early.positions || []).every(position => Number(position.state) > 0), gameType + ' 观战入场存在未显示座位');

  const gameStartEvent = waitEvent(earlySpectator, 'GAME_START', 7000);
  const readyEvents = players.map(player => waitEvent(player, 'PREPARE_SUCCESS'));
  players.forEach(player => player.emit('PREPARE'));
  await Promise.all(readyEvents);
  const gameStart = await gameStartEvent;
  const startGroups = (gameStart.cards || []).filter(group => Number(group.id) >= 0 && Number(group.id) < seatCount);
  assert.deepStrictEqual(positionIds(startGroups.map(group => ({ posId: group.id }))), Array.from({ length: seatCount }, (_, index) => index), gameType + ' GAME_START 未包含全部玩家牌组');

  const lateSpectator = await connectUser('观战审查-晚期观众-' + gameType);
  sockets.push(lateSpectator);
  const lateSpectateEvent = waitEvent(lateSpectator, 'SPECTATE_SUCCESS');
  lateSpectator.emit('SPECTATE', { deskId: created.deskId });
  const late = await lateSpectateEvent;
  assert.strictEqual(late.gameInProgress, true, gameType + ' 对局中观战未标记进行中');
  assert.deepStrictEqual(positionIds(late.positions), Array.from({ length: seatCount }, (_, index) => index), gameType + ' 对局中观战位置缺失');
  const snapshotGroups = (late.snapshot && late.snapshot.cards || []).filter(group => Number(group.id) >= 0 && Number(group.id) < seatCount);
  assert.deepStrictEqual(positionIds(snapshotGroups.map(group => ({ posId: group.id }))), Array.from({ length: seatCount }, (_, index) => index), gameType + ' 对局中快照缺少玩家牌组');

  return {
    gameType,
    seatCount,
    roomCode: created.roomCode,
    earlyPositions: positionIds(early.positions),
    startGroups: positionIds(startGroups.map(group => ({ posId: group.id }))),
    snapshotGroups: positionIds(snapshotGroups.map(group => ({ posId: group.id }))),
  };
}

async function run() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DB_DISABLE: '1',
      NODE_ENV: 'test',
      JWT_SECRET: 'spectator-live-test-secret',
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
    const summaries = [
      await auditMode('doudizhu', 3, 0, sockets),
      await auditMode('guandan', 4, 0, sockets),
      await auditMode('mahjong', 4, 0, sockets),
    ];
    console.log('Spectator live regression tests passed: all seats visible before and during all three game modes.');
    if (process.env.SPECTATOR_LIVE_TEST_VERBOSE === '1') console.log(JSON.stringify(summaries));
  } finally {
    sockets.forEach(socket => {
      try { socket.disconnect(); } catch (error) {}
    });
    if (child && !child.killed) child.kill();
  }
  if (stderr && /EADDRINUSE|SyntaxError|TypeError/.test(stderr)) {
    throw new Error('观战回归服务异常：' + stderr.slice(-1200));
  }
}

run().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
