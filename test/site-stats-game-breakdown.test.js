const assert = require('assert');

process.env.DB_DISABLE = '1';
const db = require('../db');

(async function run() {
  await db.init();
  await db.backfillSiteStats({
    values: { games_completed: 10, game_starts: 12, player_rounds: 40 },
    dataQuality: {
      recoveredAt: 11,
      byGame: [
        { gameType: 'doudizhu', completedEstimate: 4, playerRounds: 12 },
        { gameType: 'guandan', completedEstimate: 3, playerRounds: 12 },
        { gameType: 'mahjong', completedEstimate: 3, playerRounds: 16 },
      ],
    },
    force: true,
  });

  await Promise.all([
    db.recordSiteStat('game_starts', 2, 'mahjong'),
    db.recordSiteStat('games_completed', 1, 'mahjong'),
    db.recordSiteStat('player_rounds', 4, 'mahjong'),
    db.recordSiteStat('game_starts', 1, 'guandan'),
    db.recordSiteStat('games_completed', 1, 'guandan'),
    db.recordSiteStat('player_rounds', 4, 'guandan'),
  ]);

  const stats = await db.getSiteStats();
  assert(Array.isArray(stats.byGame), '站点统计缺少分玩法数组');
  assert.deepStrictEqual(stats.byGame.map(item => item.gameType), ['doudizhu', 'guandan', 'mahjong']);

  const mahjong = stats.byGame.find(item => item.gameType === 'mahjong');
  assert.deepStrictEqual(
    { starts: mahjong.starts, games: mahjong.games, plays: mahjong.plays },
    { starts: 5, games: 4, plays: 20 },
    '麻将历史基线与实时增量未正确合并'
  );

  const guandan = stats.byGame.find(item => item.gameType === 'guandan');
  assert.deepStrictEqual(
    { starts: guandan.starts, games: guandan.games, plays: guandan.plays },
    { starts: 4, games: 4, plays: 16 },
    '掼蛋实时统计未正确落到对应玩法'
  );

  const before = JSON.stringify(stats.byGame);
  await db.recordSiteStat('games_completed', 9, 'unknown-game');
  await db.recordSiteStat('page_views', 9, 'mahjong');
  const after = await db.getSiteStats();
  assert.strictEqual(JSON.stringify(after.byGame), before, '非法玩法或无关统计污染了分玩法数据');
  assert.strictEqual(after.games, 12, '聚合完成战局统计未同步实时分玩法增量');
  assert.strictEqual(after.plays, 48, '聚合游玩人次统计未同步实时分玩法增量');
  console.log('Game breakdown stats tests passed: historical baseline merge, per-mode increments, and input isolation.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
