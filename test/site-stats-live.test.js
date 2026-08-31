const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const io = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SITE_STATS_TEST_PORT || 18084);
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
      if (result) return resolve(result);
      if (Date.now() - started >= timeoutMs) return reject(new Error(label || '等待条件超时'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function getStats() {
  const response = await fetch(URL + '/api/site-stats?_=' + Date.now(), { cache: 'no-store' });
  assert.strictEqual(response.status, 200, '站点统计接口状态异常');
  return { response, data: await response.json() };
}

async function run() {
  const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
  assert.match(serverJs, /SITE_STATS_UPDATE/, '服务端实时统计事件缺失');
  assert.match(serverJs, /subscribeSiteStats/, '服务端统计订阅缺失');
  assert.match(serverJs, /function publicSiteStats/, '公开统计响应缺少内部元数据过滤');
  assert.match(serverJs, /delete snapshot\.dataQuality/, '公开统计响应仍可能暴露数据质量内部字段');
  assert.match(serverJs, /Cache-Control.*no-store/, '统计接口未禁用缓存');
  assert.match(indexHtml, /site-stats-live/, '统计面板实时状态标识缺失');
  assert.match(indexHtml, /SITE_STATS_UPDATE/, '前端实时统计监听缺失');
  assert.match(indexHtml, /setInterval\(function \(\) \{ load\(false\); \}, 15000\)/, '统计接口轮询兜底缺失');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DB_DISABLE: '1',
      JWT_SECRET: 'site-stats-live-test-secret',
      NODE_ENV: 'test',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });
  let socket = null;
  const updates = [];

  try {
    await waitFor(() => stdout.includes('server is running on port ' + PORT), 8000, '等待统计测试服务启动');
    socket = io(URL, { transports: ['websocket'], reconnection: false });
    socket.on('SITE_STATS_UPDATE', data => updates.push(data || {}));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待统计测试连接超时')), 5000);
      socket.once('LOGIN_SUCCESS', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
      socket.on('connect', () => socket.emit('LOGIN', {
        userName: 'site-stats-live-' + process.pid,
        guestId: 'site-stats-live-' + process.pid,
      }));
    });
    await waitFor(() => updates.length > 0, 3000, '新连接未收到站点统计初始快照');

    const baseline = await getStats();
    assert.match(String(baseline.response.headers.get('cache-control') || ''), /no-store/, '统计接口响应仍可能被缓存');
    const pageResponse = await fetch(URL + '/', { cache: 'no-store' });
    assert.strictEqual(pageResponse.status, 200, '统计实时测试触发页面访问失败');
    await waitFor(
      () => updates.some(item => Number(item.visits || 0) >= Number(baseline.data.visits || 0) + 1),
      3000,
      '页面访问后未收到实时统计更新'
    );
    const live = updates.find(item => Number(item.visits || 0) >= Number(baseline.data.visits || 0) + 1);
    assert(Number(live.updatedAt || 0) > 0, '实时统计快照缺少更新时间: ' + JSON.stringify({ baseline: baseline.data, live, updates }));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(live, 'dataQuality'), false, '实时统计不应把内部数据质量说明推给前端');
    console.log('Live site stats tests passed: initial snapshot, no-cache API, Socket.IO push, and page-view update.');
  } finally {
    try { if (socket) socket.disconnect(); } catch (e) {}
    if (child && !child.killed) child.kill();
    await wait(100);
  }

  if (stderr && /EADDRINUSE|SyntaxError|TypeError/.test(stderr)) {
    throw new Error('实时统计测试服务异常：' + stderr.slice(-1200));
  }
}

run().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
