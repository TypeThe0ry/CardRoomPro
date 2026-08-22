#!/usr/bin/env node

// 从 Nginx 访问日志 + 旧积分表恢复历史统计。
// 牌序、叫分/出牌事件只在新历史表启用后才有记录，不凭空伪造旧复盘。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const configPath = process.env.CARDROOM_CONFIG || path.join(root, 'config.json');
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    Object.keys(config).forEach(key => {
      if (process.env[key] === undefined || process.env[key] === '') process.env[key] = String(config[key]);
    });
  } catch (err) {
    console.error('[backfill] config.json 解析失败：', err.message);
    process.exit(1);
  }
}

const db = require('../db');

function parseAccessLog(filePath) {
  const result = { found: false, lines: 0, pageViews: 0, socketConnections: 0 };
  if (!filePath || !fs.existsSync(filePath)) return result;
  result.found = true;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    result.lines += 1;
    const match = line.match(/"(?:GET|HEAD)\s+(\S+)\s+HTTP\/[^\"]+"\s+(\d{3})\b/);
    if (!match || Number(match[2]) >= 400) continue;
    const request = match[1];
    const pathname = request.split('?')[0];
    if (pathname === '/' || pathname === '/index.html') result.pageViews += 1;
    if (pathname === '/socket.io/' && /(?:^|[?&])transport=polling(?:&|$)/.test(request) && !/(?:^|[?&])sid=/.test(request)) {
      result.socketConnections += 1;
    }
  }
  return result;
}

function metric(value, mode, source, note) {
  return { value: Number(value || 0), mode, source, note };
}

async function main() {
  const logPath = process.env.NGINX_ACCESS_LOG || '/www/wwwlogs/doudizhu.log';
  await db.init();
  const access = parseAccessLog(logPath);
  const byGame = await db.getHistoricalGameStats();
  const completed = byGame.reduce((sum, item) => sum + Number(item.completedEstimate || 0), 0);
  const playerRounds = byGame.reduce((sum, item) => sum + Number(item.playerRounds || 0), 0);
  const metadata = {
    version: 1,
    recoveredAt: Date.now(),
    overall: 'mixed-recovery-estimate',
    log: { path: logPath, found: access.found, lines: access.lines },
    metrics: {
      page_views: metric(access.pageViews, 'recovered', 'nginx_access_log', '统计 GET / 与 GET /index.html 的成功请求'),
      socket_connections: metric(access.socketConnections, 'recovered', 'nginx_access_log', '统计无 sid 的 Socket.IO polling 初始握手'),
      game_starts: metric(completed, 'estimated', 'score_tables', '旧积分表没有开局事件，按可推导完成局数回填'),
      games_completed: metric(completed, 'estimated', 'score_tables', '按每玩法玩家最大局数与座位数折算，旧牌序无法还原'),
      player_rounds: metric(playerRounds, 'recovered', 'score_tables', '旧积分表中已持久化的真人玩家局数之和'),
      spectator_visits: metric(0, 'unavailable', 'new_telemetry_only', '旧日志没有观战事件，保留为 0，后续由实时事件累计'),
    },
    byGame,
  };
  const stats = await db.backfillSiteStats({
    values: {
      page_views: access.pageViews,
      socket_connections: access.socketConnections,
      game_starts: completed,
      games_completed: completed,
      player_rounds: playerRounds,
      spectator_visits: 0,
    },
    dataQuality: metadata,
    force: process.argv.includes('--force'),
  });
  console.log(JSON.stringify({ log: access, byGame, stats }, null, 2));
  await db.close();
}

main().catch(err => { console.error('[backfill] failed:', err); process.exit(1); });
