const assert = require('assert');

process.env.DB_DISABLE = '1';
const db = require('../db');

(async function run() {
  await db.init();

  const publicId = await db.saveHistory({
    roomCode: '900001',
    deskId: 1,
    gameType: 'doudizhu',
    gameLabel: '斗地主',
    isPrivate: false,
    startedAt: 1,
    endedAt: 2,
    players: [{ posId: 0, uid: '1', guestId: 'guest-a', username: '甲', isBot: false }],
    moves: [{ type: 'play', posId: 0, cards: [{ value: 3, type: 0 }] }],
    result: { winner: [0] },
  });
  const privateId = await db.saveHistory({
    roomCode: '900002',
    deskId: 2,
    gameType: 'mahjong',
    gameLabel: '麻将',
    isPrivate: true,
    startedAt: 1,
    endedAt: 3,
    players: [{ posId: 0, guestId: 'guest-b', username: '乙', isBot: false }, { posId: 1, username: 'AI', isBot: true }],
    moves: [{ type: 'mahjong', action: 'discard', posId: 0, card: { value: 0, type: 0 } }],
    result: { draw: true },
  });

  const outsider = await db.listHistory({ viewer: { guestId: 'outsider' } });
  assert(outsider.items.some(item => item.id === publicId));
  assert(!outsider.items.some(item => item.id === privateId));

  const participant = await db.getHistory(privateId, { guestId: 'guest-b' });
  assert(participant && participant.isPrivate);
  assert.strictEqual(participant.players[0].guestId, undefined);
  assert.strictEqual(await db.getHistory(privateId, { guestId: 'outsider' }), null);

  await db.recordSiteStat('page_views', 2);
  const stats = await db.getSiteStats();
  assert.strictEqual(stats.visits, 2);
  await db.backfillSiteStats({
    values: { games_completed: 411, game_starts: 411, player_rounds: 777 },
    dataQuality: { recoveredAt: 123, metrics: { games_completed: { mode: 'estimated' } } },
    force: true,
  });
  const restored = await db.getSiteStats();
  assert.strictEqual(restored.games, 411);
  assert.strictEqual(restored.plays, 777);
  assert.strictEqual(restored.dataQuality.metrics.games_completed.mode, 'estimated');
  console.log('History privacy and site stats tests passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
