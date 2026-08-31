const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const io = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PAUSE_TAKEOVER_TEST_PORT || 18088);
const URL = 'http://127.0.0.1:' + PORT;

function waitForStart(output) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (output().includes('server is running on port ' + PORT)) return resolve();
      if (Date.now() - started > 7000) return reject(new Error('等待暂停回归服务启动超时'));
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

async function connectUser(name) {
  const socket = io(URL, { transports: ['websocket'], reconnection: false });
  await waitEvent(socket, 'connect');
  const login = waitEvent(socket, 'LOGIN_SUCCESS');
  socket.emit('LOGIN', { userName: name, guestId: 'pause-takeover-' + name });
  await login;
  return socket;
}

async function auditMode(gameType, seatCount, allSockets) {
  const players = [];
  for (let index = 0; index < seatCount; index++) {
    const player = await connectUser('暂停回归-' + gameType + '-' + index + '-' + process.pid);
    players.push(player);
    allSockets.push(player);
  }

  const createdEvent = waitEvent(players[0], 'ROOM_CREATED');
  players[0].emit('CREATE_ROOM', { gameType, isPrivate: false });
  const created = await createdEvent;
  for (let index = 0; index < seatCount; index++) {
    if (index === 0) continue;
    const sitEvent = waitEvent(players[index], 'SITDOWN_SUCCESS');
    players[index].emit('SITDOWN', { deskId: created.deskId, posId: index });
    await sitEvent;
  }
  const ownerSitEvent = waitEvent(players[0], 'SITDOWN_SUCCESS');
  players[0].emit('SITDOWN', { deskId: created.deskId, posId: 0 });
  await ownerSitEvent;

  const prepareEvents = players.map(player => waitEvent(player, 'PREPARE_SUCCESS'));
  const gameStart = waitEvent(players[0], 'GAME_START');
  players.forEach(player => player.emit('PREPARE'));
  await Promise.all(prepareEvents);
  await gameStart;

  const paused = waitEvent(players[0], 'GAME_PAUSED');
  players[1].disconnect();
  const pausePayload = await paused;
  assert.strictEqual(Number(pausePayload.posId), 1, gameType + ' 断线暂停座位错误');
  assert(Number(pausePayload.expiresAt) > Date.now(), gameType + ' 暂停没有保留窗口');

  const resumed = waitEvent(players[0], 'GAME_RESUMED');
  players[0].emit('ADD_BOTS');
  const resumePayload = await resumed;
  assert.strictEqual(resumePayload.source, 'ai', gameType + ' AI 补位恢复来源错误');
  assert.strictEqual(Number(resumePayload.posId), 1, gameType + ' AI 补位恢复座位错误');
  assert.strictEqual(resumePayload.isBot, true, gameType + ' 恢复后暂停座位未标记为 AI');
  return { gameType, seatCount, pausedPosId: Number(pausePayload.posId) };
}

async function run() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DB_DISABLE: '1',
      NODE_ENV: 'test',
      JWT_SECRET: 'pause-takeover-test-secret',
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
    await auditMode('doudizhu', 3, sockets);
    await auditMode('guandan', 4, sockets);
    await auditMode('mahjong', 4, sockets);
    console.log('Pause/takeover live regression tests passed: one-minute pause and owner AI takeover work in all three game modes.');
  } finally {
    sockets.forEach(socket => {
      try { socket.disconnect(); } catch (error) {}
    });
    if (child && !child.killed) child.kill();
  }
  if (stderr && /EADDRINUSE|SyntaxError|TypeError/.test(stderr)) {
    throw new Error('暂停回归服务异常：' + stderr.slice(-1200));
  }
}

run().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
