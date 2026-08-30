const assert = require('assert');
const Game = require('../game');
const GuandanGame = require('../guandan-game');
const MahjongGame = require('../mahjong-game');
const SmartAI = require('../static/js/smart-ai').SmartAI;
const MahjongAI = require('../static/js/mahjong-ai').MahjongAI;
const AiDifficulty = require('../ai-difficulty');

function card(value, type, deck) {
  return { value, type: type || 0, deck };
}

function testMahjongAnalysis() {
  const winning = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 18].map(value => card(value));
  const tenpai = winning.slice(0, 13);
  const sevenPairs = [0, 0, 1, 1, 2, 2, 9, 9, 10, 10, 18, 18, 27, 27].map(value => card(value));
  assert.strictEqual(MahjongAI.calculateShanten(winning, 0), -1, '标准和牌应为 -1 向听');
  assert.strictEqual(MahjongAI.calculateShanten(tenpai, 0), 0, '标准听牌应为 0 向听');
  assert.strictEqual(MahjongAI.calculateShanten(sevenPairs, 0), -1, '七对应识别为和牌');

  const advice = MahjongAI.suggestDiscard(winning, {
    wallCount: 70,
    discards: { self: [], left: [], right: [], top: [] },
    melds: { self: [], left: [], right: [], top: [] },
    selfPos: 'self',
  });
  assert.strictEqual(advice.action, 'discard');
  assert(advice.card && Number.isInteger(advice.card.value), '麻将智囊应返回具体弃牌');
  assert(advice.effectiveTiles.length > 0 && advice.ukeire > 0, '麻将智囊应计算有效进张');
}

function simulateDoudizhu(rounds) {
  for (let round = 0; round < rounds; round++) {
    const game = new Game().start();
    game.next(game.getContextPosId(), 3); // 最高叫分，直接确定地主。
    assert.strictEqual(game.getStatus(), 2);
    const landlord = game.getDiZhuPosId();
    let moves = 0;
    while (game.getStatus() === 2 && moves++ < 260) {
      const pos = Number(game.getContextPosId());
      const hand = game.getCardsByPosId(pos);
      const last = game.lastCardInfo || {};
      const opponentCounts = [0, 1, 2].filter(id => (id === landlord) !== (pos === landlord)).map(id => game.getCardsByPosId(id).length);
      const partner = [0, 1, 2].find(id => id !== pos && id !== landlord);
      const lastIsPartner = pos !== landlord && Number(last.posId) === partner;
      const lastInfo = {
        len: last.len,
        key: last.key,
        type: last.type,
        ctxPos: Number(last.posId) === pos ? 'self' : 'other',
      };
      const picks = SmartAI.doudizhu.suggest(hand, lastInfo, {
        role: pos === landlord ? 'landlord' : 'farmer',
        lastIsPartner,
        partnerCardCount: partner == null ? 99 : game.getCardsByPosId(partner).length,
        opponentMinCardCount: opponentCounts.length ? Math.min(...opponentCounts) : 99,
        seenCards: game.getPlayedCards(),
      });
      const lead = !Number(last.len) || Number(last.posId) === pos;
      assert(!lead || picks.length, '斗地主获得牌权时 AI 不得空过');
      if (picks.length) assert(game.validate(pos, picks).status, '斗地主 AI 必须选择合法牌型');
      game.next(pos, picks);
      assert.notStrictEqual(game.getStatus(), 5, '斗地主 AI 不得破坏回合状态');
    }
    assert.strictEqual(game.getStatus(), 3, '斗地主 AI 对局应在回合上限内结束');
  }
}

function simulateGuandan(rounds) {
  for (let round = 0; round < rounds; round++) {
    const game = new GuandanGame().start();
    let moves = 0;
    while (game.getStatus() === 2 && moves++ < 520) {
      const pos = Number(game.getContextPosId());
      const hand = game.getCardsByPosId(pos);
      const last = game.lastCardInfo || {};
      const opponents = [0, 1, 2, 3].filter(id => id % 2 !== pos % 2).map(id => game.getCardsByPosId(id).length);
      const teammate = (pos + 2) % 4;
      const lastInfo = Object.assign({}, last, { ctxPos: Number(last.posId) === pos ? 'self' : 'other' });
      const picks = SmartAI.guandan.suggest(hand, lastInfo, {
        levelRank: game.levelRank,
        levelLabel: game.getLevelLabel(),
        lastIsPartner: last.posId !== '' && Number(last.posId) === teammate,
        teammateCardCount: game.getCardsByPosId(teammate).length,
        opponentMinCardCount: Math.min(...opponents),
        seenCards: game.getPlayedCards(),
      });
      const lead = !Number(last.len) || Number(last.posId) === pos;
      assert(!lead || picks.length, '掼蛋获得牌权时 AI 不得空过');
      assert(game.validate(pos, picks).status, '掼蛋 AI 的出牌或过牌必须合法：' + JSON.stringify({ pos, picks, last, hand }));
      game.next(pos, picks);
    }
    assert.strictEqual(game.getStatus(), 3, '掼蛋 AI 对局应在回合上限内结束');
  }
}

function simulateMahjong(rounds) {
  for (let round = 0; round < rounds; round++) {
    const game = new MahjongGame().start();
    let moves = 0;
    while (game.getStatus() === 2 && moves++ < 420) {
      const pending = game.getPendingClaim();
      if (pending) {
        const eligible = pending.eligible.filter(pos => !pending.responded[pos]);
        assert(eligible.length, '待响应麻将状态必须有玩家可操作');
        const pos = eligible[0];
        const options = game.getTurnOptions(pos);
        const decision = MahjongAI.chooseClaim(game.getCardsByPosId(pos), options, pending.card, {
          openMelds: game.getMelds()[pos].length,
          discards: game.getDiscards(),
          melds: game.getMelds(),
          selfPos: pos,
          wallCount: game.getWallCount(),
        });
        const ret = decision.action === 'pass' ? game.passClaim(pos) : game.claim(pos, decision.action);
        assert(ret.status, '麻将 AI 的吃碰杠胡决策必须合法');
        continue;
      }

      const pos = Number(game.getContextPosId());
      const options = game.getTurnOptions(pos);
      if (options.includes('hu')) {
        game.finishWin(pos, null, '自摸');
        continue;
      }
      const aiOptions = {
        openMelds: game.getMelds()[pos].length,
        discards: game.getDiscards(),
        melds: game.getMelds(),
        selfPos: pos,
        wallCount: game.getWallCount(),
      };
      if (options.includes('gang')) {
        const gang = MahjongAI.shouldConcealedGang(game.getCardsByPosId(pos), aiOptions);
        if (gang.action === 'gang') {
          assert(game.concealedGang(pos, gang.card).status, '麻将 AI 暗杠必须合法');
          continue;
        }
      }
      const advice = MahjongAI.suggestDiscard(game.getCardsByPosId(pos), aiOptions);
      const chosen = game.getCardsByPosId(pos).find(tile => tile.value === advice.card.value);
      assert(chosen, '麻将 AI 建议的牌必须存在于手牌');
      assert(game.discard(pos, chosen).status, '麻将 AI 弃牌必须合法');
    }
    assert.strictEqual(game.getStatus(), 3, '麻将 AI 对局应在回合上限内结束');
  }
}

function testDifficultyAdapters() {
  ['easy', 'normal', 'hard'].forEach(function (difficulty) {
    const ddz = new Game().start();
    ddz.next(ddz.getContextPosId(), 3); // 进入出牌阶段，让规则引擎具备当前牌权。
    const pos = Number(ddz.getContextPosId());
    const hand = ddz.getCardsByPosId(pos);
    const picks = AiDifficulty.doudizhuSuggest(hand, { len: 0, ctxPos: 'self' }, { difficulty: difficulty });
    assert(picks.length, '斗地主 ' + difficulty + ' 档获得牌权时应给出出牌');
    assert(ddz.validate(pos, picks).status, '斗地主 ' + difficulty + ' 档出牌必须合法');
  });

  ['easy', 'normal', 'hard'].forEach(function (difficulty) {
    const guandan = new GuandanGame().start();
    const pos = Number(guandan.getContextPosId());
    const hand = guandan.getCardsByPosId(pos);
    const picks = AiDifficulty.guandanSuggest(hand, { len: 0, ctxPos: 'self' }, {
      difficulty: difficulty,
      levelRank: guandan.levelRank,
    });
    assert(picks.length, '掼蛋 ' + difficulty + ' 档获得牌权时应给出出牌');
    assert(guandan.validate(pos, picks).status, '掼蛋 ' + difficulty + ' 档出牌必须合法');
  });

  const mahjong = new MahjongGame().start();
  const mahjongPos = Number(mahjong.getContextPosId());
  const mahjongAdvice = MahjongAI.suggestDiscard(mahjong.getCardsByPosId(mahjongPos), {
    difficulty: 'hard',
    wallCount: mahjong.getWallCount(),
    discards: mahjong.getDiscards(),
    melds: mahjong.getMelds(),
    selfPos: mahjongPos,
  });
  assert(mahjongAdvice.card, '麻将困难档应返回具体弃牌');
  assert(mahjong.getCardsByPosId(mahjongPos).some(function (tile) {
    return Number(tile.value) === Number(mahjongAdvice.card.value);
  }), '麻将困难档建议的牌必须来自手牌');
}

testMahjongAnalysis();
testDifficultyAdapters();
simulateDoudizhu(3);
simulateGuandan(2);
simulateMahjong(3);
console.log('AI tests passed: 斗地主 3 局，掼蛋 2 局，麻将 3 局。');
