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
 * 启动时会自动建表（如果不存在）：<前缀>doudizhu_score / <前缀>guandan_score
 */

const TABLE_PREFIX = process.env.DB_TABLE_PREFIX || 'pre_';
const TABLES = {
  doudizhu: `${TABLE_PREFIX}doudizhu_score`,
  guandan: `${TABLE_PREFIX}guandan_score`,
};
const TABLE = TABLES.doudizhu;

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
    const n = Math.max(1, limit | 0);
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

module.exports = { init, isReady, recordPlayer, getUserScore, getTopScores, TABLE, TABLES };
