const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const io = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.CHAT_REGRESSION_TEST_PORT || 18087);
const URL = 'http://127.0.0.1:' + PORT;

function waitForStart(output) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (output().includes('server is running on port ' + PORT)) return resolve();
      if (Date.now() - started > 7000) return reject(new Error('等待聊天回归服务启动超时'));
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
  socket.emit('LOGIN', { userName: name, guestId: 'chat-regression-' + name });
  await login;
  return socket;
}

async function run() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DB_DISABLE: '1',
      NODE_ENV: 'test',
      JWT_SECRET: 'chat-regression-secret',
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
    const owner = await connectUser('聊天回归房主-' + process.pid);
    sockets.push(owner);
    const createdEvent = waitEvent(owner, 'ROOM_CREATED');
    owner.emit('CREATE_ROOM', { gameType: 'doudizhu', isPrivate: false });
    const created = await createdEvent;
    const sitEvent = waitEvent(owner, 'SITDOWN_SUCCESS');
    owner.emit('SITDOWN', { deskId: created.deskId, posId: 0 });
    await sitEvent;

    const spectator = await connectUser('聊天回归观众-' + process.pid);
    sockets.push(spectator);
    const spectateEvent = waitEvent(spectator, 'SPECTATE_SUCCESS');
    spectator.emit('SPECTATE', { deskId: created.deskId });
    await spectateEvent;

    const marker = 'chat-regression-' + Date.now();
    const received = [];
    spectator.on('USER_MESSAGE', message => {
      if (message && message.msg === marker) received.push(message);
    });
    spectator.emit('USER_MESSAGE', marker);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.strictEqual(received.length, 1, '观众发送的聊天消息应只回显一次');
    assert.strictEqual(received[0].type, 'SPEC', '观众聊天消息类型应为 SPEC');

    console.log('Chat regression tests passed: spectator messages are delivered exactly once to the sender.');
  } finally {
    sockets.forEach(socket => {
      try { socket.disconnect(); } catch (error) {}
    });
    if (child && !child.killed) child.kill();
  }
  if (stderr && /EADDRINUSE|SyntaxError|TypeError/.test(stderr)) {
    throw new Error('聊天回归服务异常：' + stderr.slice(-1200));
  }
}

run().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
