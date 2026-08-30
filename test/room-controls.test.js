const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const io = require('socket.io-client');
const AiDifficulty = require('../ai-difficulty');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.AI_ROOM_TEST_PORT || 18083);
const URL = 'http://127.0.0.1:' + PORT;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      let result = false;
      try { result = !!predicate(); } catch (e) {}
      if (result) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error(label || '等待条件超时'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function nextEvent(socket, eventName, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待事件超时：' + eventName));
    }, timeoutMs);
    const onEvent = data => {
      cleanup();
      resolve(data);
    };
    const onError = error => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error && error.message || error)));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(eventName, onEvent);
      socket.off('connect_error', onError);
    };
    socket.once(eventName, onEvent);
    socket.once('connect_error', onError);
  });
}

function connectUser(userName, guestId) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], reconnection: false });
    let timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('登录测试用户超时：' + userName));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('LOGIN_SUCCESS', onSuccess);
      socket.off('LOGIN_FAIL', onFail);
      socket.off('connect_error', onError);
    };
    const onSuccess = () => {
      cleanup();
      resolve(socket);
    };
    const onFail = data => {
      cleanup();
      socket.disconnect();
      reject(new Error('登录失败：' + JSON.stringify(data)));
    };
    const onError = error => {
      cleanup();
      socket.disconnect();
      reject(error instanceof Error ? error : new Error(String(error && error.message || error)));
    };
    socket.once('LOGIN_SUCCESS', onSuccess);
    socket.once('LOGIN_FAIL', onFail);
    socket.once('connect_error', onError);
    socket.on('connect', () => socket.emit('LOGIN', { userName, guestId }));
  });
}

async function run() {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
  const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(indexHtml, /ai-difficulty-control/, '房间内 AI 难度控件缺失');
  assert.match(indexHtml, /setAiDifficulty/, '前端 AI 难度事件缺失');
  assert.match(indexHtml, /takeoverRandomBot/, '前端随机顶号入口缺失');
  assert.match(serverJs, /SET_AI_DIFFICULTY/, '服务端 AI 难度事件缺失');
  assert.match(serverJs, /TAKEOVER_BOT/, '服务端随机顶号事件缺失');
  assert.match(serverJs, /只有房主可以调整 AI 难度/, '服务端房主权限校验缺失');
  assert.strictEqual(AiDifficulty.normalizeAiDifficulty('简单'), 'easy');
  assert.strictEqual(AiDifficulty.normalizeAiDifficulty('hard'), 'hard');
  assert.strictEqual(AiDifficulty.aiDifficultyLabel('normal'), '标准');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DB_DISABLE: '1',
      JWT_SECRET: 'room-control-test-secret',
      NODE_ENV: 'test',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const sockets = [];

  try {
    await waitFor(() => stdout.includes('server is running on port ' + PORT), 8000, '等待测试服务启动');

    const owner = await connectUser('room-owner-' + process.pid, 'room-owner-' + process.pid);
    sockets.push(owner);
    const createdPromise = nextEvent(owner, 'ROOM_CREATED');
    const ownerQuickPromise = nextEvent(owner, 'QUICK_JOIN');
    owner.emit('CREATE_ROOM', { gameType: 'doudizhu', isPrivate: true });
    const created = await createdPromise;
    const ownerQuick = await ownerQuickPromise;
    assert(ownerQuick.success && created.roomCode, '房主建房/快速入座失败');
    const ownerSitPromise = nextEvent(owner, 'SITDOWN_SUCCESS');
    owner.emit('SITDOWN', { deskId: ownerQuick.deskId, posId: ownerQuick.posId });
    const ownerSit = await ownerSitPromise;
    assert.strictEqual(ownerSit.aiDifficulty, 'normal', '新房间默认 AI 难度应为标准');

    const difficultyChangePromise = nextEvent(owner, 'AI_DIFFICULTY_CHANGE');
    owner.emit('SET_AI_DIFFICULTY', { difficulty: 'hard' });
    const changed = await difficultyChangePromise;
    assert.strictEqual(changed.aiDifficulty, 'hard', '房主开局前调整 AI 难度未生效');

    owner.emit('ADD_BOTS');
    await wait(100);

    const ownerReadyPromise = nextEvent(owner, 'PREPARE_SUCCESS');
    const gameStartPromise = nextEvent(owner, 'GAME_START', 7000);
    owner.emit('PREPARE');
    await ownerReadyPromise;
    const gameStart = await gameStartPromise;
    assert.strictEqual(gameStart.aiDifficulty, 'hard', 'GAME_START 未携带房间 AI 难度');

    const player1 = await connectUser('room-player-one-' + process.pid, 'room-player-one-' + process.pid);
    sockets.push(player1);
    const player1QuickPromise = nextEvent(player1, 'QUICK_JOIN');
    player1.emit('JOIN_ROOM', { roomCode: created.roomCode });
    const player1Quick = await player1QuickPromise;
    assert(player1Quick.success && player1Quick.takeoverBot, '房间无空座时 JOIN_ROOM 未随机接管 AI');
    const player1SitPromise = nextEvent(player1, 'SITDOWN_SUCCESS');
    player1.emit('SITDOWN', { deskId: player1Quick.deskId, posId: player1Quick.posId });
    const player1Sit = await player1SitPromise;
    assert.strictEqual(player1Sit.takeoverBot, true, 'JOIN_ROOM 顶号标记缺失');
    assert.strictEqual(player1Sit.gameInProgress, true, '真人接管进行中的 AI 未进入当前牌局');
    const ownSnapshotGroup = (player1Sit.snapshot && player1Sit.snapshot.cards || []).find(group => Number(group.id) === Number(player1Sit.posId));
    const otherSnapshotGroups = (player1Sit.snapshot && player1Sit.snapshot.cards || []).filter(group => Number(group.id) !== Number(player1Sit.posId));
    assert(ownSnapshotGroup && ownSnapshotGroup.cards.some(card => Number(card.value) > 0), '顶号真人没有拿到自己的当前手牌');
    assert(otherSnapshotGroups.every(group => group.cards.every(card => card.hidden)), '顶号快照泄露了其他座位手牌');

    const player2 = await connectUser('room-player-two-' + process.pid, 'room-player-two-' + process.pid);
    sockets.push(player2);
    const player2QuickPromise = nextEvent(player2, 'QUICK_JOIN');
    player2.emit('TAKEOVER_BOT', { deskId: created.deskId });
    const player2Quick = await player2QuickPromise;
    assert(player2Quick.success && player2Quick.takeoverBot, 'TAKEOVER_BOT 未随机分配 AI 座位');
    const player2SitPromise = nextEvent(player2, 'SITDOWN_SUCCESS');
    player2.emit('SITDOWN', { deskId: player2Quick.deskId, posId: player2Quick.posId });
    const player2Sit = await player2SitPromise;
    assert.strictEqual(player2Sit.takeoverBot, true, '显式顶号的 SITDOWN 标记缺失');
    assert((player2Sit.positions || []).filter(pos => pos.isBot).length === 0, '两次顶号后仍残留 AI 座位');

    const ownerOnlyPromise = nextEvent(player1, 'AI_DIFFICULTY_ERROR');
    player1.emit('SET_AI_DIFFICULTY', { difficulty: 'easy' });
    const ownerOnly = await ownerOnlyPromise;
    assert.strictEqual(ownerOnly.code, 'OWNER_ONLY', '非房主调整 AI 难度未被服务端拦截');

    const lockedPromise = nextEvent(owner, 'AI_DIFFICULTY_ERROR');
    owner.emit('SET_AI_DIFFICULTY', { difficulty: 'easy' });
    const locked = await lockedPromise;
    assert.strictEqual(locked.code, 'GAME_STARTED', '开局后调整 AI 难度未被服务端锁定');
    assert.strictEqual(locked.aiDifficulty, 'hard', '开局后服务端 AI 难度被错误修改');
  } finally {
    sockets.forEach(socket => {
      try { socket.disconnect(); } catch (e) {}
    });
    if (child && !child.killed) child.kill();
  }

  if (stderr && /EADDRINUSE|SyntaxError|TypeError/.test(stderr)) {
    throw new Error('房间控制测试服务异常：' + stderr.slice(-1200));
  }
  console.log('AI difficulty and bot takeover tests passed: owner lock, pre-start update, JOIN_ROOM fallback, TAKEOVER_BOT, in-game lock.');
}

run().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
