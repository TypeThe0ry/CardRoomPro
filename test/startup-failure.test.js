const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.STARTUP_FAILURE_TEST_PORT || 18089);

function waitForStart(child, output) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (output().includes('server is running on port ' + PORT)) return resolve();
      if (child.exitCode != null) return reject(new Error('占用端口的基准服务提前退出：' + output()));
      if (Date.now() - started > 7000) return reject(new Error('等待启动冲突测试基准服务超时'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('端口冲突时服务进程未退出，systemd 可能再次误报 active')), timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function run() {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    DB_DISABLE: '1',
    NODE_ENV: 'test',
    JWT_SECRET: 'startup-failure-test-secret',
  });
  const first = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let firstOutput = '';
  first.stdout.on('data', data => { firstOutput += data.toString(); });
  first.stderr.on('data', data => { firstOutput += data.toString(); });
  const second = { process: null };
  try {
    await waitForStart(first, () => firstOutput);
    second.process = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let secondOutput = '';
    second.process.stdout.on('data', data => { secondOutput += data.toString(); });
    second.process.stderr.on('data', data => { secondOutput += data.toString(); });
    const result = await waitForExit(second.process, 5000);
    assert.notStrictEqual(result.code, 0, '端口冲突时服务必须以失败状态退出');
    assert.match(secondOutput, /EADDRINUSE|address already in use/, '启动冲突日志缺少 EADDRINUSE 证据');
    console.log('Startup failure regression tests passed: port conflicts exit non-zero instead of leaving a false-active service.');
  } finally {
    if (second.process && second.process.exitCode == null) second.process.kill();
    if (first && first.exitCode == null) first.kill();
  }
}

run().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
