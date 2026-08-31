// ========== 全局错误保护（记录致命异常并交给进程管理器重启）==========
process.on('uncaughtException', function (err) {
  console.error('[FATAL] uncaughtException:', err);
  // 未捕获异常可能已经破坏进程状态；继续运行会让 systemd/pm2 误判服务健康。
  // 退出码交给进程管理器处理，尤其要正确暴露 EADDRINUSE 等启动错误。
  process.exit(1);
});
process.on('unhandledRejection', function (reason, promise) {
  console.error('[FATAL] unhandledRejection:', reason);
});

const express = require('express'),
  app = express(),
  http = require('http').Server(app),
  io = require('socket.io')(http, {
    // CF 橙云代理下，单 WS 连接 100 秒无流量会被切断，缩短心跳避免被切
    pingInterval: 25000,
    pingTimeout: 20000,
  });

// ========== 配置文件（推荐方式）==========
// 在项目根目录创建 config.json（已在 .gitignore），格式：
// {
//   "PORT": 8002,
//   "JWT_SECRET": "与论坛 DISCUZ_SSO_SECRET 完全一致的字符串",
//   "DB_HOST": "127.0.0.1",
//   "DB_PORT": 3306,
//   "DB_USER": "zwwx_dz",
//   "DB_PASSWORD": "数据库密码",
//   "DB_NAME": "zwwx_discuz",
//   "DB_TABLE_PREFIX": "pre_",
//   "SCORE_BASE": 1
// }
// 读取顺序：环境变量 > config.json > 默认值；并把 config.json 中的值塞回 process.env，
// 使下游模块（db.js 等）也能用 process.env.* 读到。
(function loadConfig() {
  try {
    const fs = require('fs');
    const path = require('path');
    const f = path.join(__dirname, 'config.json');
    if (!fs.existsSync(f)) return;
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    Object.keys(cfg).forEach(function (k) {
      if (cfg[k] === null || cfg[k] === undefined) return;
      // 环境变量优先，已设的不覆盖
      if (process.env[k] !== undefined && process.env[k] !== '') return;
      process.env[k] = String(cfg[k]);
    });
    console.log('[config] 已加载 config.json');
  } catch (e) {
    console.error('[config] config.json 解析失败：', e && e.message);
  }
})();

app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    db.recordSiteStat('page_views').catch(() => {});
  }
  next();
});
app.use(express.static(`${__dirname}/static`));
app.get('/', function (req, res) {
  res.sendFile(`${__dirname}/index.html`);
});
const Game = require('./game.js');
const GuandanGame = require('./guandan-game.js');
const MahjongGame = require('./mahjong-game.js');
const AISuggest = require('./static/js/ai-suggest.js').AISuggest;
const GuandanSuggest = require('./static/js/guandan-suggest.js').GuandanSuggest;
const SmartAI = require('./static/js/smart-ai.js').SmartAI;
const MahjongAI = require('./static/js/mahjong-ai.js').MahjongAI;
const AiDifficulty = require('./ai-difficulty.js');
const db = require('./db.js');

// 运营统计的历史回填说明只供服务端/维护脚本使用，公开接口只返回正常业务指标，
// 避免把“估算、来源、恢复时间”等内部数据质量字段带到用户界面。
function publicSiteStats(stats) {
  const snapshot = Object.assign({}, stats || {});
  delete snapshot.dataQuality;
  delete snapshot.backfilledAt;
  return snapshot;
}

// 站点运营数据有变化时主动推送给所有在线页面；前端统计弹窗无需手动刷新。
db.subscribeSiteStats(stats => {
  io.emit('SITE_STATS_UPDATE', publicSiteStats(stats));
});

// 底分（每分对应多少积分）。可通过环境变量调整。
const SCORE_BASE = Number(process.env.SCORE_BASE || 1);
const DOU_DIZHU_PLAY_TIMEOUT = 30;
const DOU_DIZHU_STEP_TIMEOUT = 15;
const GUANDAN_PLAY_TIMEOUT = 45;
const MAHJONG_PLAY_TIMEOUT = 30;
const GAME_PAUSE_GRACE_MS = 60 * 1000;

// ========== 安全加固：API 防滥用 ==========
// 设计原则：所有"加分/扣分"都只能由服务端 socket 流程里的 game.getResult() 触发，
// 任何 HTTP 写入接口一律不存在；下方中间件确保即使将来误添加也不会被利用。
//
// 1) 任何非 GET 的 /api/* 请求一律拒绝（白名单只允许 GET）。
//    这就把 `POST /api/scores`、`POST /api/score/...`、`PUT /api/...` 等全部封死。
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).type('application/json').send(JSON.stringify({
      error: 'method_not_allowed',
      message: '本服务的积分写入只能由对局结算在服务端触发，不接受任何 HTTP 写入请求。'
    }));
  }
  // 不挂 body parser，确保任何 JSON body 都不会被解析或使用
  next();
});

function jwtVerifyOptions(token) {
  const options = { algorithms: ['HS256'] };
  const issuer = String(process.env.JWT_ISSUER || '').trim();
  const audience = String(process.env.JWT_AUDIENCE || '').trim();
  if (issuer) options.issuer = issuer;
  if (audience) options.audience = audience;
  // 兼容 issuer/audience 加固前已经签发、但签名仍由同一 JWT_SECRET
  // 生成的旧 token。新 token 只要带有 iss/aud，仍然严格校验这两项。
  // 这样不会把旧登录态误判成“签名不匹配”，用户也不必被强制清空全部会话。
  if (token && (issuer || audience)) {
    const claims = require('jsonwebtoken').decode(token);
    if (!claims || typeof claims !== 'object') {
      delete options.issuer;
      delete options.audience;
    } else {
      if (issuer && !Object.prototype.hasOwnProperty.call(claims, 'iss')) delete options.issuer;
      if (audience && !Object.prototype.hasOwnProperty.call(claims, 'aud')) delete options.audience;
    }
  }
  return options;
}

function verifySsoToken(token) {
  if (!token) throw new Error('missing token');
  const jwt = require('jsonwebtoken');
  return verifyCompatibleJwt(token, proto.JWT_SECRET, jwt);
}

function verifyCompatibleJwt(token, secret, jwt) {
  // jwtVerifyOptions 已经对缺少 iss/aud 的旧 token 做了兼容：缺失时不启用
  // 对应约束；但 token 明确携带错误 iss/aud 时必须让 verify 失败，不能再
  // 退回到“只验签名”的路径，否则 JWT_ISSUER/JWT_AUDIENCE 形同虚设。
  return jwt.verify(token, secret, jwtVerifyOptions(token));
}

// 2) /api/* 简单速率限制（按 IP，每 10 秒 30 次），抵御暴力探测/扫表。
const __apiHits = new Map();
app.use('/api', (req, res, next) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress || '').toString().split(',')[0].trim();
  const now = Date.now();
  const winMs = 10 * 1000;
  const max = 30;
  const arr = (__apiHits.get(ip) || []).filter(t => now - t < winMs);
  arr.push(now);
  __apiHits.set(ip, arr);
  // 顺手清理太久没活动的 IP，避免内存膨胀
  if (__apiHits.size > 5000) {
    for (const [k, v] of __apiHits) {
      if (!v.length || now - v[v.length - 1] > 5 * 60 * 1000) __apiHits.delete(k);
    }
  }
  if (arr.length > max) {
    return res.status(429).type('application/json').send(JSON.stringify({ error: 'rate_limited' }));
  }
  next();
});

// HTTP：查询自己积分（需 ?token=JWT）
app.get('/api/score/me', (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const gameType = normalizeGameType(req.query.gameType);
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    const payload = verifySsoToken(token);
    db.getUserScore(payload.uid, gameType).then(row => res.json(Object.assign({ gameType }, row || {}))).catch(() => res.status(500).json({ error: 'db_error' }));
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
});
// HTTP：积分榜
app.get('/api/score/top', (req, res) => {
  const requestedLimit = Number(req.query.limit || 20);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 20;
  const gameType = normalizeGameType(req.query.gameType);
  db.getTopScores(limit, gameType).then(rows => res.json(rows || [])).catch(() => res.json([]));
});

function historyViewerFromRequest(req) {
  const viewer = {
    uid: '',
    username: '',
    guestId: String(req.query.guestId || req.headers['x-cardroom-guest'] || '').trim().slice(0, 128),
  };
  const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) {
    try {
      const payload = verifySsoToken(token);
      if (payload && payload.uid) {
        viewer.uid = String(payload.uid);
        viewer.username = String(payload.username || viewer.username || '').slice(0, 64);
      }
    } catch (e) {}
  }
  return viewer;
}

// 历史战局：公开房所有人可看；私密房只允许本局参与者查看。
app.get('/api/history', (req, res) => {
  const requestedGame = String(req.query.gameType || '').trim();
  const gameType = requestedGame && requestedGame !== 'all' ? normalizeGameType(requestedGame) : '';
  db.listHistory({
    gameType,
    limit: req.query.limit,
    offset: req.query.offset,
    viewer: historyViewerFromRequest(req),
  }).then(data => res.json(data)).catch(() => res.status(500).json({ error: 'history_error' }));
});

app.get('/api/history/:id', (req, res) => {
  db.getHistory(req.params.id, historyViewerFromRequest(req)).then(record => {
    if (!record) return res.status(404).json({ error: 'history_not_found' });
    res.json(record);
  }).catch(() => res.status(500).json({ error: 'history_error' }));
});

app.get('/api/site-stats', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  db.getSiteStats().then(stats => res.json(publicSiteStats(stats))).catch(() => res.status(500).json({ error: 'stats_error' }));
});

// HTTP：SSO 配置健康检查。公开响应只返回布尔配置状态，不暴露密钥长度、
// 来源或可用于离线比对候选密钥的指纹；详细密钥核对请在服务器本地完成。
app.get('/api/sso/health', (req, res) => {
  const s = proto.JWT_SECRET || '';
  const isDefault = (s === 'change_this_in_production');
  res.json({
    hasSecret: !!s && !isDefault,
    issuerConfigured: !!String(process.env.JWT_ISSUER || '').trim(),
    audienceConfigured: !!String(process.env.JWT_AUDIENCE || '').trim(),
    queryTokenAccepted: process.env.ALLOW_QUERY_TOKEN === '1' || process.env.ALLOW_QUERY_TOKEN === 'true',
    warning: isDefault ? 'JWT_SECRET 未配置，使用占位串' : null
  });
});

// 3) /api/* 兜底 404：任何未在上方显式声明的 /api/* GET 路径，统一返回 JSON 404。
//    例如：GET /api/scores、GET /api/admin 等。
app.all(/^\/api(\/.*)?$/, (req, res) => {
  res.status(404).type('application/json').send(JSON.stringify({ error: 'not_found' }));
});

const BOT_NAMES = ['玉狐', '青龙', '白鹭', '墨鸢', '朱雀', '碧波', '苍髯'];
const GAME_TYPES = {
  doudizhu: { label: '斗地主', seats: 3 },
  guandan: { label: '掼蛋', seats: 4 },
  mahjong: { label: '麻将', seats: 4 },
};

function normalizeGameType(gameType) {
  return GAME_TYPES[gameType] ? gameType : 'doudizhu';
}

function createPositions(count) {
  const positions = [];
  for (let j = 0; j < count; j++) {
      positions.push({
        posId: j,
        state: 0,
        userName: '',
        avatarUrl: '',
        isBot: false,
        pendingSocketId: '',
      });
  }
  return positions;
}

function roomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function rankLabel(value) {
  if (value === 11) return 'J';
  if (value === 12) return 'Q';
  if (value === 13) return 'K';
  if (value === 14) return 'A';
  if (value === 15) return '2';
  return String(value);
}

function advanceRank(value, delta) {
  const order = [15, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const idx = Math.max(0, order.indexOf(value));
  return order[Math.min(order.length - 1, idx + delta)];
}

function discuzAvatarUrl(uid) {
  if (!uid) return '';
  const base = String(process.env.DISCUZ_AVATAR_BASE || 'https://zwwx.club/uc_server/avatar.php?uid={uid}&size=middle');
  if (!base) return '';
  if (base.indexOf('{uid}') >= 0) return base.replace(/\{uid\}/g, encodeURIComponent(uid));
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'uid=' + encodeURIComponent(uid) + '&size=middle';
}

function sortByCard(cards) {
  return cards.slice(0).sort((a, b) => {
    if (a.value !== b.value) return a.value - b.value;
    if (a.type !== b.type) return a.type - b.type;
    return (a.deck || 0) - (b.deck || 0);
  });
}

function groupCardsByValue(cards) {
  const groups = {};
  cards.forEach(card => {
    if (!groups[card.value]) groups[card.value] = [];
    groups[card.value].push(card);
  });
  Object.keys(groups).forEach(k => { groups[k] = sortByCard(groups[k]); });
  return groups;
}

function pushCandidate(candidates, game, posId, cards) {
  if (!cards || !cards.length) return;
  const ret = game.validate(posId, cards);
  if (ret && ret.status) {
    candidates.push({ cards: cards.slice(0), ret });
  }
}

function getGuandanCandidates(game, posId, leadOnly) {
  const hand = sortByCard((game.getCardsByPosId(posId) || []).slice(0));
  const groups = groupCardsByValue(hand);
  const values = Object.keys(groups).map(Number).sort((a, b) => a - b);
  const candidates = [];

  values.forEach(v => pushCandidate(candidates, game, posId, [groups[v][0]]));
  values.forEach(v => { if (groups[v].length >= 2) pushCandidate(candidates, game, posId, groups[v].slice(0, 2)); });
  values.forEach(v => { if (groups[v].length >= 3) pushCandidate(candidates, game, posId, groups[v].slice(0, 3)); });

  values.forEach(tv => {
    if (groups[tv].length < 3) return;
    values.forEach(pv => {
      if (pv === tv || groups[pv].length < 2) return;
      pushCandidate(candidates, game, posId, groups[tv].slice(0, 3).concat(groups[pv].slice(0, 2)));
    });
  });

  for (let start = 3; start <= 10; start++) {
    const seq = [];
    for (let v = start; v < start + 5; v++) {
      if (groups[v] && groups[v].length) seq.push(groups[v][0]);
    }
    if (seq.length === 5) pushCandidate(candidates, game, posId, seq);
  }

  for (let start = 3; start <= 12; start++) {
    const pairs = [];
    for (let v = start; v < start + 3; v++) {
      if (groups[v] && groups[v].length >= 2) pairs.push(...groups[v].slice(0, 2));
    }
    if (pairs.length === 6) pushCandidate(candidates, game, posId, pairs);
  }

  values.forEach(v => {
    if (groups[v].length >= 4) pushCandidate(candidates, game, posId, groups[v].slice(0, 4));
  });

  const jokers = hand.filter(c => c.value >= 16);
  if (jokers.length >= 4) pushCandidate(candidates, game, posId, jokers.slice(0, 4));

  return candidates
    .filter(item => leadOnly || item.ret.len)
    .sort((a, b) => {
      const bombA = a.ret.bomb ? 1 : 0;
      const bombB = b.ret.bomb ? 1 : 0;
      if (bombA !== bombB) return bombA - bombB;
      if (a.cards.length !== b.cards.length) return a.cards.length - b.cards.length;
      return (a.ret.key || 0) - (b.ret.key || 0);
    });
}


function evaluateDoudizhuHand(cards) {
  const groups = groupCardsByValue(cards || []);
  const values = Object.keys(groups).map(Number);
  let power = 0;
  values.forEach(v => {
    const n = groups[v].length;
    if (v >= 16) power += 4;
    else if (v === 15) power += 3 * n;
    else if (v >= 13) power += 1.5 * n;
    if (n >= 4) power += 7;
    else if (n === 3) power += 2;
  });
  if (groups[16] && groups[17]) power += 8;
  return power;
}

function shouldCallDoudizhuScore(cards, ctxScore) {
  if (!ctxScore || !ctxScore.length) return 0;
  const maxScore = Math.max.apply(null, ctxScore);
  const power = evaluateDoudizhuHand(cards);
  if (power >= 22 && ctxScore.indexOf(3) >= 0) return 3;
  if (power >= 16 && ctxScore.indexOf(2) >= 0) return 2;
  if (power >= 11 && ctxScore.indexOf(1) >= 0) return 1;
  return (power >= 20 && maxScore) ? maxScore : 0;
}

function time() {
  return (new Date()).toLocaleTimeString();
}


var guid = function () {
  var n = 0;
  return function () {
    return ++n;
  }
}();


function GameServer(port) {
  this.clients = [];
  this.port = port;
  this.desks = [];
  this.gameDatas = {};
  this.botTimers = {};
  this.pauseTimers = {};
  this.mahjongClaimTimers = {};
  this.roundHistories = {};
  this.nextRoomId = 1;
}
const proto = {
  // JWT secret used to validate tokens issued by Discuz (or other auth provider)
  // 优先级：环境变量 JWT_SECRET > sso-secret.txt 文件内容 > 占位串
  JWT_SECRET: (function () {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    try {
      const fs = require('fs');
      const path = require('path');
      const f = path.join(__dirname, 'sso-secret.txt');
      if (fs.existsSync(f)) {
        const s = fs.readFileSync(f, 'utf8').trim();
        if (s) return s;
      }
    } catch (e) {}
    return 'change_this_in_production';
  })(),
  broadCastHouse(event, data, socket) {
    socket = socket === undefined ? null : socket;
    this.clients.forEach((client, index) => {
      if (client.deskId === '') {
        client.socket.emit(event, data);
      }
    });
  },
  refreshLobby(socket) {
    const list = this.getLobbyRooms();
    if (socket) {
      socket.emit('REFRESH_LIST', list);
      return;
    }
    this.broadCastHouse('REFRESH_LIST', list);
  },
  createRoom(options) {
    options = options || {};
    const gameType = normalizeGameType(options.gameType);
    const meta = GAME_TYPES[gameType];
    let code = roomCode();
    while (this.desks.some(room => room.roomCode === code)) code = roomCode();
    const room = {
      deskId: this.nextRoomId++,
      roomId: '',
      roomCode: code,
      state: 0,
      gameType,
      gameLabel: meta.label,
      seatCount: meta.seats,
      isPrivate: !!options.isPrivate,
      ownerName: options.ownerName || '',
      aiDifficulty: AiDifficulty.normalizeAiDifficulty(options.aiDifficulty),
      pauseInfo: null,
      createdAt: Date.now(),
      positions: createPositions(meta.seats),
      guandanLevelRank: 15,
      guandanLevelLabel: '2',
    };
    room.roomId = room.deskId;
    this.desks.push(room);
    return room;
  },
  getLobbyRooms() {
    return this.desks
      .filter(room => !room.isPrivate)
      .map(room => ({
        deskId: room.deskId,
        roomId: room.roomId,
        roomCode: room.roomCode,
        state: room.state,
        gameType: room.gameType,
        gameLabel: room.gameLabel,
        seatCount: room.seatCount,
        isPrivate: room.isPrivate,
        ownerName: room.ownerName,
        aiDifficulty: room.aiDifficulty,
        aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(room.aiDifficulty),
        botCount: room.positions.filter(pos => pos.isBot).length,
        paused: !!room.pauseInfo,
        pauseExpiresAt: room.pauseInfo ? room.pauseInfo.expiresAt : 0,
        guandanLevelLabel: room.guandanLevelLabel,
        positions: room.positions.map(p => ({
          posId: p.posId,
          state: p.state,
          userName: p.userName,
          avatarUrl: p.avatarUrl || '',
          isBot: !!p.isBot,
        })),
      }));
  },
  findRoomByCode(code) {
    code = String(code || '').trim();
    return this.desks.find(room => room.roomCode === code || String(room.deskId) === code) || null;
  },
  getFirstOpenPos(room) {
    if (!room) return null;
    return room.positions.find(pos => pos.state === 0 && !pos.pendingSocketId) || null;
  },
  getRandomBotPos(room) {
    if (!room) return null;
    const bots = room.positions.filter(pos => pos.isBot && !pos.pendingSocketId);
    if (!bots.length) return null;
    return bots[Math.floor(Math.random() * bots.length)];
  },
  reservePosition(room, posId, socket) {
    if (!room || !socket) return;
    const pos = this.getPosition(room, posId);
    if (!pos || (pos.state !== 0 && !pos.isBot) || pos.pendingSocketId) return;
    pos.pendingSocketId = socket.id;
    setTimeout(() => {
      if (pos.pendingSocketId === socket.id && (pos.state === 0 || pos.isBot)) {
        pos.pendingSocketId = '';
      }
    }, 5000);
  },
  cleanupRoomIfEmpty(deskId) {
    const room = this.getDesk(deskId);
    if (!room) return;
    const hasHuman = this.clients.some(c => c.deskId === deskId && c.posId !== 'spec');
    if (hasHuman) return;
    // 对局暂停窗口内保留房间和牌局，给房主/回归玩家一分钟处理时间。
    if (room.pauseInfo) return;
    this.removeAllBots(deskId);
    this.clearBotTimer(deskId);
    this.clearPauseTimer(deskId);
    this.clearMahjongClaimTimer(deskId);
    if (this.gameDatas[deskId]) {
      this.gameDatas[deskId].init();
      delete this.gameDatas[deskId];
    }
    const index = this.desks.findIndex(r => r.deskId === deskId);
    if (index >= 0) this.desks.splice(index, 1);
    this.refreshLobby();
  },
  applyGuandanResult(deskId, result) {
    const room = this.getDesk(deskId);
    if (!room || room.gameType !== 'guandan' || !result) return;
    room.guandanLevelRank = advanceRank(room.guandanLevelRank || 15, result.rankDelta || 1);
    room.guandanLevelLabel = rankLabel(room.guandanLevelRank);
    result.nextLevelRank = room.guandanLevelRank;
    result.nextLevelLabel = room.guandanLevelLabel;
  },
  broadCastRoom(event, deskId, data, socket) {
    socket = socket === undefined ? null : socket;

    this.clients.forEach((client, index) => {
      if (client.deskId === deskId && client.socket !== socket) {
        client.socket.emit(event, data);
      }
    });
  },
  getDesk(deskId) {
    for (let i = 0, len = this.desks.length; i < len; i++) {
      let desk = this.desks[i];
      if (desk.deskId == deskId || desk.roomCode == deskId) {
        return desk;
      }
    }
    return null;
  },
  getOtherPosInfo(deskId, posId) {
    let desk = this.getDesk(deskId);
    if (desk) {
      let positions = desk.positions;
      return positions.filter(function (pos) {
        return pos.posId !== posId;
      })
    }
    return [];
  },
  updateOtherPosStatus(deskId, posId, state) {
    let desk = this.getDesk(deskId);
    if (desk) {
      let positions = desk.positions;
      positions.forEach(function (pos) {
        if (pos.posId !== posId) {
          pos.state = state;
        }
      }.bind(this));
    }

  },
  getPosition(desk, posId) {
    for (let i = 0, len = desk.positions.length; i < len; i++) {
      let position = desk.positions[i];
      if (position.posId == posId) {
        return position;
      }
    }
    return null;
  },
  isEmptyPos(deskId, posId) {
    const desk = this.getDesk(deskId);
    if (!desk) {
      return false;
    }
    const position = this.getPosition(desk, posId);
    return position && position.state === 0;
  },
  updatePosStatus(deskId, posId, state, userName, avatarUrl) {
    const desk = this.getDesk(deskId);
    if (desk) {
      const position = this.getPosition(desk, posId);
      if (position) {
        position.state = state;
        if (userName === '' || userName) {
          position.userName = userName;
        }
        if (avatarUrl === '' || avatarUrl) {
          position.avatarUrl = avatarUrl;
        }
        if (state === 0) {
          position.avatarUrl = '';
        }
      }
    }
  },
  updateRoomStatus(deskId, state) {
    const desk = this.getDesk(deskId);
    if (desk) {
      desk.state = state;
      return true;
    }
    return false;
  },
  removeClient(socket) {
    for (let i = 0, len = this.clients.length; i < len; i++) {
      if (this.clients[i].socket === socket) {
        this.clients.splice(i, 1);
        break;
      }
    }
  },
  addClient(socket, data) {
    this.clients.push({ userName: data.userName, uid: data.uid || 0, guestId: data.guestId || '', avatarUrl: data.avatarUrl || '', socket: socket, deskId: '', posId: '' });
  },
  getClient(socket) {
    for (let i = 0, len = this.clients.length; i < len; i++) {
      let client = this.clients[i];
      if (client.socket == socket) {
        return client;
      }
    }
    return null;
  },
  updateClientState(socket, deskId, posId) {
    let client = this.getClient(socket)
    if (client) {
      client.deskId = deskId !== undefined ? deskId : '';
      client.posId = posId !== undefined ? posId : '';
    }
  },
  getUserName(socket) {
    for (let i = 0, len = this.clients.length; i < len; i++) {
      if (this.clients[i].socket == socket) {
        return this.clients[i].userName;
      }
    }
    return null;
  },
  getUserAvatar(socket) {
    for (let i = 0, len = this.clients.length; i < len; i++) {
      if (this.clients[i].socket == socket) {
        return this.clients[i].avatarUrl || '';
      }
    }
    return '';
  },
  checkUserName(userName) {
    for (let i = 0, len = this.clients.length; i < len; i++) {
      if (this.clients[i].userName === userName) {
        return false;
      }
    }
    return true;
  },
  checkPrepareAll(deskId) {
    const desk = this.getDesk(deskId);
    if (desk) {
      const positions = desk.positions;
      for (let i = 0; i < positions.length; i++) {
        if (positions[i].state !== 2) {
          return false;
        }
      }
      return true;
    }
    return false;
  },
  createRoundHistory(deskId) {
    const room = this.getDesk(deskId);
    if (!room) return;
    const players = room.positions.filter(p => p.state > 0).map(p => {
      const client = this.clients.find(c => c.deskId === deskId && Number(c.posId) === Number(p.posId));
      return {
        posId: Number(p.posId),
        uid: client && client.uid ? String(client.uid) : '',
        guestId: client && client.guestId ? String(client.guestId) : '',
        username: String((client && client.userName) || p.userName || `玩家${Number(p.posId) + 1}`),
        isBot: !!p.isBot,
      };
    });
    this.roundHistories[deskId] = {
      roomCode: room.roomCode,
      deskId: room.deskId,
      gameType: room.gameType,
      gameLabel: room.gameLabel,
      isPrivate: !!room.isPrivate,
      aiDifficulty: room.aiDifficulty,
      aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(room.aiDifficulty),
      startedAt: Date.now(),
      endedAt: 0,
      players,
      moves: [],
      result: {},
    };
    db.recordSiteStat('game_starts', 1, room.gameType);
    db.recordSiteStat('player_rounds', players.filter(p => !p.isBot).length, room.gameType);
  },
  recordRoundMove(deskId, move) {
    const record = this.roundHistories[deskId];
    if (!record || !move) return;
    const copy = Object.assign({}, move, {
      seq: record.moves.length + 1,
      at: Date.now(),
    });
    if (Array.isArray(move.cards)) {
      copy.cards = move.cards.map(card => ({ value: Number(card.value), type: Number(card.type), ...(card.deck == null ? {} : { deck: Number(card.deck) }) }));
    }
    if (move.card) {
      copy.card = { value: Number(move.card.value), type: Number(move.card.type), ...(move.card.deck == null ? {} : { deck: Number(move.card.deck) }) };
    }
    if (move.meld && Array.isArray(move.meld.cards)) {
      copy.meld = Object.assign({}, move.meld, { cards: move.meld.cards.map(card => ({ value: Number(card.value), type: Number(card.type), ...(card.deck == null ? {} : { deck: Number(card.deck) }) })) });
    }
    record.moves.push(copy);
  },
  finishRoundHistory(deskId, result) {
    const record = this.roundHistories[deskId];
    if (!record) return;
    record.endedAt = Date.now();
    record.result = result || {};
    const gameType = record.gameType;
    delete this.roundHistories[deskId];
    db.recordSiteStat('games_completed', 1, gameType);
    db.saveHistory(record).catch(err => console.error('[history] 保存失败：', err && err.message));
  },
  startGame(deskId) {
    const room = this.getDesk(deskId);
    if (!room) return;
    room.pauseInfo = null;
    this.clearPauseTimer(deskId);
    if (this.gameDatas[deskId] === undefined) {
      this.gameDatas[deskId] = room.gameType === 'guandan'
        ? new GuandanGame({ levelRank: room.guandanLevelRank || 15 })
        : (room.gameType === 'mahjong' ? new MahjongGame() : new Game());
    }
    const game = this.gameDatas[deskId];
    game.init();
    const cards = game.start().getCards();
    this.createRoundHistory(deskId);
    this.updateRoomStatus(deskId, 2);
    this.refreshLobby();
    if (room.gameType === 'guandan') {
      this.broadCastRoom('GAME_START', deskId, {
        cards,
        gameType: room.gameType,
        aiDifficulty: room.aiDifficulty,
        aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(room.aiDifficulty),
        ctxPos: game.getContextPosId(),
        levelLabel: game.getLevelLabel(),
        levelRank: game.levelRank,
      });
      this.broadCastRoom('CTX_PLAY_CHANGE', deskId, {
        ctxData: { len: 0, key: '', type: '', cards: [], posId: game.getContextPosId() },
        posId: game.getContextPosId(),
        timeout: GUANDAN_PLAY_TIMEOUT,
        isPass: false,
        trickReset: true,
      });
      this.scheduleBotAction(deskId);
    } else if (room.gameType === 'mahjong') {
      this.broadCastRoom('GAME_START', deskId, {
        cards,
        gameType: room.gameType,
        aiDifficulty: room.aiDifficulty,
        aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(room.aiDifficulty),
        ctxPos: game.getContextPosId(),
        mahjong: game.getPublicState(),
      });
      this.broadcastMahjongState(deskId, { timeout: MAHJONG_PLAY_TIMEOUT });
      this.scheduleBotAction(deskId);
    } else {
      this.broadCastRoom('GAME_START', deskId, {
        cards,
        gameType: room.gameType,
        aiDifficulty: room.aiDifficulty,
        aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(room.aiDifficulty),
      });
      this.broadCastRoom('CTX_USER_CHANGE', deskId, { ctxPos: game.getContextPosId(), ctxScore: game.getContextScore(), timeout: DOU_DIZHU_STEP_TIMEOUT });
      this.scheduleBotAction(deskId);
    }
  },
  // ===== AI 机器人 =====
  hasHumanAtDesk(deskId) {
    return this.clients.some(c => c.deskId === deskId && c.posId !== 'spec');
  },
  seatBot(deskId, posId) {
    const desk = this.getDesk(deskId);
    if (!desk) return;
    const pos = this.getPosition(desk, posId);
    if (!pos) return;
    const used = desk.positions.map(x => String(x.userName || '').replace(/\s*〔AI〕$/, '')).filter(Boolean);
    const name = (BOT_NAMES.find(n => !used.includes(n)) || '清客') + ' 〔AI〕';
    pos.state = 2; pos.userName = name; pos.avatarUrl = ''; pos.isBot = true;
    this.broadCastRoom('POS_STATUS_CHANGE', deskId, { posId, state: 2, userName: name, avatarUrl: '', isBot: true });
    this.broadCastHouse('STATUS_CHANGE', { deskId, posId, state: 2 });
  },
  removeBot(deskId, posId) {
    const desk = this.getDesk(deskId);
    if (!desk) return null;
    const pos = this.getPosition(desk, posId);
    if (!pos || !pos.isBot) return null;
    const name = pos.userName;
    pos.state = 0; pos.userName = ''; pos.avatarUrl = ''; pos.isBot = false;
    this.broadCastRoom('POS_STATUS_CHANGE', deskId, { posId, state: 0, userName: '', avatarUrl: '' });
    this.broadCastHouse('STATUS_CHANGE', { deskId, posId, state: 0 });
    return name;
  },
  removeAllBots(deskId) {
    const desk = this.getDesk(deskId);
    if (!desk) return;
    desk.positions.forEach(p => { if (p.isBot) this.removeBot(deskId, p.posId); });
  },
  isBotPos(deskId, posId) {
    const desk = this.getDesk(deskId);
    if (!desk) return false;
    const p = this.getPosition(desk, posId);
    return !!(p && p.isBot);
  },
  rePrepareBots(deskId) {
    const desk = this.getDesk(deskId);
    if (!desk) return;
    desk.positions.forEach(p => {
      if (p.isBot) {
        p.state = 2;
        this.broadCastRoom('POS_STATUS_CHANGE', deskId, { posId: p.posId, state: 2, userName: p.userName, avatarUrl: p.avatarUrl || '', isBot: !!p.isBot });
      }
    });
    // 若房间内全员（含真人）已就绪则自动开新一局
    if (this.checkPrepareAll(deskId)) {
      this.startGame(deskId);
    }
  },
  // 根据对局结果为带 uid 的真人玩家写入积分
  recordResultToDb(deskId, result) {
    if (!result || result.draw || !db.isReady()) return;
    const desk = this.getDesk(deskId);
    if (!desk) return;
    const seats = desk.gameType === 'doudizhu' ? [0, 1, 2] : [0, 1, 2, 3];
    const landlordPosId = desk.gameType === 'doudizhu'
      ? (result.winner.length === 1 ? result.winner[0] : result.loser[0])
      : -1;
    const base = desk.gameType === 'guandan'
      ? (Number(result.rankDelta) || 1) * SCORE_BASE
      : (Number(result.score) || 1) * (Number(result.ratio) || 1) * SCORE_BASE;
    seats.forEach(posId => {
      // 找到该座位的真人客户端
      const client = this.clients.find(c => c.deskId === deskId && c.posId === posId);
      if (!client || !client.uid) return; // 未登录 / 机器人 / 观战 跳过
      const isLandlord = posId === landlordPosId;
      const win = result.winner.includes(posId);
      // 地主赢：+2*base；地主输：-2*base；农民赢：+base；农民输：-base
      const unit = desk.gameType === 'doudizhu' && isLandlord ? 2 : 1;
      const delta = (win ? 1 : -1) * unit * base;
      db.recordPlayer({
        gameType: desk.gameType,
        uid: client.uid,
        username: client.userName,
        delta,
        win,
        isLandlord,
      }).then(() => db.getUserScore(client.uid, desk.gameType))
        .then(row => { if (row) { try { client.socket.emit('MY_SCORE', Object.assign({ gameType: desk.gameType }, row)); } catch (e) {} } })
        .catch(e => console.error('[db] recordResultToDb 链式异常:', e && e.message));
    });
  },
  clearBotTimer(deskId) {
    if (this.botTimers[deskId]) { clearTimeout(this.botTimers[deskId]); this.botTimers[deskId] = null; }
  },
  clearPauseTimer(deskId) {
    if (this.pauseTimers[deskId]) { clearTimeout(this.pauseTimers[deskId]); this.pauseTimers[deskId] = null; }
  },
  isGamePaused(deskId) {
    const room = this.getDesk(deskId);
    return !!(room && room.pauseInfo);
  },
  isRoomOwner(socket, desk) {
    if (!socket || !desk || !desk.ownerName) return false;
    const userName = this.getUserName(socket);
    return !!userName && userName === desk.ownerName;
  },
  getGameTimeout(room, game) {
    if (!room || !game) return DOU_DIZHU_STEP_TIMEOUT;
    if (room.gameType === 'mahjong') return MAHJONG_PLAY_TIMEOUT;
    if (room.gameType === 'guandan') return GUANDAN_PLAY_TIMEOUT;
    return game.getStatus && game.getStatus() === 2 ? DOU_DIZHU_PLAY_TIMEOUT : DOU_DIZHU_STEP_TIMEOUT;
  },
  getGameSnapshot(deskId) {
    const desk = this.getDesk(deskId);
    const game = this.gameDatas[deskId];
    if (!desk || !game || !game.getStatus || game.getStatus() <= 0 || game.getStatus() >= 3) return null;
    const status = game.getStatus();
    const cards = (game.getCards && game.getCards()) || [];
    // 斗地主的 id=3 是底牌；掼蛋的四个 id 都是玩家手牌，不能误删 id=3。
    const handGroups = cards
      .filter(group => desk.gameType !== 'doudizhu' || group.id !== 3)
      .map(group => ({
        id: group.id,
        cards: (group.cards || []).map(card => ({ value: card.value, type: card.type, ...(card.deck == null ? {} : { deck: card.deck }) }))
      }));
    const snapshot = {
      status,
      gameType: desk.gameType,
      timeout: this.getGameTimeout(desk, game),
      aiDifficulty: desk.aiDifficulty,
      aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(desk.aiDifficulty),
      levelLabel: desk.guandanLevelLabel,
      levelRank: desk.guandanLevelRank,
      cards: handGroups,
      callScores: game.getCalledScores ? Object.assign({}, game.getCalledScores()) : {},
      ctxPosId: game.getContextPosId ? game.getContextPosId() : '',
      ctxScore: game.getContextScore ? game.getContextScore() : [],
      lastCardInfo: game.lastCardInfo ? Object.assign({}, game.lastCardInfo) : null,
    };
    if (desk.gameType === 'mahjong' && game.getPublicState) {
      snapshot.mahjong = game.getPublicState();
    }
    if (desk.gameType === 'doudizhu' && status >= 2) {
      snapshot.dizhuPosId = game.getDiZhuPosId ? game.getDiZhuPosId() : '';
      const top = (game.getTopCards && game.getTopCards()) || [];
      snapshot.topCards = top.map(card => ({ value: card.value, type: card.type }));
    }
    return snapshot;
  },
  getPlayerGameSnapshot(deskId, posId) {
    const desk = this.getDesk(deskId);
    const snapshot = this.getGameSnapshot(deskId);
    if (!desk || !snapshot) return snapshot;
    const ownPosId = Number(posId);
    snapshot.cards = (snapshot.cards || []).map(group => {
      if (Number(group.id) === ownPosId) return group;
      return Object.assign({}, group, {
        // 新接管的真人只拿到自己的手牌；其他座位只同步张数，避免
        // 顶号时把未公开手牌发到浏览器端。
        cards: (group.cards || []).map(() => ({ value: 0, type: 0, hidden: true })),
      });
    });
    return snapshot;
  },
  getPausePayload(room) {
    if (!room || !room.pauseInfo) return null;
    return {
      posId: room.pauseInfo.posId,
      playerName: room.pauseInfo.playerName || '玩家',
      expiresAt: room.pauseInfo.expiresAt,
      remainingMs: Math.max(0, room.pauseInfo.expiresAt - Date.now()),
    };
  },
  getGameResumePayload(deskId) {
    const room = this.getDesk(deskId);
    const game = this.gameDatas[deskId];
    if (!room || !game) return null;
    const payload = {
      gameType: room.gameType,
      aiDifficulty: room.aiDifficulty,
      aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(room.aiDifficulty),
      status: game.getStatus ? game.getStatus() : 0,
      ctxPos: game.getContextPosId ? game.getContextPosId() : '',
      ctxScore: game.getContextScore ? game.getContextScore() : [],
      calledScores: game.getCalledScores ? Object.assign({}, game.getCalledScores()) : {},
      lastCardInfo: game.lastCardInfo ? Object.assign({}, game.lastCardInfo) : null,
      timeout: this.getGameTimeout(room, game),
    };
    if (room.gameType === 'mahjong' && game.getPublicState) {
      payload.mahjong = game.getPublicState();
      payload.ctxPos = payload.mahjong.ctxPos;
      payload.timeout = MAHJONG_PLAY_TIMEOUT;
    }
    if (room.gameType === 'doudizhu' && payload.status >= 2) {
      payload.dizhuPosId = game.getDiZhuPosId ? game.getDiZhuPosId() : '';
      payload.topCards = (game.getTopCards ? game.getTopCards() : []).map(card => ({ value: card.value, type: card.type }));
    }
    return payload;
  },
  pauseGameForMissingPlayer(deskId, posId, playerName) {
    const room = this.getDesk(deskId);
    const game = this.gameDatas[deskId];
    if (!room || !game || !game.getStatus || game.getStatus() <= 0 || game.getStatus() >= 3) return false;
    this.clearBotTimer(deskId);
    this.clearMahjongClaimTimer(deskId);
    this.clearPauseTimer(deskId);
    room.pauseInfo = {
      posId: Number(posId),
      playerName: playerName || '玩家',
      expiresAt: Date.now() + GAME_PAUSE_GRACE_MS,
    };
    this.broadCastRoom('GAME_PAUSED', deskId, this.getPausePayload(room));
    this.refreshLobby();
    this.pauseTimers[deskId] = setTimeout(() => this.expirePausedGame(deskId), GAME_PAUSE_GRACE_MS + 100);
    return true;
  },
  resumePausedGame(deskId, source) {
    const room = this.getDesk(deskId);
    if (!room || !room.pauseInfo) return false;
    const paused = room.pauseInfo;
    this.clearPauseTimer(deskId);
    room.pauseInfo = null;
    const payload = this.getGameResumePayload(deskId);
    if (payload) {
      payload.source = source || 'human';
      payload.posId = paused.posId;
      payload.isBot = this.isBotPos(deskId, paused.posId);
      this.broadCastRoom('GAME_RESUMED', deskId, payload);
    }
    this.refreshLobby();
    this.scheduleBotAction(deskId);
    return true;
  },
  expirePausedGame(deskId) {
    const room = this.getDesk(deskId);
    const game = this.gameDatas[deskId];
    if (!room || !room.pauseInfo) return;
    const paused = room.pauseInfo;
    this.clearPauseTimer(deskId);
    room.pauseInfo = null;
    this.clearBotTimer(deskId);
    this.clearMahjongClaimTimer(deskId);
    if (game) game.init();
    delete this.roundHistories[deskId];
    room.positions.forEach(pos => {
      if (pos.state > 0 && !pos.isBot) pos.state = 1;
    });
    this.updateRoomStatus(deskId, 0);
    this.broadCastRoom('GAME_PAUSE_EXPIRED', deskId, {
      posId: paused.posId,
      playerName: paused.playerName || '玩家',
    });
    this.broadCastRoom('ROOM_STATUS_CHANGE', deskId, { state: 0 });
    this.refreshLobby();
    this.cleanupRoomIfEmpty(deskId);
  },
  clearMahjongClaimTimer(deskId) {
    if (this.mahjongClaimTimers[deskId]) {
      clearTimeout(this.mahjongClaimTimers[deskId]);
      this.mahjongClaimTimers[deskId] = null;
    }
  },
  broadcastMahjongState(deskId, options) {
    options = options || {};
    const game = this.gameDatas[deskId];
    if (!game || typeof game.getPublicState !== 'function') return;
    const state = game.getPublicState();
    const room = this.getDesk(deskId);
    if (!room) return;
    this.clearMahjongClaimTimer(deskId);

    this.clients.forEach(client => {
      if (client.deskId !== deskId) return;
      const posId = Number(client.posId);
      const canActions = client.posId === 'spec' ? [] : (state.claimOptions[posId] || []);
      const payload = {
        ctxPos: state.ctxPos,
        action: state.action,
        wallCount: state.wallCount,
        handCounts: state.handCounts,
        discards: state.discards,
        melds: state.melds,
        lastDiscard: state.lastDiscard,
        canActions,
        timeout: options.timeout || MAHJONG_PLAY_TIMEOUT,
      };
      if (options.meld) payload.meld = options.meld;
      if (options.discard) payload.discard = options.discard;
      if (options.drawCard) {
        payload.drawFor = state.ctxPos;
        if (Number(client.posId) === Number(state.ctxPos)) payload.drawCard = options.drawCard;
      }
      client.socket.emit('MAHJONG_STATE', payload);
    });

    if (game.getPendingClaim() && game.getPendingClaim().eligible.length) {
      this.mahjongClaimTimers[deskId] = setTimeout(() => {
        const current = this.gameDatas[deskId];
        const pending = current && current.getPendingClaim && current.getPendingClaim();
        if (!pending) return;
        pending.eligible.forEach(posId => {
          if (!pending.responded[posId]) current.passClaim(posId);
        });
        if (current.getStatus() === 3) {
          this.finishMahjongGame(deskId, current.getResult());
          return;
        }
        this.broadcastMahjongState(deskId, { timeout: MAHJONG_PLAY_TIMEOUT });
        this.scheduleBotAction(deskId);
      }, MAHJONG_PLAY_TIMEOUT * 1000);
    }
  },
  finishMahjongGame(deskId, result) {
    const room = this.getDesk(deskId);
    const game = this.gameDatas[deskId];
    if (!room || !game || !result) return;
    this.clearBotTimer(deskId);
    this.clearMahjongClaimTimer(deskId);
    this.broadCastRoom('GAME_OVER', deskId, result);
    this.finishRoundHistory(deskId, result);
    this.recordResultToDb(deskId, result);
    room.positions.forEach(p => this.updatePosStatus(deskId, p.posId, 1));
    this.updateRoomStatus(deskId, 3);
    game.init();
    this.rePrepareBots(deskId);
    this.refreshLobby();
  },
  scheduleBotAction(deskId) {
    this.clearBotTimer(deskId);
    const room = this.getDesk(deskId);
    if (!room) return;
    if (room.pauseInfo) return;
    const game = this.gameDatas[deskId];
    if (!game) return;
    const status = game.getStatus();
    if (room.gameType === 'doudizhu' && status !== 1 && status !== 2) return;
    if ((room.gameType === 'guandan' || room.gameType === 'mahjong') && status !== 2) return;
    if (room.gameType === 'mahjong') {
      this.scheduleMahjongBotAction(deskId);
      return;
    }
    const posId = game.getContextPosId();
    if (!this.isBotPos(deskId, posId)) return;
    const delay = AiDifficulty.reactionDelay(room.aiDifficulty);
    this.botTimers[deskId] = setTimeout(() => {
      this.botTimers[deskId] = null;
      if (!this.isBotPos(deskId, posId)) return;
      const g = this.gameDatas[deskId];
      if (!g) return;
      if (room.gameType === 'guandan' && g.getStatus() === 2 && g.getContextPosId() === posId) {
        this.botPlayGuandanCard(deskId, posId);
      } else if (g.getStatus() === 1 && g.getContextPosId() === posId) {
        this.botCallScore(deskId, posId);
      } else if (g.getStatus() === 2 && g.getContextPosId() === posId) {
        this.botPlayCard(deskId, posId);
      }
    }, delay);
  },
  scheduleMahjongBotAction(deskId) {
    const room = this.getDesk(deskId);
    const game = this.gameDatas[deskId];
    if (!room || room.pauseInfo || !game || game.getStatus() !== 2) return;
    this.clearBotTimer(deskId);
    const pending = game.getPendingClaim && game.getPendingClaim();
    let botPos = null;
    if (pending) {
      botPos = pending.eligible.find(posId => !pending.responded[posId] && this.isBotPos(deskId, posId));
    } else if (this.isBotPos(deskId, game.getContextPosId())) {
      botPos = game.getContextPosId();
    }
    if (botPos == null) return;
    this.botTimers[deskId] = setTimeout(() => {
      this.botTimers[deskId] = null;
      this.botPlayMahjong(deskId, botPos);
    }, AiDifficulty.reactionDelay(room.aiDifficulty));
  },
  botPlayMahjong(deskId, posId) {
    const room = this.getDesk(deskId);
    const game = this.gameDatas[deskId];
    if (!room || room.pauseInfo || !game || game.getStatus() !== 2 || !this.isBotPos(deskId, posId)) return;
    const pending = game.getPendingClaim && game.getPendingClaim();
    const publicState = game.getPublicState();
    const aiOptions = {
      difficulty: room.aiDifficulty,
      openMelds: (publicState.melds[posId] || []).length,
      discards: publicState.discards,
      melds: publicState.melds,
      selfPos: Number(posId),
      wallCount: publicState.wallCount,
    };
    let ret;
    if (pending) {
      const options = game.getTurnOptions(posId);
      const decision = MahjongAI.chooseClaim(game.getCardsByPosId(posId) || [], options, pending.card, aiOptions);
      const action = options.includes(decision.action) ? decision.action : 'pass';
      ret = action === 'pass' ? game.passClaim(posId) : game.claim(posId, action);
      this.recordRoundMove(deskId, { type: 'mahjong', action, posId: Number(posId), card: pending.card, meld: ret && ret.meld, source: 'ai' });
      if (ret && ret.result) {
        this.finishMahjongGame(deskId, ret.result);
        return;
      }
      if (ret && ret.status && ret.meld) {
        this.broadcastMahjongState(deskId, { meld: Object.assign({ posId, type: action }, ret.meld), drawCard: ret.drawCard, timeout: MAHJONG_PLAY_TIMEOUT });
      } else if (ret && ret.status && !ret.waiting) {
        this.broadcastMahjongState(deskId, { drawCard: ret.drawCard, timeout: MAHJONG_PLAY_TIMEOUT });
      } else if (ret && ret.status && ret.waiting) {
        this.broadcastMahjongState(deskId, { timeout: MAHJONG_PLAY_TIMEOUT });
      }
      if (game.getStatus() === 3) {
        this.finishMahjongGame(deskId, game.getResult());
        return;
      }
      this.scheduleMahjongBotAction(deskId);
      return;
    }

    if (game.getContextPosId() !== Number(posId) || game.getCurrentAction() !== 'discard') return;
    const options = game.getTurnOptions(posId);
    if (options.includes('hu')) {
      ret = game.finishWin(posId, null, '自摸');
      this.recordRoundMove(deskId, { type: 'mahjong', action: 'hu', posId: Number(posId), source: 'ai' });
      this.finishMahjongGame(deskId, ret.result);
      return;
    }
    const hand = game.getCardsByPosId(posId) || [];
    const gangDecision = options.includes('gang') ? MahjongAI.shouldConcealedGang(hand, aiOptions) : { action: 'pass' };
    if (gangDecision.action === 'gang') {
      ret = game.concealedGang(posId, gangDecision.card);
      if (ret && ret.status) {
        this.recordRoundMove(deskId, { type: 'mahjong', action: 'gang', posId: Number(posId), card: gangDecision.card, meld: ret.meld, source: 'ai' });
        if (ret.result) {
          this.finishMahjongGame(deskId, ret.result);
          return;
        }
        this.broadcastMahjongState(deskId, { meld: Object.assign({ posId, type: 'angang' }, ret.meld), drawCard: ret.drawCard, timeout: MAHJONG_PLAY_TIMEOUT });
        this.scheduleMahjongBotAction(deskId);
        return;
      }
    }
    if (!hand.length) return;
    const advice = MahjongAI.suggestDiscard(hand, aiOptions);
    const pick = hand.find(card => Number(card.value) === Number(advice.card && advice.card.value)) || hand[hand.length - 1];
    ret = game.discard(posId, pick);
    if (!ret || !ret.status) return;
    this.recordRoundMove(deskId, { type: 'mahjong', action: 'discard', posId: Number(posId), card: ret.card || pick, source: 'ai' });
    this.broadCastRoom('MAHJONG_DISCARD', deskId, { posId, card: ret.card });
    if (game.getStatus() === 3) {
      this.finishMahjongGame(deskId, game.getResult());
      return;
    }
    this.broadcastMahjongState(deskId, { drawCard: ret.drawCard, timeout: MAHJONG_PLAY_TIMEOUT });
    this.scheduleMahjongBotAction(deskId);
  },
  botCallScore(deskId, posId) {
    if (this.isGamePaused(deskId)) return;
    const game = this.gameDatas[deskId];
    if (!game) return;
    const ctxScore = game.getContextScore() || [];
    const hand = game.getCardsByPosId(posId) || [];
    const bid = AiDifficulty.doudizhuBid(hand, ctxScore, this.getDesk(deskId) && this.getDesk(deskId).aiDifficulty);
    const score = bid.score;
    const status = game.next(posId, score).getStatus();
    this.recordRoundMove(deskId, { type: 'call', posId: Number(posId), score: Number(score), source: 'ai' });
    if (status == 1) {
      this.broadCastRoom('CTX_USER_CHANGE', deskId, {
        ctxPos: game.getContextPosId(),
        ctxScore: game.getContextScore(),
        calledScores: game.getCalledScores(),
        timeout: DOU_DIZHU_STEP_TIMEOUT
      });
      this.scheduleBotAction(deskId);
    }
    if (status == 2) {
      const topCards = game.getTopCards();
      const dizhuPosId = game.getDiZhuPosId();
      this.broadCastRoom('SHOW_TOP_CARD', deskId, { topCards, dizhuPosId, timeout: DOU_DIZHU_STEP_TIMEOUT });
      this.broadCastRoom('CTX_PLAY_CHANGE', deskId, {
        ctxData: { len: 0, key: '', type: '', cards: [], posId: dizhuPosId },
        posId: dizhuPosId, timeout: DOU_DIZHU_PLAY_TIMEOUT, isPass: false
      });
      this.scheduleBotAction(deskId);
    }
    if (status == 4) {
      this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: '本局无人叫分，重新发牌', id: guid(), time: time() });
      this.startGame(deskId);
    }
  },
  botPlayCard(deskId, posId) {
    if (this.isGamePaused(deskId)) return;
    const room = this.getDesk(deskId);
    const game = this.gameDatas[deskId];
    if (!room || !game) return;
    const handRaw = (game.getCardsByPosId(posId) || []).slice(0);
    const hand = handRaw.map(c => ({ value: c.value, type: c.type }));
    const last = game.lastCardInfo || {};
    const lastInfo = (last.posId === posId || !last.len) ? { len: 0, ctxPos: 'self' } : {
      len: last.len, key: last.key, type: last.type, ctxPos: 'other'
    };
    const landlordId = Number(game.getDiZhuPosId());
    const lastPosId = Number(last.posId);
    const selfIsLandlord = Number(posId) === landlordId;
    const lastIsPartner = !selfIsLandlord && last.len > 0 && lastPosId !== landlordId && lastPosId !== Number(posId);
    const opponentIds = selfIsLandlord ? [0, 1, 2].filter(id => id !== Number(posId)) : [landlordId];
    const opponentMinCardCount = opponentIds.reduce((min, id) => Math.min(min, (game.getCardsByPosId(id) || []).length || 99), 99);
    const partnerId = selfIsLandlord ? -1 : [0, 1, 2].find(id => id !== Number(posId) && id !== landlordId);
    const aiOptions = {
      difficulty: room.aiDifficulty,
      role: selfIsLandlord ? 'landlord' : 'farmer',
      lastIsPartner,
      opponentMinCardCount,
      partnerCardCount: partnerId == null || partnerId < 0 ? 99 : (game.getCardsByPosId(partnerId) || []).length,
      cardCounts: [0, 1, 2].map(id => (game.getCardsByPosId(id) || []).length),
      seenCards: game.getPlayedCards ? game.getPlayedCards() : [],
    };
    let picks = [];
    const allOut = game.validate(posId, handRaw);
    if (allOut && allOut.status) {
      picks = handRaw.map(c => ({ value: c.value, type: c.type }));
    } else {
      try { picks = AiDifficulty.doudizhuSuggest(hand, lastInfo, aiOptions) || []; } catch (e) { picks = AISuggest.suggest(hand, lastInfo) || []; }
    }
    // 解析为真实牌实例（按下标占用避免重复）
    const used = new Set();
    let data = [];
    picks.forEach(p => {
      for (let i = 0; i < handRaw.length; i++) {
        if (used.has(i)) continue;
        const c = handRaw[i];
        if (c.value === p.value && c.type === p.type) {
          data.push(c); used.add(i); break;
        }
      }
    });
    let isPass = !data.length;
    let ret = isPass ? { status: true, key: '', type: '' } : game.validate(posId, data);
    if (!ret.status && !isPass) {
      // 兜底：若可不出则不出，否则随便出最小一张
      if (last.posId !== posId && last.len > 0) {
        data = []; isPass = true; ret = { status: true, key: '', type: '' };
      } else {
        data = [handRaw[0]]; isPass = false; ret = game.validate(posId, data);
        if (!ret.status) { data = []; isPass = true; ret = { status: true, key: '', type: '' }; }
      }
    }
    game.next(posId, data);
    this.recordRoundMove(deskId, { type: 'play', posId: Number(posId), cards: data, pass: isPass, cardType: ret.type || '', source: 'ai' });
    this.broadCastRoom('CTX_PLAY_CHANGE', deskId, {
      ctxData: { len: data.length, key: ret.key, type: ret.type, cards: data, posId },
      posId: game.getContextPosId(), timeout: DOU_DIZHU_STEP_TIMEOUT, isPass
    });
    if (game.getStatus() === 3) {
      const result = game.getResult();
      this.broadCastRoom('GAME_OVER', deskId, result);
      this.finishRoundHistory(deskId, result);
      this.recordResultToDb(deskId, result);
      this.updatePosStatus(deskId, 0, 1);
      this.updatePosStatus(deskId, 1, 1);
      this.updatePosStatus(deskId, 2, 1);
      game.init();
      this.clearBotTimer(deskId);
      this.rePrepareBots(deskId);
      return;
    }
    this.scheduleBotAction(deskId);
  },
  botPlayGuandanCard(deskId, posId) {
    const room = this.getDesk(deskId);
    const game = this.gameDatas[deskId];
    if (!room || room.pauseInfo || !game) return;
    const handRaw = (game.getCardsByPosId(posId) || []).slice(0);
    const last = game.lastCardInfo || {};
    const lead = !last.len || Number(last.posId) === Number(posId);
    const teammateId = (Number(posId) + 2) % 4;
    const opponents = [0, 1, 2, 3].filter(id => id % 2 !== Number(posId) % 2);
    const opponentMinCardCount = opponents.reduce((min, id) => {
      const n = (game.getCardsByPosId(id) || []).length;
      return Math.min(min, n || 99);
    }, 99);
    let data = [];
    try {
      data = AiDifficulty.guandanSuggest(handRaw, lead ? { len: 0, ctxPos: 'self' } : {
        len: last.len,
        key: last.key,
        type: last.type,
        bomb: !!last.bomb,
        bombPower: last.bombPower || 0,
        ctxPos: 'other',
      }, {
        difficulty: room.aiDifficulty,
        levelRank: game.levelRank,
        lastIsPartner: !lead && Number(last.posId) % 2 === Number(posId) % 2,
        teammateCardCount: (game.getCardsByPosId(teammateId) || []).length,
        opponentMinCardCount,
        seenCards: game.getPlayedCards ? game.getPlayedCards() : [],
      }) || [];
    } catch (e) {
      data = [];
    }
    let isPass = !data.length;
    let ret = isPass ? game.validate(posId, []) : game.validate(posId, data);

    if ((!ret || !ret.status) && lead && handRaw.length) {
      data = [sortByCard(handRaw)[0]];
      ret = game.validate(posId, data);
      isPass = false;
    }
    if (!ret || !ret.status) {
      data = [];
      isPass = true;
      ret = game.validate(posId, []);
    }
    if (!ret || !ret.status) return;

    game.next(posId, data);
    this.recordRoundMove(deskId, { type: 'play', posId: Number(posId), cards: data, pass: isPass, cardType: ret.type || '', source: 'ai' });
    const trickReset = !!(game.lastCardInfo && !game.lastCardInfo.len);
    this.broadCastRoom('CTX_PLAY_CHANGE', deskId, {
      ctxData: { len: data.length, key: ret.key, type: ret.type, cards: data, posId },
      posId: game.getContextPosId(),
      timeout: GUANDAN_PLAY_TIMEOUT,
      isPass,
      trickReset,
    });

    if (game.getStatus() === 3) {
      const result = game.getResult();
      this.applyGuandanResult(deskId, result);
      this.broadCastRoom('GAME_OVER', deskId, result);
      this.finishRoundHistory(deskId, result);
      this.recordResultToDb(deskId, result);
      room.positions.forEach(p => this.updatePosStatus(deskId, p.posId, 1));
      this.updateRoomStatus(deskId, 3);
      game.init();
      this.clearBotTimer(deskId);
      this.rePrepareBots(deskId);
      this.refreshLobby();
      return;
    }
    this.scheduleBotAction(deskId);
  },
  init() {
    // 启动期完整性自检
    if (this.JWT_SECRET === 'change_this_in_production') {
      console.warn('[WARN] JWT_SECRET 使用默认占位值，跨域 SSO token 必然校验失败。请在启动 node 进程时设置 JWT_SECRET 环境变量，并与论坛侧 DISCUZ_SSO_SECRET 保持一致。');
    }
    try { require.resolve('jsonwebtoken'); }
    catch (e) { console.error('[FATAL] 缺少 jsonwebtoken 依赖，请运行 npm install jsonwebtoken'); }

    // socket.io middleware: verify JWT token if provided during handshake
    io.use((socket, next) => {
      const authToken = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
      const queryToken = socket.handshake && socket.handshake.query && socket.handshake.query.token;
      const allowQueryToken = process.env.ALLOW_QUERY_TOKEN === '1' || process.env.ALLOW_QUERY_TOKEN === 'true';
      const token = authToken || (allowQueryToken ? queryToken : '');
      if (!token) return next();
      let jwt;
      try { jwt = require('jsonwebtoken'); }
      catch (e) {
        socket.tokenError = '服务器未安装 jsonwebtoken 模块';
        return next();
      }
      try {
        const payload = verifyCompatibleJwt(token, this.JWT_SECRET, jwt);
        if (!payload || !payload.uid) {
          socket.tokenError = 'token 缺少 uid';
        } else {
          socket.user = {
            uid: payload.uid,
            username: payload.username,
            avatarUrl: payload.avatarUrl || payload.avatar || payload.avatar_url || discuzAvatarUrl(payload.uid),
          };
        }
      } catch (err) {
        const msg = err && err.message || 'unknown';
        console.warn('JWT verify failed:', msg);
        // 把可读原因翻译给前端
        if (err && err.name === 'TokenExpiredError') socket.tokenError = '登录态已过期，请重新登录';
        else if (err && err.name === 'JsonWebTokenError') socket.tokenError = '登录凭证无效（签名不匹配，请检查服务器 JWT_SECRET）';
        else socket.tokenError = '登录凭证校验失败：' + msg;
      }
      return next();
    });

    io.on('connection', function (socket) {
      console.log('有客户端接入，时间： %s', time());
      db.recordSiteStat('socket_connections');
      // 校验失败 → 立刻通知前端，避免它卡在"正在登录…"
      if (socket.tokenError) {
        socket.emit('LOGIN_FAIL', { msg: socket.tokenError, code: 'TOKEN_INVALID' });
      }
      // 新连接先拿一份当前快照，后续由 SITE_STATS_UPDATE 持续刷新。
      db.getSiteStats().then(stats => socket.emit('SITE_STATS_UPDATE', publicSiteStats(stats))).catch(() => {});
      // if socket was authenticated via token, auto-register client
      if (socket.user) {
        try {
          // 同名旧连接踢掉（页面刷新/双开），避免 checkUserName 死锁
          for (let i = this.clients.length - 1; i >= 0; i--) {
            const c = this.clients[i];
            if (c.userName === socket.user.username && c.socket !== socket) {
              try { c.socket.emit('FORCE_LOGOUT', { msg: '账号在别处登录' }); c.socket.disconnect(true); } catch (e) {}
              this.clients.splice(i, 1);
            }
          }
          this.addClient(socket, { userName: socket.user.username, uid: socket.user.uid, avatarUrl: socket.user.avatarUrl });
          socket.emit('WHOAMI', { uid: socket.user.uid, username: socket.user.username, avatarUrl: socket.user.avatarUrl });
          socket.emit('LOGIN_SUCCESS', this.getLobbyRooms());
          console.log('已通过 token 自动登录用户：%s (uid=%s)', socket.user.username, socket.user.uid);
          // 推送一次该用户的积分
          db.getUserScore(socket.user.uid).then(row => { if (row) socket.emit('MY_SCORE', row); }).catch(() => {});
        } catch (e) {
          console.error('自动登录出错', e);
        }
      }
      socket.on('LOGIN', data => {
        const userName = typeof data === 'string' ? data : (data && data.userName);
        const guestId = typeof data === 'object' && data ? String(data.guestId || '').slice(0, 128) : '';
        if (this.checkUserName(userName)) {
          this.addClient(socket, { userName, guestId });
          socket.emit('LOGIN_SUCCESS', this.getLobbyRooms());
          console.log('有客户端登录，时间： %s', time());
        } else {
          socket.emit('LOGIN_FAIL', { msg: '该用户名已存在' });
        }
      });

      socket.on('CREATE_ROOM', data => {
        const client = this.getClient(socket);
        if (!client || client.deskId) return;
        const room = this.createRoom({
          gameType: data && data.gameType,
          isPrivate: !!(data && data.isPrivate),
          ownerName: this.getUserName(socket),
        });
        this.refreshLobby();
        socket.emit('ROOM_CREATED', {
          deskId: room.deskId,
          roomCode: room.roomCode,
          gameType: room.gameType,
          isPrivate: room.isPrivate,
          aiDifficulty: room.aiDifficulty,
          aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(room.aiDifficulty),
        });
        this.reservePosition(room, 0, socket);
        socket.emit('QUICK_JOIN', { deskId: room.deskId, posId: 0, success: true });
      });

      socket.on('JOIN_ROOM', data => {
        const client = this.getClient(socket);
        if (!client || client.deskId) return;
        const room = this.findRoomByCode(data && data.roomCode);
        if (!room) {
          socket.emit('SITDOWN_ERROR', { msg: '房间不存在' });
          return;
        }
        const pos = this.getFirstOpenPos(room);
        const botPos = pos ? null : this.getRandomBotPos(room);
        if (!pos && !botPos) {
          socket.emit('SITDOWN_ERROR', { msg: '房间已满' });
          return;
        }
        const target = pos || botPos;
        this.reservePosition(room, target.posId, socket);
        socket.emit('QUICK_JOIN', { deskId: room.deskId, posId: target.posId, success: true, takeoverBot: !!botPos });
      });

      // 真人接管 AI：服务端随机挑选一个未被其他人预占的 AI 座位，避免客户端
      // 自己指定座位造成抢占竞态；SITDOWN 仍会再次校验 pendingSocketId。
      socket.on('TAKEOVER_BOT', data => {
        const client = this.getClient(socket);
        if (!client || client.deskId) {
          socket.emit('SITDOWN_ERROR', { msg: '请先退出当前房间' });
          return;
        }
        const room = this.getDesk(data && data.deskId);
        if (!room) {
          socket.emit('SITDOWN_ERROR', { msg: '房间不存在' });
          return;
        }
        const botPos = this.getRandomBotPos(room);
        if (!botPos) {
          socket.emit('SITDOWN_ERROR', { msg: '当前没有可接管的 AI' });
          return;
        }
        this.reservePosition(room, botPos.posId, socket);
        socket.emit('QUICK_JOIN', {
          deskId: room.deskId,
          posId: botPos.posId,
          success: true,
          takeoverBot: true,
        });
      });

      //快速加入
      socket.on('QUICK_JOIN', data => {
        const gameType = normalizeGameType(data && data.gameType);
        var ret = [];
        this.desks.filter(room => !room.isPrivate && room.gameType === gameType).forEach(desk => {
          let n = 0;
          let item = {
            deskId: desk.deskId,
            positions: [],
            botPositions: [],
          };
          const positions = desk.positions;
          positions.forEach(pos => {
            if (pos.state > 0) {
              n++;
            } else if (!pos.pendingSocketId) {
              item.positions.push(pos.posId)
            }
          });
          // AI 处于 state=2，单独收集，只有真人没有空座时才作为接管候选。
          desk.positions.forEach(pos => {
            if (pos.isBot && !pos.pendingSocketId) item.botPositions.push(pos.posId);
          });
          if (item.positions.length > 0 || item.botPositions.length > 0) {
            ret.push(item);
          }
        });
        ret = ret.sort((a, b) => {
          const aHasOpen = a.positions.length > 0 ? 0 : 1;
          const bHasOpen = b.positions.length > 0 ? 0 : 1;
          return aHasOpen - bHasOpen || (b.positions.length + b.botPositions.length) - (a.positions.length + a.botPositions.length);
        });
        let matched = ret.length ? ret[0] : false;
        if (!matched) {
          const room = this.createRoom({
            gameType,
            isPrivate: false,
            ownerName: this.getUserName(socket),
          });
          this.refreshLobby();
          matched = { deskId: room.deskId, positions: [0], botPositions: [] };
        }
        const targetPosId = matched && matched.positions && matched.positions.length
          ? matched.positions[0]
          : (matched && matched.botPositions && matched.botPositions.length ? matched.botPositions[0] : null);
        if (matched && targetPosId != null) {
          const room = this.getDesk(matched.deskId);
          this.reservePosition(room, targetPosId, socket);
        }
        const payload = matched && targetPosId != null
          ? { deskId: matched.deskId, posId: targetPosId, success: true, takeoverBot: !(matched.positions && matched.positions.length) }
          : { success: false }
        socket.emit('QUICK_JOIN', payload)

      });

      socket.on('SITDOWN', data => {
        const client = this.getClient(socket);
        if (!client) {
          return;
        }
        const { deskId, posId } = data;
        const desk = this.getDesk(deskId);
        const pos = desk && this.getPosition(desk, posId);
        const game = this.gameDatas[deskId];
        const inProgress = !!(game && game.getStatus && game.getStatus() > 0 && game.getStatus() < 3);
        const pausedForPosition = !!(desk && desk.pauseInfo && Number(desk.pauseInfo.posId) === Number(posId));
        const reservedForMe = pos && (!pos.pendingSocketId || pos.pendingSocketId === socket.id);
        const takingBot = !!(pos && pos.isBot);
        const canTake = pos && ((pos.state === 0 && reservedForMe) || (takingBot && reservedForMe));
        if (canTake) {
          pos.pendingSocketId = '';
          if (pos.isBot) {
            const oldName = pos.userName;
            this.removeBot(deskId, posId);
            this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: `[${oldName}] 拱手让座`, id: guid(), time: time() });
          }
          console.log('有客户端进入房间，桌号：%s，座位：%s，时间： %s', deskId, posId, time());
          //更新座位状态为占用
          const avatarUrl = this.getUserAvatar(socket);
          this.updatePosStatus(deskId, posId, 1, this.getUserName(socket), avatarUrl);
          //绑定客户端桌号，座位号
          this.updateClientState(socket, deskId, posId);
          //获取除当前房间其它座位信息
          let posInfos = this.getOtherPosInfo(deskId, posId);
          //通知该客户端坐下成功 并发送当前房间的信息给该客户端
          socket.emit('SITDOWN_SUCCESS', {
            ...data,
            roomCode: desk.roomCode,
            gameType: desk.gameType,
            gameLabel: desk.gameLabel,
            seatCount: desk.seatCount,
            isPrivate: desk.isPrivate,
            guandanLevelLabel: desk.guandanLevelLabel,
            guandanLevelRank: desk.guandanLevelRank,
            ownerName: desk.ownerName,
            aiDifficulty: desk.aiDifficulty,
            aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(desk.aiDifficulty),
            takeoverBot: takingBot,
            gameInProgress: inProgress,
            snapshot: inProgress ? this.getPlayerGameSnapshot(deskId, posId) : null,
            paused: this.getPausePayload(desk),
            positions: desk.positions,
            posInfos
          });
          //通知在大厅游览的所有客户端当前坐位已被占用
          this.broadCastHouse('STATUS_CHANGE', { deskId, posId, state: 1 });
          this.refreshLobby();

          //通知在房间里的其它客户端，更新座位息
          this.broadCastRoom("POS_STATUS_CHANGE", deskId, { posId, state: 1, userName: this.getUserName(socket), avatarUrl, isBot: false }, socket);

          //推送一条无关紧要的消息
          socket.emit('USER_MESSAGE', { type: 'SYS', posId, msg: '欢迎您加入本房间，祝您游戏愉快！', id: guid(), time: time() });
          this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: `玩家[${this.getUserName(socket)}]进入房间`, id: guid(), time: time() }, socket);
          if (pausedForPosition) {
            this.resumePausedGame(deskId, 'human');
          }
        } else {
          //通知该客户端此座位被人占用
          socket.emit('SITDOWN_ERROR', { msg: '该位置已有人' });
          //由于当前位置被占用可能是由于该客户端数据不同步造成，所以再次向该客户端推送一次所有桌数据
          socket.emit('REFRESH_LIST', this.getLobbyRooms());
        }
      });

      socket.on('UNSITDOWN', data => {
        const client = this.getClient(socket);
        if (!client) {
          return;
        }
        const { deskId, posId } = client;
        if (!deskId) {
          return;
        }
        // 观战者走专用退出逻辑
        if (posId === 'spec') {
          this.updateClientState(socket);
          socket.emit('UNSITDOWN_SUCCESS', this.getLobbyRooms());
          return;
        }
        console.log('有客户端退出房间，桌号：%s，座位：%s，时间：', deskId, posId, time());
        const desk = this.getDesk(deskId);
        const game = this.gameDatas[deskId];
        const inProgress = !!(game && game.getStatus && game.getStatus() > 0 && game.getStatus() < 3);
        const leavingName = this.getUserName(socket) || (desk && this.getPosition(desk, posId) && this.getPosition(desk, posId).userName) || '玩家';
        //更新座位状态
        this.updatePosStatus(deskId, posId, 0, '');
        //解绑座位号 桌号
        this.updateClientState(socket);
        //通知在房间里的其它客户端，更新座位息
        this.broadCastRoom("POS_STATUS_CHANGE", deskId, { posId, state: 0, userName: '', avatarUrl: '' }, socket);
        //通知大厅其它客户端更新该座位信息
        this.broadCastHouse('STATUS_CHANGE', { deskId, posId, state: 0 });

        if (inProgress) {
          // 保留 game 对象和牌局状态，进入一分钟暂停窗口；房主可以用 AI 补位。
          this.updateOtherPosStatus(deskId, posId, 1);
          this.broadCastRoom("POS_STATUS_RESET", deskId, { pos: this.getOtherPosInfo(deskId, posId), state: 1 });
          this.pauseGameForMissingPlayer(deskId, posId, leavingName);
        } else {
          // 非对局阶段仍按原逻辑回到等待状态。
          this.updateRoomStatus(deskId, 0);
        }
        //通知当前玩家退出房间成功
        socket.emit('UNSITDOWN_SUCCESS', this.getLobbyRooms());


        //推送一条无关紧要的消息
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: `玩家[${this.getUserName(socket)}]退出房间`, id: guid(), time: time() })

        // 若该桌已无真人，则非暂停状态清退房间；暂停窗口由过期计时器负责收尾。
        if (!this.hasHumanAtDesk(deskId)) {
          this.cleanupRoomIfEmpty(deskId);
        } else {
          this.refreshLobby();
        }
      });

      socket.on('PREPARE', data => {
        const client = this.getClient(socket);
        if (!client || client.posId === 'spec') {
          return;
        }
        const { deskId, posId } = client;
        if (!deskId) {
          return;
        }
        //更新座位为准备状态
        this.updatePosStatus(deskId, posId, 2);
        //通知该客户端准备成功
        socket.emit('PREPARE_SUCCESS');
        //通知房间里的其它客户端更新座位信息
        this.broadCastRoom("POS_STATUS_CHANGE", deskId, { posId, state: 2 }, socket);

        //更新房间状态
        this.updateRoomStatus(deskId, 1);
        this.refreshLobby();

        //检查是否全部准备完毕
        const isPrepareAll = this.checkPrepareAll(deskId);
        if (isPrepareAll) {
          this.startGame(deskId);
        }

      });

      // 麻将操作：出牌、吃碰杠胡、过。所有校验都在服务端完成。
      socket.on('MAHJONG_ACTION', data => {
        const client = this.getClient(socket);
        if (!client || client.posId === 'spec') return;
        const room = this.getDesk(client.deskId);
        const game = this.gameDatas[client.deskId];
        if (!room || room.gameType !== 'mahjong' || !game || game.getStatus() !== 2) return;
        if (room.pauseInfo) {
          socket.emit('MAHJONG_ERROR', { msg: '对局已暂停，等待房主召唤 AI 或玩家回归' });
          return;
        }
        const posId = Number(client.posId);
        const action = data && data.action;
        const pendingBefore = game.getPendingClaim && game.getPendingClaim();
        let ret;
        if (action === 'discard') {
          ret = game.discard(posId, data.card);
          if (ret && ret.status) {
            this.broadCastRoom('MAHJONG_DISCARD', client.deskId, { posId, card: ret.card });
          }
        } else if (action === 'pass') {
          ret = game.passClaim(posId);
        } else if (action === 'gang' && !game.getPendingClaim()) {
          ret = game.concealedGang(posId, data.card);
        } else if (action === 'hu' && !game.getPendingClaim()) {
          if (game.getContextPosId() !== posId || !game.getTurnOptions(posId).includes('hu')) {
            ret = { status: false, msg: '当前不能胡牌' };
          } else {
            ret = game.finishWin(posId, null, '自摸');
          }
        } else if (['hu', 'peng', 'gang', 'chi'].includes(action)) {
          ret = game.claim(posId, action);
        } else {
          ret = { status: false, msg: '未知的麻将操作' };
        }

        if (!ret || !ret.status) {
          socket.emit('MAHJONG_ERROR', { msg: (ret && ret.msg) || '操作无效' });
          return;
        }
        this.recordRoundMove(client.deskId, {
          type: 'mahjong',
          action,
          posId,
          card: (data && data.card) || (pendingBefore && pendingBefore.card),
          meld: ret.meld,
          source: 'human',
        });
        if (ret.result || game.getStatus() === 3) {
          this.finishMahjongGame(client.deskId, ret.result || game.getResult());
          return;
        }
        this.broadcastMahjongState(client.deskId, {
          timeout: MAHJONG_PLAY_TIMEOUT,
          drawCard: ret.drawCard,
          meld: ret.meld ? Object.assign({ posId, type: action }, ret.meld) : null,
        });
        this.scheduleBotAction(client.deskId);
      });

      socket.on('CALL_SCORE', data => {
        const { score } = data;
        const client = this.getClient(socket);
        if (!client || client.posId === 'spec') {
          return;
        }
        const { deskId, posId } = client;
        const game = this.gameDatas[deskId];
        const room = this.getDesk(deskId);
        if (!game || !deskId || (room && room.pauseInfo)) {
          return;
        }
        const status = game.next(posId, score).getStatus();
        this.recordRoundMove(deskId, { type: 'call', posId: Number(posId), score: Number(score), source: 'human' });
        if (status == 1) {
          const ctxPos = game.getContextPosId();
          const ctxScore = game.getContextScore();
          const calledScores = game.getCalledScores();
          this.broadCastRoom('CTX_USER_CHANGE', deskId, { ctxPos, ctxScore, calledScores, timeout: DOU_DIZHU_STEP_TIMEOUT });
          this.scheduleBotAction(deskId);
        }
        if (status == 2) {
          const topCards = game.getTopCards();
          const dizhuPosId = game.getDiZhuPosId();
          this.broadCastRoom('SHOW_TOP_CARD', deskId, { topCards, dizhuPosId, timeout: DOU_DIZHU_STEP_TIMEOUT });
          this.broadCastRoom('CTX_PLAY_CHANGE', deskId, {
            ctxData: {
              len: 0,
              key: '',
              type: '',
              cards: [],
              posId: dizhuPosId,
            },
            posId: dizhuPosId,
            timeout: DOU_DIZHU_PLAY_TIMEOUT,
            isPass: false,
          })
          this.scheduleBotAction(deskId);
        }
        if (status == 4) {
          this.broadCastRoom('MESSAGE', deskId, { msg: '没有玩家叫分，重新发牌' });
          this.startGame(deskId);
          //推送一条无关紧要的消息
          this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: '本局游戏无人叫分，重新发牌', id: guid(), time: time() })

        }
      });


      socket.on('PLAY_CARD', data => {
        const client = this.getClient(socket);
        if (!client || client.posId === 'spec') {
          return;
        }
        const { deskId, posId } = client;
        const game = this.gameDatas[deskId];
        const room = this.getDesk(deskId);
        if (room && room.gameType === 'mahjong') return;
        if (room && room.pauseInfo) {
          socket.emit('PLAY_CARD_ERROR', '对局已暂停，等待房主召唤 AI 或玩家回归');
          return;
        }
        if (game && deskId) {
          const ret = game.validate(posId, data);
          const isPass = !data.length;
          const { status } = ret;
          const allowMove = status || (isPass && (!room || room.gameType === 'doudizhu'));
          if (allowMove) {
          game.next(posId, data);
            this.recordRoundMove(deskId, { type: 'play', posId: Number(posId), cards: data, pass: isPass, cardType: ret.type || '', source: 'human' });
            const trickReset = !!(room && room.gameType === 'guandan' && game.lastCardInfo && !game.lastCardInfo.len);
            this.broadCastRoom('CTX_PLAY_CHANGE', deskId, {
              ctxData: {
                len: data.length,
                key: ret.key,
                type: ret.type,
                cards: data,
                posId
              },
              posId: game.getContextPosId(),
              timeout: room && room.gameType === 'guandan' ? GUANDAN_PLAY_TIMEOUT : DOU_DIZHU_STEP_TIMEOUT,
              isPass,
              trickReset,
            })
            socket.emit('PLAY_CARD_SUCCESS', data)
            if (game.getStatus() === 3) {
              const result = game.getResult();
              if (room && room.gameType === 'guandan') {
                this.applyGuandanResult(deskId, result);
              }
              this.broadCastRoom('GAME_OVER', deskId, result)
              this.finishRoundHistory(deskId, result);
              this.recordResultToDb(deskId, result);
              const seats = room ? room.positions.length : 3;
              for (let i = 0; i < seats; i++) {
                this.updatePosStatus(deskId, i, 1)
              }
              this.updateRoomStatus(deskId, 3);
              game.init();
              this.clearBotTimer(deskId);
              this.rePrepareBots(deskId);
              this.refreshLobby();
            } else {
              this.scheduleBotAction(deskId);
            }

            if (game.getStatus() === 5) {
              socket.emit('PLAY_CARD_ERROR', '游戏出错')
            }
          } else {
            socket.emit('PLAY_CARD_ERROR', data)
          }
        }
      });

      socket.on('disconnect', data => {
        const client = this.getClient(socket);
        if (!client) {
          return;
        }
        const userName = this.getUserName(socket);
        const { deskId, posId } = client;
        this.removeClient(socket);

        if (deskId) {
          // 观战者断连：不动座位/游戏状态
          if (posId === 'spec') {
            const userName2 = userName || '观众';
            this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId: 'spec', msg: `观众[${userName2}]离开房间`, id: guid(), time: time() });
            console.log('观战者断开连接 %s', time());
            return;
          }
          //更新座位状态
          const desk = this.getDesk(deskId);
          const game = this.gameDatas[deskId];
          const inProgress = !!(game && game.getStatus && game.getStatus() > 0 && game.getStatus() < 3);
          this.updatePosStatus(deskId, posId, 0, '');
          //解绑座位号 桌号
          this.updateClientState(socket);
          //通知在房间里的其它客户端，更新座位息
          this.broadCastRoom("POS_STATUS_CHANGE", deskId, { posId, state: 0, userName: '', avatarUrl: '' }, socket);
          //通知大厅其它客户端更新该座位信息
          this.broadCastHouse('STATUS_CHANGE', { deskId, posId, state: 0 });

          if (inProgress) {
            this.updateOtherPosStatus(deskId, posId, 1);
            this.broadCastRoom("POS_STATUS_RESET", deskId, { pos: this.getOtherPosInfo(deskId, posId), state: 1 });
            this.pauseGameForMissingPlayer(deskId, posId, userName || '玩家');
          } else {
            this.updateRoomStatus(deskId, 0);
          }
          //推送一条无关紧要的消息
          this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId, msg: `玩家[${userName}]退出房间`, id: guid(), time: time() })
          console.log('有客户端退出房间，桌号：%s，座位：%s，时间：', deskId, posId, time());

          // 若该桌已无真人，则清退所有 AI
          if (!this.hasHumanAtDesk(deskId)) {
            this.cleanupRoomIfEmpty(deskId);
          } else {
            this.refreshLobby();
          }
        }

        console.log('有客户端断开了连接 %s', time());
      })

      socket.on('USER_MESSAGE', msg => {
        const client = this.getClient(socket);
        if (!client) {
          return;
        }
        const { deskId, posId } = client;
        if (!deskId) {
          return;
        }
        // 观战者发言走特殊通道，不参与方位映射
        if (posId === 'spec') {
          const userName = this.getUserName(socket) || '观众';
          const payload = { type: 'SPEC', posId: 'spec', name: userName, msg, time: time(), id: guid() };
          // broadCastRoom 默认会跳过传入的 socket；观众自己的消息单独回显一次，
          // 避免“广播一次 + socket.emit 一次”导致发送者收到两条相同消息。
          this.broadCastRoom('USER_MESSAGE', deskId, payload, socket);
          socket.emit('USER_MESSAGE', payload);
          return;
        }
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'USER', posId, msg, time: time(), id: guid() })
      })

      // 观战 加入
      socket.on('SPECTATE', data => {
        const client = this.getClient(socket);
        if (!client) {
          return;
        }
        // 已经在某桌
        if (client.deskId) {
          socket.emit('SPECTATE_ERROR', { msg: '您已在房间内' });
          return;
        }
        const deskId = data && data.deskId;
        const desk = this.getDesk(deskId);
        if (!desk) {
          socket.emit('SPECTATE_ERROR', { msg: '房间不存在' });
          return;
        }
        // 至少要有一名玩家在座
        const seated = desk.positions.filter(p => p.state > 0).length;
        if (seated === 0) {
          socket.emit('SPECTATE_ERROR', { msg: '房间无人，无法观战' });
          return;
        }
        this.updateClientState(socket, deskId, 'spec');
        db.recordSiteStat('spectator_visits');
        const game = this.gameDatas[deskId];
        const status = game && game.getStatus ? game.getStatus() : 0;
        const gameInProgress = status >= 1 && status < 3;
        socket.emit('SPECTATE_SUCCESS', {
          deskId,
          roomCode: desk.roomCode,
          gameType: desk.gameType,
          gameLabel: desk.gameLabel,
          seatCount: desk.seatCount,
          ownerName: desk.ownerName,
          aiDifficulty: desk.aiDifficulty,
          aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(desk.aiDifficulty),
          guandanLevelLabel: desk.guandanLevelLabel,
          guandanLevelRank: desk.guandanLevelRank,
          positions: desk.positions,
          gameInProgress,
          snapshot: gameInProgress ? this.getGameSnapshot(deskId) : null,
          paused: this.getPausePayload(desk),
        });
        const userName = this.getUserName(socket) || '观众';
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId: 'spec', msg: `观众[${userName}]进入房间`, id: guid(), time: time() }, socket);
      });

      // 观战 离开
      socket.on('UNSPECTATE', () => {
        const client = this.getClient(socket);
        if (!client || client.posId !== 'spec') {
          return;
        }
        const { deskId } = client;
        this.updateClientState(socket);
        socket.emit('UNSITDOWN_SUCCESS', this.getLobbyRooms());
        const userName = this.getUserName(socket) || '观众';
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId: 'spec', msg: `观众[${userName}]离开房间`, id: guid(), time: time() }, socket);
      });

      // AI 难度是房间级规则：只有房主能改，且一旦本局进入叫分/出牌状态就锁定。
      socket.on('SET_AI_DIFFICULTY', data => {
        const client = this.getClient(socket);
        const desk = client && client.deskId ? this.getDesk(client.deskId) : null;
        if (!client || !desk || client.posId === 'spec') {
          socket.emit('AI_DIFFICULTY_ERROR', { code: 'NOT_IN_ROOM', msg: '请先入座后再调整 AI 难度' });
          return;
        }
        if (!this.isRoomOwner(socket, desk)) {
          socket.emit('AI_DIFFICULTY_ERROR', {
            code: 'OWNER_ONLY',
            msg: '只有房主可以调整 AI 难度',
            aiDifficulty: desk.aiDifficulty,
            aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(desk.aiDifficulty),
          });
          return;
        }
        const game = this.gameDatas[desk.deskId];
        const gameStatus = game && game.getStatus ? game.getStatus() : 0;
        if (gameStatus > 0 && gameStatus < 3) {
          socket.emit('AI_DIFFICULTY_ERROR', {
            code: 'GAME_STARTED',
            msg: '本局已开始，AI 难度不能中途调整',
            aiDifficulty: desk.aiDifficulty,
            aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(desk.aiDifficulty),
          });
          return;
        }
        const requested = String(!data || data.difficulty == null ? '' : data.difficulty).trim().toLowerCase();
        const allowed = ['easy', 'normal', 'hard', 'low', 'high', '1', '2', '3', '简单', '标准', '困难'];
        if (allowed.indexOf(requested) < 0) {
          socket.emit('AI_DIFFICULTY_ERROR', { code: 'INVALID_DIFFICULTY', msg: 'AI 难度参数无效' });
          return;
        }
        desk.aiDifficulty = AiDifficulty.normalizeAiDifficulty(requested);
        const payload = {
          deskId: desk.deskId,
          aiDifficulty: desk.aiDifficulty,
          aiDifficultyLabel: AiDifficulty.aiDifficultyLabel(desk.aiDifficulty),
          changedBy: this.getUserName(socket),
        };
        this.broadCastRoom('AI_DIFFICULTY_CHANGE', desk.deskId, payload);
        this.refreshLobby();
      });

      // 召唤 AI 对手：把所有空位填满 AI
      socket.on('ADD_BOTS', () => {
        const client = this.getClient(socket);
        if (!client || !client.deskId || client.posId === 'spec') {
          socket.emit('USER_MESSAGE', { type: 'SYS', posId: '', msg: '请先入座再召唤 AI', id: guid(), time: time() });
          return;
        }
        const deskId = client.deskId;
        const desk = this.getDesk(deskId);
        if (!desk) return;
        const game = this.gameDatas[deskId];
        if (desk.pauseInfo && game && game.getStatus && game.getStatus() > 0 && game.getStatus() < 3) {
          if (!this.isRoomOwner(socket, desk)) {
            socket.emit('USER_MESSAGE', { type: 'SYS', posId: client.posId, msg: '只有房主可以在暂停时召唤 AI 补位', id: guid(), time: time() });
            return;
          }
          const pausedPosId = Number(desk.pauseInfo.posId);
          const pausedPos = this.getPosition(desk, pausedPosId);
          if (!pausedPos || pausedPos.state !== 0) {
            socket.emit('USER_MESSAGE', { type: 'SYS', posId: client.posId, msg: '暂停座位已被接管', id: guid(), time: time() });
            return;
          }
          this.seatBot(deskId, pausedPosId);
          this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId: client.posId, msg: '房主已召唤 AI 补位，对局继续', id: guid(), time: time() });
          this.resumePausedGame(deskId, 'ai');
          return;
        }
        if (game && game.getStatus && game.getStatus() > 0 && game.getStatus() < 3) {
          socket.emit('USER_MESSAGE', { type: 'SYS', posId: client.posId, msg: '游戏中，无法召唤 AI', id: guid(), time: time() });
          return;
        }
        let added = 0;
        desk.positions.forEach(p => {
          if (p.state === 0) { this.seatBot(deskId, p.posId); added++; }
        });
        if (!added) {
          socket.emit('USER_MESSAGE', { type: 'SYS', posId: client.posId, msg: '已无空位，无法召唤 AI', id: guid(), time: time() });
          return;
        }
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId: client.posId, msg: desk.gameType === 'guandan' ? 'AI 已补齐空位' : 'AI 对手已落座', id: guid(), time: time() });
        if (this.checkPrepareAll(deskId)) {
          this.startGame(deskId);
        }
      });

      // 请走 AI（回到等待真人模式）
      socket.on('REMOVE_BOTS', () => {
        const client = this.getClient(socket);
        if (!client || !client.deskId || client.posId === 'spec') return;
        const deskId = client.deskId;
        const game = this.gameDatas[deskId];
        if (game && game.getStatus && game.getStatus() > 0 && game.getStatus() < 3) {
          socket.emit('USER_MESSAGE', { type: 'SYS', posId: client.posId, msg: '游戏中，无法请走 AI', id: guid(), time: time() });
          return;
        }
        this.removeAllBots(deskId);
        this.clearBotTimer(deskId);
        this.broadCastRoom('USER_MESSAGE', deskId, { type: 'SYS', posId: client.posId, msg: 'AI 已离席，等待真人入局', id: guid(), time: time() });
      });


    }.bind(this));


    // 只接受本机 Nginx 反代，隐藏旧的公网 IP:8002 直连入口。
    http.listen(this.port, '127.0.0.1', () => {
      console.log(`server is running on port ${this.port}`);
      (require('os').platform() == 'win32' && process.env.NODE_ENV !== 'test') && require('child_process').exec(`start http://localhost:${this.port}/index.html`);
    });
  }
}
Object.assign(GameServer.prototype, proto);
const gameServer = new GameServer(Number(process.env.PORT) || 8002);
db.init().finally(() => gameServer.init());
