/**
 * 雀阁 — 分玩法积分持久化（与 Discuz 共库）
 *
 * 配置（环境变量）：
 *   DB_HOST            数据库主机（默认 127.0.0.1）
 *   DB_PORT            端口（默认 3306）
 *   DB_USER            用户名
 *   DB_PASSWORD        密码
 *   DB_NAME            数据库名（建议直接使用 Discuz 的库，例如 ultrax / discuz）
 *   DB_TABLE_PREFIX    Discuz 表前缀（默认 pre_）
 *   DB_DISABLE         设为 1 时关闭持久化（仅内存）
 *
 * 启动时会自动建表（如果不存在）：积分表、<前缀>game_history、<前缀>site_stats
 */

const TABLE_PREFIX = process.env.DB_TABLE_PREFIX || 'pre_';
const TABLES = {
  doudizhu: `${TABLE_PREFIX}doudizhu_score`,
  guandan: `${TABLE_PREFIX}guandan_score`,
  mahjong: `${TABLE_PREFIX}mahjong_score`,
};
const TABLE = TABLES.doudizhu;
const HISTORY_TABLE = `${TABLE_PREFIX}game_history`;
const SITE_STATS_TABLE = `${TABLE_PREFIX}site_stats`;
const SITE_STATS_META_TABLE = `${TABLE_PREFIX}site_stats_meta`;
const STAT_COLUMNS = ['page_views', 'socket_connections', 'game_starts', 'games_completed', 'player_rounds', 'spectator_visits'];
const memoryHistory = [];
const memoryStats = {
  page_views: 0,
  socket_connections: 0,
  game_starts: 0,
  games_completed: 0,
  player_rounds: 0,
  spectator_visits: 0,
};
let memoryHistorySeq = 1;
let memoryStatsMeta = null;

let pool = null;
let ready = false;

async function init() {
  if (process.env.DB_DISABLE === '1') {
    console.warn('[db] DB_DISABLE=1，已禁用积分持久化（内存模式）');
    return false;
  }
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (e) {
    console.warn('[db] 未安装 mysql2，请执行 npm install。已退化为内存模式。');
    return false;
  }
  if (!process.env.DB_USER || !process.env.DB_NAME) {
    console.warn('[db] 未配置 DB_USER / DB_NAME，跳过数据库初始化（内存模式）。');
    return false;
  }
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
    });
    for (const tableName of Object.values(TABLES)) {
      await pool.query(`
      CREATE TABLE IF NOT EXISTS \`${tableName}\` (
        \`uid\` INT UNSIGNED NOT NULL PRIMARY KEY,
        \`username\` VARCHAR(64) NOT NULL DEFAULT '',
        \`score\` INT NOT NULL DEFAULT 0,
        \`games\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`wins\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`losses\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`landlord_games\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`landlord_wins\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`updated_at\` INT UNSIGNED NOT NULL DEFAULT 0,
        KEY \`idx_score\` (\`score\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`${HISTORY_TABLE}\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`room_code\` VARCHAR(16) NOT NULL DEFAULT '',
        \`desk_id\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`game_type\` VARCHAR(20) NOT NULL DEFAULT 'doudizhu',
        \`game_label\` VARCHAR(32) NOT NULL DEFAULT '',
        \`is_private\` TINYINT(1) NOT NULL DEFAULT 0,
        \`started_at\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
        \`ended_at\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
        \`players_json\` MEDIUMTEXT NOT NULL,
        \`moves_json\` MEDIUMTEXT NOT NULL,
        \`result_json\` MEDIUMTEXT NOT NULL,
        KEY \`idx_history_ended\` (\`ended_at\`),
        KEY \`idx_history_game\` (\`game_type\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`${SITE_STATS_TABLE}\` (
        \`id\` TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        \`page_views\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
        \`socket_connections\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
        \`game_starts\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
        \`games_completed\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
        \`player_rounds\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
        \`spectator_visits\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
        \`updated_at\` BIGINT UNSIGNED NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`${SITE_STATS_META_TABLE}\` (
        \`id\` TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`data_quality_json\` MEDIUMTEXT NOT NULL,
        \`updated_at\` BIGINT UNSIGNED NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    ready = true;
    console.log(`[db] 已连接 MySQL，使用表 ${Object.values(TABLES).join(' / ')}`);
    return true;
  } catch (err) {
    console.error('[db] 初始化失败：', err && err.message);
    pool = null;
    ready = false;
    return false;
  }
}

function isReady() { return ready && pool; }
function tableFor(gameType) {
  return TABLES[gameType] || TABLES.doudizhu;
}

/**
 * 记录一名玩家的对局结果。
 * @param {object} p
 * @param {number} p.uid
 * @param {string} p.username
 * @param {number} p.delta        本局积分增减（正数为加分）
 * @param {boolean} p.win
 * @param {boolean} p.isLandlord
 */
async function recordPlayer(p) {
  if (!isReady() || !p || !p.uid) return;
  const tableName = tableFor(p.gameType);
  const now = Math.floor(Date.now() / 1000);
  const win = p.win ? 1 : 0;
  const loss = p.win ? 0 : 1;
  const lord = p.isLandlord ? 1 : 0;
  const lordWin = (p.isLandlord && p.win) ? 1 : 0;
  try {
    await pool.query(
      `INSERT INTO \`${tableName}\`
        (uid, username, score, games, wins, losses, landlord_games, landlord_wins, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        username = VALUES(username),
        score = score + VALUES(score),
        games = games + 1,
        wins = wins + VALUES(wins),
        losses = losses + VALUES(losses),
        landlord_games = landlord_games + VALUES(landlord_games),
        landlord_wins = landlord_wins + VALUES(landlord_wins),
        updated_at = VALUES(updated_at)`,
      [p.uid, String(p.username || ''), p.delta | 0, win, loss, lord, lordWin, now]
    );
  } catch (err) {
    console.error('[db] recordPlayer 失败：', err && err.message);
  }
}

async function getUserScore(uid, gameType = 'doudizhu') {
  if (!isReady() || !uid) return null;
  const tableName = tableFor(gameType);
  try {
    const [rows] = await pool.query(
      `SELECT uid, username, score, games, wins, losses, landlord_games, landlord_wins
       FROM \`${tableName}\` WHERE uid = ? LIMIT 1`,
      [uid]
    );
    return rows[0] || { uid, username: '', score: 0, games: 0, wins: 0, losses: 0, landlord_games: 0, landlord_wins: 0 };
  } catch (err) {
    console.error('[db] getUserScore 失败：', err && err.message);
    return null;
  }
}

async function getTopScores(limit = 20, gameType = 'doudizhu') {
  if (!isReady()) return [];
  const tableName = tableFor(gameType);
  try {
    const parsedLimit = Number(limit);
    const n = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, Math.floor(parsedLimit))) : 20;
    const [rows] = await pool.query(
      `SELECT uid, username, score, games, wins, losses
       FROM \`${tableName}\` ORDER BY score DESC, wins DESC LIMIT ?`,
      [n]
    );
    return rows;
  } catch (err) {
    console.error('[db] getTopScores 失败：', err && err.message);
    return [];
  }
}

function safeJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch (e) { return fallback; }
}

function normalizeHistory(record, id) {
  record = record || {};
  return {
    id: id == null ? Number(record.id || 0) : Number(id),
    roomCode: String(record.roomCode || ''),
    deskId: Number(record.deskId || 0),
    gameType: String(record.gameType || 'doudizhu'),
    gameLabel: String(record.gameLabel || ''),
    isPrivate: !!record.isPrivate,
    startedAt: Number(record.startedAt || 0),
    endedAt: Number(record.endedAt || 0),
    players: Array.isArray(record.players) ? record.players.map(p => ({
      posId: Number(p.posId),
      uid: p.uid ? String(p.uid) : '',
      guestId: p.guestId ? String(p.guestId) : '',
      username: String(p.username || p.userName || ''),
      isBot: !!p.isBot,
    })) : [],
    moves: Array.isArray(record.moves) ? record.moves : [],
    result: record.result || {},
  };
}

function rowToHistory(row) {
  if (!row) return null;
  return normalizeHistory({
    roomCode: row.room_code,
    deskId: row.desk_id,
    gameType: row.game_type,
    gameLabel: row.game_label,
    isPrivate: row.is_private,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    players: safeJson(row.players_json, []),
    moves: safeJson(row.moves_json, []),
    result: safeJson(row.result_json, {}),
  }, row.id);
}

function viewerCanView(record, viewer) {
  if (!record || !record.isPrivate) return true;
  viewer = viewer || {};
  const uid = viewer.uid ? String(viewer.uid) : '';
  const guestId = viewer.guestId ? String(viewer.guestId) : '';
  const username = String(viewer.username || '').trim();
  return record.players.some(player => {
    if (player.isBot) return false;
    if (uid && player.uid && uid === player.uid) return true;
    if (guestId && player.guestId && guestId === player.guestId) return true;
    return !!(username && player.username && username === player.username);
  });
}

function historySummary(record) {
  return {
    id: record.id,
    roomCode: record.roomCode,
    deskId: record.deskId,
    gameType: record.gameType,
    gameLabel: record.gameLabel,
    isPrivate: record.isPrivate,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    players: record.players.map(player => ({ posId: player.posId, username: player.username, isBot: player.isBot })),
    moveCount: record.moves.length,
    result: record.result,
  };
}

async function saveHistory(record) {
  const normalized = normalizeHistory(record, 0);
  normalized.id = memoryHistorySeq++;
  memoryHistory.unshift(normalized);
  if (memoryHistory.length > 200) memoryHistory.length = 200;
  if (!isReady()) return normalized.id;
  try {
    const [ret] = await pool.query(
      `INSERT INTO \`${HISTORY_TABLE}\`
        (room_code, desk_id, game_type, game_label, is_private, started_at, ended_at, players_json, moves_json, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [normalized.roomCode, normalized.deskId, normalized.gameType, normalized.gameLabel,
        normalized.isPrivate ? 1 : 0, normalized.startedAt, normalized.endedAt,
        JSON.stringify(normalized.players), JSON.stringify(normalized.moves), JSON.stringify(normalized.result)]
    );
    return ret && ret.insertId ? Number(ret.insertId) : normalized.id;
  } catch (err) {
    console.error('[db] saveHistory 失败：', err && err.message);
    return normalized.id;
  }
}

async function listHistory(options = {}) {
  const limit = Math.min(50, Math.max(1, Math.floor(Number(options.limit) || 20)));
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const gameType = options.gameType && options.gameType !== 'all' ? String(options.gameType) : '';
  let records = memoryHistory.slice(0);
  if (isReady()) {
    try {
      const [rows] = await pool.query(
        `SELECT id, room_code, desk_id, game_type, game_label, is_private, started_at, ended_at, players_json, moves_json, result_json
         FROM \`${HISTORY_TABLE}\` ORDER BY ended_at DESC, id DESC LIMIT 500`
      );
      records = rows.map(rowToHistory).filter(Boolean);
    } catch (err) {
      console.error('[db] listHistory 失败：', err && err.message);
    }
  }
  const visible = records.filter(record =>
    (!gameType || record.gameType === gameType) && viewerCanView(record, options.viewer)
  );
  return { total: visible.length, items: visible.slice(offset, offset + limit).map(historySummary) };
}

async function getHistory(id, viewer) {
  const target = Number(id);
  if (!Number.isFinite(target) || target <= 0) return null;
  let record = memoryHistory.find(item => Number(item.id) === target) || null;
  if (isReady()) {
    try {
      const [rows] = await pool.query(
        `SELECT id, room_code, desk_id, game_type, game_label, is_private, started_at, ended_at, players_json, moves_json, result_json
         FROM \`${HISTORY_TABLE}\` WHERE id = ? LIMIT 1`, [target]
      );
      record = rowToHistory(rows[0]) || record;
    } catch (err) {
      console.error('[db] getHistory 失败：', err && err.message);
    }
  }
  if (!record || !viewerCanView(record, viewer)) return null;
  return Object.assign({}, record, {
    players: record.players.map(player => ({ posId: player.posId, username: player.username, isBot: player.isBot })),
  });
}

function statPayload(row) {
  row = row || memoryStats;
  const result = {};
  STAT_COLUMNS.forEach(key => { result[key] = Number(row[key] || 0); });
  result.visits = result.page_views;
  result.plays = result.player_rounds;
  result.games = result.games_completed;
  result.updatedAt = Number(row.updated_at || 0);
  return result;
}

function attachStatsMeta(result, meta) {
  if (!meta) return result;
  const parsed = typeof meta === 'string' ? safeJson(meta, null) : meta;
  if (!parsed || typeof parsed !== 'object') return result;
  result.dataQuality = parsed;
  result.backfilledAt = Number(parsed.recoveredAt || 0);
  return result;
}

async function recordSiteStat(name, amount = 1) {
  if (!STAT_COLUMNS.includes(name)) return;
  const delta = Math.max(0, Math.floor(Number(amount) || 0));
  if (!delta) return;
  memoryStats[name] += delta;
  if (!isReady()) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    await pool.query(
      `INSERT INTO \`${SITE_STATS_TABLE}\` (id, \`${name}\`, updated_at) VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE \`${name}\` = \`${name}\` + VALUES(\`${name}\`), updated_at = VALUES(updated_at)`,
      [delta, now]
    );
  } catch (err) {
    console.error('[db] recordSiteStat 失败：', err && err.message);
  }
}

async function getSiteStats() {
  if (isReady()) {
    try {
      const [rows] = await pool.query(`SELECT * FROM \`${SITE_STATS_TABLE}\` WHERE id = 1 LIMIT 1`);
      const [metaRows] = await pool.query(`SELECT data_quality_json FROM \`${SITE_STATS_META_TABLE}\` WHERE id = 1 LIMIT 1`);
      return attachStatsMeta(statPayload(rows[0] || {}), metaRows[0] && metaRows[0].data_quality_json);
    } catch (err) {
      console.error('[db] getSiteStats 失败：', err && err.message);
    }
  }
  return attachStatsMeta(statPayload(memoryStats), memoryStatsMeta);
}

/**
 * 从旧积分表恢复可推导的历史数据。
 * games 是按玩家累计的，无法还原每一局的牌序，所以 completedEstimate 使用
 * “单个玩家最大局数”和“玩家局数/座位数”的较大值作为保守估算，并保留来源说明。
 */
async function getHistoricalGameStats() {
  const seatsByType = { doudizhu: 3, guandan: 4, mahjong: 4 };
  const result = [];
  for (const [gameType, tableName] of Object.entries(TABLES)) {
    const item = {
      gameType,
      table: tableName,
      trackedPlayers: 0,
      playerRounds: 0,
      maxPlayerGames: 0,
      wins: 0,
      losses: 0,
      completedEstimate: 0,
      formula: `max(maxPlayerGames, ceil(playerRounds/${seatsByType[gameType]}))`,
    };
    if (!isReady()) {
      result.push(item);
      continue;
    }
    try {
      const [rows] = await pool.query(`
        SELECT COUNT(*) AS tracked_players,
               COALESCE(SUM(games), 0) AS player_rounds,
               COALESCE(MAX(games), 0) AS max_player_games,
               COALESCE(SUM(wins), 0) AS wins,
               COALESCE(SUM(losses), 0) AS losses
        FROM \`${tableName}\`
      `);
      const row = rows[0] || {};
      item.trackedPlayers = Number(row.tracked_players || 0);
      item.playerRounds = Number(row.player_rounds || 0);
      item.maxPlayerGames = Number(row.max_player_games || 0);
      item.wins = Number(row.wins || 0);
      item.losses = Number(row.losses || 0);
      item.completedEstimate = Math.max(item.maxPlayerGames, Math.ceil(item.playerRounds / seatsByType[gameType]));
    } catch (err) {
      console.error('[db] getHistoricalGameStats 失败：', err && err.message);
    }
    result.push(item);
  }
  return result;
}

/**
 * 一次性把外部日志/旧积分表推导出的历史基线写入数据库。
 * 使用 GREATEST 合并，重复执行不会把数据重复累加；force=true 才会刷新来源元数据。
 */
async function backfillSiteStats(payload = {}) {
  const values = payload.values || {};
  const metadata = Object.assign({}, payload.dataQuality || payload.metadata || {}, {
    recoveredAt: Number((payload.dataQuality || payload.metadata || {}).recoveredAt || Date.now()),
  });
  if (!isReady()) {
    STAT_COLUMNS.forEach(key => {
      memoryStats[key] = Math.max(memoryStats[key], Math.max(0, Math.floor(Number(values[key]) || 0)));
    });
    memoryStatsMeta = metadata;
    return attachStatsMeta(statPayload(memoryStats), memoryStatsMeta);
  }
  try {
    const [metaRows] = await pool.query(`SELECT version, data_quality_json FROM \`${SITE_STATS_META_TABLE}\` WHERE id = 1 LIMIT 1`);
    if (!payload.force && metaRows[0] && Number(metaRows[0].version || 0) >= 1) {
      return getSiteStats();
    }
    const [currentRows] = await pool.query(`SELECT * FROM \`${SITE_STATS_TABLE}\` WHERE id = 1 LIMIT 1`);
    const current = currentRows[0] || {};
    const merged = {};
    STAT_COLUMNS.forEach(key => {
      merged[key] = Math.max(Number(current[key] || 0), Math.max(0, Math.floor(Number(values[key]) || 0)));
    });
    const now = Math.floor(Date.now() / 1000);
    await pool.query(`
      INSERT INTO \`${SITE_STATS_TABLE}\`
        (id, page_views, socket_connections, game_starts, games_completed, player_rounds, spectator_visits, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        page_views = VALUES(page_views),
        socket_connections = VALUES(socket_connections),
        game_starts = VALUES(game_starts),
        games_completed = VALUES(games_completed),
        player_rounds = VALUES(player_rounds),
        spectator_visits = VALUES(spectator_visits),
        updated_at = VALUES(updated_at)
    `, [merged.page_views, merged.socket_connections, merged.game_starts, merged.games_completed,
      merged.player_rounds, merged.spectator_visits, now]);
    await pool.query(`
      INSERT INTO \`${SITE_STATS_META_TABLE}\` (id, version, data_quality_json, updated_at)
      VALUES (1, 1, ?, ?)
      ON DUPLICATE KEY UPDATE version = VALUES(version), data_quality_json = VALUES(data_quality_json), updated_at = VALUES(updated_at)
    `, [JSON.stringify(Object.assign(metadata, { effectiveValues: merged })), now]);
    return attachStatsMeta(statPayload(merged), Object.assign(metadata, { effectiveValues: merged }));
  } catch (err) {
    console.error('[db] backfillSiteStats 失败：', err && err.message);
    return getSiteStats();
  }
}

module.exports = {
  init, isReady, recordPlayer, getUserScore, getTopScores,
  saveHistory, listHistory, getHistory, recordSiteStat, getSiteStats,
  getHistoricalGameStats, backfillSiteStats,
  TABLE, TABLES, HISTORY_TABLE, SITE_STATS_TABLE, SITE_STATS_META_TABLE,
};
