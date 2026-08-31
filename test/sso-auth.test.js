const assert = require('assert');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const io = require('socket.io-client');

const ROOT = require('path').join(__dirname, '..');
const PORT = Number(process.env.SSO_AUTH_TEST_PORT || 18085);
const URL = 'http://127.0.0.1:' + PORT;
const SECRET = 'sso-auth-regression-secret';

function waitForStart(output) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (output().includes('server is running on port ' + PORT)) return resolve();
      if (Date.now() - started > 7000) return reject(new Error('等待 SSO 回归服务启动超时'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function probeToken(token) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], reconnection: false, auth: { token } });
    const events = [];
    const timer = setTimeout(() => {
      socket.disconnect();
      resolve(events);
    }, 1000);
    socket.on('connect_error', error => {
      clearTimeout(timer);
      socket.disconnect();
      reject(error);
    });
    socket.on('LOGIN_FAIL', data => events.push({ type: 'LOGIN_FAIL', code: data && data.code }));
    socket.on('WHOAMI', data => events.push({ type: 'WHOAMI', uid: data && data.uid }));
    socket.on('LOGIN_SUCCESS', () => events.push({ type: 'LOGIN_SUCCESS' }));
  });
}

async function run() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DB_DISABLE: '1',
      NODE_ENV: 'test',
      JWT_SECRET: SECRET,
      JWT_ISSUER: 'expected-issuer',
      JWT_AUDIENCE: 'expected-audience',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });

  try {
    await waitForStart(() => stdout);
    const valid = jwt.sign({ uid: 'sso-valid', username: 'sso-valid' }, SECRET, {
      algorithm: 'HS256', issuer: 'expected-issuer', audience: 'expected-audience', expiresIn: '5m',
    });
    const wrongClaims = jwt.sign({ uid: 'sso-wrong', username: 'sso-wrong' }, SECRET, {
      algorithm: 'HS256', issuer: 'wrong-issuer', audience: 'wrong-audience', expiresIn: '5m',
    });
    const [validEvents, wrongEvents] = await Promise.all([probeToken(valid), probeToken(wrongClaims)]);
    assert(validEvents.some(event => event.type === 'WHOAMI'), '正确 iss/aud 的 token 应自动登录');
    assert(wrongEvents.some(event => event.type === 'LOGIN_FAIL'), '错误 iss/aud 的 token 应被拒绝');
    assert(!wrongEvents.some(event => event.type === 'WHOAMI'), '错误 iss/aud 的 token 不得进入用户态');
    assert(!wrongEvents.some(event => event.type === 'LOGIN_SUCCESS'), '错误 iss/aud 的 token 不得收到登录成功');

    const health = await fetch(URL + '/api/sso/health').then(response => response.json());
    assert.strictEqual(Object.prototype.hasOwnProperty.call(health, 'fingerprint'), false, '健康接口不得公开 JWT 指纹');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(health, 'length'), false, '健康接口不得公开 JWT 长度');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(health, 'source'), false, '健康接口不得公开密钥来源');
    console.log('SSO auth regression tests passed: issuer/audience enforcement and health response redaction.');
  } finally {
    if (child && !child.killed) child.kill();
  }
  if (stderr && /EADDRINUSE|SyntaxError|TypeError/.test(stderr)) {
    throw new Error('SSO 回归服务异常：' + stderr.slice(-1200));
  }
}

run().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
