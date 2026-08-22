/* =====================================================================
 * 雀阁 · 牌类智能决策层
 *
 * 斗地主：完整枚举合法候选，评估出牌后剩余手数、控制牌、炸弹成本、
 * 队友关系与对手残局压力。
 * 掼蛋：复用规则枚举，增加两步剩余牌结构评估、队友协作和残局封锁。
 * ===================================================================== */
(function (global) {
  'use strict';

  var nodeValidator = null;
  var nodeGuandan = null;
  if (typeof module !== 'undefined' && module.exports) {
    try { nodeValidator = require('../../core-validator.js'); } catch (e) {}
    try { nodeGuandan = require('./guandan-suggest.js').GuandanSuggest; } catch (e2) {}
  }

  function cardKey(card) {
    return [Number(card.value), Number(card.type) || 0, card.deck == null ? '*' : Number(card.deck)].join('_');
  }

  function sortCards(cards) {
    return (cards || []).slice(0).sort(function (a, b) {
      if (Number(a.value) !== Number(b.value)) return Number(a.value) - Number(b.value);
      if (Number(a.type) !== Number(b.type)) return Number(a.type) - Number(b.type);
      return Number(a.deck || 0) - Number(b.deck || 0);
    });
  }

  function groupByValue(cards) {
    var groups = {};
    sortCards(cards).forEach(function (card) {
      var value = Number(card.value);
      (groups[value] = groups[value] || []).push(card);
    });
    return groups;
  }

  function withoutCards(hand, usedCards) {
    var used = {};
    (usedCards || []).forEach(function (card) { used[cardKey(card)] = (used[cardKey(card)] || 0) + 1; });
    return (hand || []).filter(function (card) {
      var key = cardKey(card);
      if (used[key]) { used[key]--; return false; }
      return true;
    });
  }

  function doudizhuValidate(cards) {
    var values = (cards || []).map(function (card) { return Number(card.value); });
    var fn = nodeValidator || global.validate;
    if (!fn) return { status: false, len: values.length, types: [] };
    try { return fn(values); } catch (e) { return { status: false, len: values.length, types: [] }; }
  }

  function normalizeDoudizhuRet(validation, preferredType) {
    if (!validation || !validation.status || !validation.types || !validation.types.length) return null;
    var typeInfo = validation.types.find(function (item) { return item.type === preferredType; }) || validation.types[0];
    return { status: true, len: Number(validation.len), type: typeInfo.type, key: Number(typeInfo.key) || 0, bomb: typeInfo.type === 'AAAA' || typeInfo.type === 'KING' };
  }

  function addDoudizhuCandidate(list, seen, cards, source, preferredType) {
    if (!cards || !cards.length) return;
    var validation = doudizhuValidate(cards);
    var ret = normalizeDoudizhuRet(validation, preferredType);
    if (!ret) return;
    var signature = sortCards(cards).map(cardKey).join('|');
    if (seen[signature]) return;
    seen[signature] = true;
    list.push({ cards: sortCards(cards), ret: ret, source: source || ret.type });
  }

  function chooseUnits(units, count, start, picked, callback, cap) {
    if (picked.length === count) { callback(picked.slice(0)); return; }
    if (cap.count >= cap.max) return;
    for (var i = start; i < units.length; i++) {
      picked.push(units[i]);
      cap.count++;
      chooseUnits(units, count, i + 1, picked, callback, cap);
      picked.pop();
      if (cap.count >= cap.max) return;
    }
  }

  function enumerateDoudizhu(hand) {
    hand = sortCards(hand);
    var groups = groupByValue(hand);
    var values = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
    var candidates = [];
    var seen = {};

    values.forEach(function (value) {
      addDoudizhuCandidate(candidates, seen, [groups[value][0]], 'single', 'A');
      if (groups[value].length >= 2) addDoudizhuCandidate(candidates, seen, groups[value].slice(0, 2), 'pair', 'AA');
      if (groups[value].length >= 3) addDoudizhuCandidate(candidates, seen, groups[value].slice(0, 3), 'triple', 'AAA');
      if (groups[value].length >= 4) addDoudizhuCandidate(candidates, seen, groups[value].slice(0, 4), 'bomb', 'AAAA');
    });
    if (groups[16] && groups[17]) addDoudizhuCandidate(candidates, seen, [groups[16][0], groups[17][0]], 'kingBomb', 'KING');

    values.forEach(function (tripleValue) {
      if (tripleValue >= 16 || groups[tripleValue].length < 3) return;
      values.forEach(function (attachValue) {
        if (attachValue === tripleValue) return;
        addDoudizhuCandidate(candidates, seen, groups[tripleValue].slice(0, 3).concat([groups[attachValue][0]]), 'tripleSingle', 'AAAB');
        if (groups[attachValue].length >= 2 && attachValue < 16) {
          addDoudizhuCandidate(candidates, seen, groups[tripleValue].slice(0, 3).concat(groups[attachValue].slice(0, 2)), 'triplePair', 'AAABB');
        }
      });
    });

    for (var start = 3; start <= 14; start++) {
      for (var end = start + 4; end <= 14; end++) {
        var straight = [];
        var ok = true;
        for (var sv = start; sv <= end; sv++) {
          if (!groups[sv]) { ok = false; break; }
          straight.push(groups[sv][0]);
        }
        if (ok) addDoudizhuCandidate(candidates, seen, straight, 'straight', 'ABCDE');
      }
    }

    for (var pairStart = 3; pairStart <= 14; pairStart++) {
      var pairRun = [];
      for (var pairEnd = pairStart; pairEnd <= 14; pairEnd++) {
        if (!groups[pairEnd] || groups[pairEnd].length < 2) break;
        pairRun = pairRun.concat(groups[pairEnd].slice(0, 2));
        if (pairEnd - pairStart + 1 >= 3) addDoudizhuCandidate(candidates, seen, pairRun.slice(0), 'pairRun', 'AABBCC');
      }
    }

    for (var planeStart = 3; planeStart <= 14; planeStart++) {
      var core = [];
      var coreValues = [];
      for (var planeEnd = planeStart; planeEnd <= 14; planeEnd++) {
        if (!groups[planeEnd] || groups[planeEnd].length < 3) break;
        coreValues.push(planeEnd);
        core = core.concat(groups[planeEnd].slice(0, 3));
        var planeCount = planeEnd - planeStart + 1;
        if (planeCount < 2) continue;
        addDoudizhuCandidate(candidates, seen, core.slice(0), 'plane', 'AAABBB');
        var attachmentValues = values.filter(function (value) { return coreValues.indexOf(value) < 0; });
        chooseUnits(attachmentValues, planeCount, 0, [], function (selected) {
          var singles = selected.map(function (value) { return groups[value][0]; });
          addDoudizhuCandidate(candidates, seen, core.concat(singles), 'planeSingles', 'AAAB');
        }, { count: 0, max: 180 });
        var pairValues = attachmentValues.filter(function (value) { return value < 16 && groups[value].length >= 2; });
        chooseUnits(pairValues, planeCount, 0, [], function (selected) {
          var pairs = [];
          selected.forEach(function (value) { pairs = pairs.concat(groups[value].slice(0, 2)); });
          addDoudizhuCandidate(candidates, seen, core.concat(pairs), 'planePairs', 'AAABB');
        }, { count: 0, max: 180 });
      }
    }

    values.forEach(function (fourValue) {
      if (fourValue >= 16 || groups[fourValue].length < 4) return;
      var restCards = hand.filter(function (card) { return Number(card.value) !== fourValue; });
      chooseUnits(restCards, 2, 0, [], function (selected) {
        addDoudizhuCandidate(candidates, seen, groups[fourValue].slice(0, 4).concat(selected), 'fourSingles', 'AAAABC');
      }, { count: 0, max: 220 });
      var pairValues = values.filter(function (value) { return value !== fourValue && value < 16 && groups[value].length >= 2; });
      chooseUnits(pairValues, 2, 0, [], function (selected) {
        var pairs = [];
        selected.forEach(function (value) { pairs = pairs.concat(groups[value].slice(0, 2)); });
        addDoudizhuCandidate(candidates, seen, groups[fourValue].slice(0, 4).concat(pairs), 'fourPairs', 'AAAABBCC');
      }, { count: 0, max: 120 });
    });

    return candidates;
  }

  function normalizeLast(lastInfo) {
    if (!lastInfo || !Number(lastInfo.len)) return { len: 0, type: '', key: 0, bomb: false };
    return { len: Number(lastInfo.len), type: lastInfo.type || '', key: Number(lastInfo.key) || 0, bomb: lastInfo.type === 'AAAA' || lastInfo.type === 'KING' || !!lastInfo.bomb };
  }

  function doudizhuCanBeat(candidate, last) {
    if (!last.len) return true;
    if (candidate.type === 'KING') return last.type !== 'KING';
    if (last.type === 'KING') return false;
    if (candidate.type === 'AAAA') return last.type !== 'AAAA' || candidate.key > last.key;
    if (last.type === 'AAAA') return false;
    return candidate.type === last.type && candidate.len === last.len && candidate.key > last.key;
  }

  function roughDoudizhuTurns(hand) {
    var remaining = sortCards(hand);
    var turns = 0;
    var guard = 0;
    while (remaining.length && guard++ < 24) {
      var candidates = enumerateDoudizhu(remaining).filter(function (item) { return !item.ret.bomb || item.cards.length === remaining.length; });
      if (!candidates.length) { turns += remaining.length; break; }
      candidates.sort(function (a, b) {
        var va = a.cards.length * 12 - (a.ret.bomb ? 60 : 0) - (a.ret.key || 0) * 0.08;
        var vb = b.cards.length * 12 - (b.ret.bomb ? 60 : 0) - (b.ret.key || 0) * 0.08;
        return vb - va;
      });
      remaining = withoutCards(remaining, candidates[0].cards);
      turns++;
    }
    return turns;
  }

  function unseenRankCounts(hand, seenCards) {
    var counts = {};
    for (var value = 3; value <= 15; value++) counts[value] = 4;
    counts[16] = 1; counts[17] = 1;
    (hand || []).concat(seenCards || []).forEach(function (card) {
      var value = Number(card.value);
      if (counts[value] != null) counts[value] = Math.max(0, counts[value] - 1);
    });
    return counts;
  }

  function controlCost(cards, hand, options) {
    var unseen = unseenRankCounts(hand, options.seenCards);
    var highestUnseen = 2;
    Object.keys(unseen).map(Number).forEach(function (value) { if (unseen[value] > 0) highestUnseen = Math.max(highestUnseen, value); });
    return (cards || []).reduce(function (sum, card) {
      var value = Number(card.value);
      if (value >= 16) return sum + 18;
      if (value === 15) return sum + 10;
      if (value >= highestUnseen) return sum + 8;
      return sum + Math.max(0, value - 11) * 1.5;
    }, 0);
  }

  function doudizhuCandidateScore(candidate, hand, options, leadMode) {
    var remaining = withoutCards(hand, candidate.cards);
    if (!remaining.length) return -100000;
    var turns = roughDoudizhuTurns(remaining);
    var score = turns * 52 + remaining.length * 0.8 + controlCost(candidate.cards, hand, options);
    score += Number(candidate.ret.key || 0) * (leadMode ? 0.16 : 0.45);
    if (candidate.ret.bomb) score += Number(options.opponentMinCardCount || 99) <= 2 ? 12 : 115;
    if (candidate.ret.type === 'KING') score += Number(options.opponentMinCardCount || 99) <= 2 ? 12 : 90;
    if (leadMode) score -= candidate.cards.length * 5;
    if (leadMode && Number(options.opponentMinCardCount || 99) <= 1 && candidate.ret.type === 'A') score += 45;
    if (leadMode && Number(options.partnerCardCount || 99) === 1 && candidate.ret.type === 'A') score -= 26;
    if (!leadMode && Number(options.opponentMinCardCount || 99) <= 2) score -= candidate.cards.length * 3;
    return score;
  }

  function doudizhuReason(best, hand, options, leadMode) {
    if (!best) return options.lastIsPartner ? '队友当前控场，保留牌力让队友继续' : '没有合法且值得的压制牌';
    var remaining = withoutCards(hand, best.cards);
    if (!remaining.length) return '可一次出完，直接结束本局';
    var turns = roughDoudizhuTurns(remaining);
    var pressure = Number(options.opponentMinCardCount || 99) <= 2 ? '，对手已进入残局，优先封锁' : '';
    return (leadMode ? '主动组织牌型' : '用较低成本接牌') + '，出后预计约 ' + turns + ' 手走完' + pressure;
  }

  function suggestDoudizhuDetailed(myCards, lastInfo, options) {
    options = options || {};
    var hand = sortCards((myCards || []).map(function (card) { return { value: Number(card.value), type: Number(card.type) || 0, deck: card.deck }; }));
    if (!hand.length) return { cards: [], action: 'pass', reason: '手牌为空', metrics: {} };
    var last = normalizeLast(lastInfo);
    var leadMode = !last.len || (lastInfo && lastInfo.ctxPos === 'self');
    var candidates = enumerateDoudizhu(hand).filter(function (candidate) { return leadMode || doudizhuCanBeat(candidate.ret, last); });
    if (!candidates.length) return { cards: [], action: 'pass', reason: doudizhuReason(null, hand, options, leadMode), metrics: { remainingTurns: roughDoudizhuTurns(hand) } };

    if (!leadMode && options.lastIsPartner) {
      var finishers = candidates.filter(function (candidate) { return candidate.cards.length === hand.length; });
      if (finishers.length) candidates = finishers;
      else return { cards: [], action: 'pass', reason: '队友当前控场，避免无谓争夺牌权', metrics: { remainingTurns: roughDoudizhuTurns(hand) } };
    }

    candidates.forEach(function (candidate) { candidate.score = doudizhuCandidateScore(candidate, hand, options, leadMode); });
    candidates.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      if (a.cards.length !== b.cards.length) return leadMode ? b.cards.length - a.cards.length : a.cards.length - b.cards.length;
      return a.ret.key - b.ret.key;
    });
    var best = candidates[0];
    return {
      cards: best.cards,
      action: 'play',
      reason: doudizhuReason(best, hand, options, leadMode),
      metrics: { remainingTurns: roughDoudizhuTurns(withoutCards(hand, best.cards)), type: best.ret.type, candidateCount: candidates.length },
      alternatives: candidates.slice(0, 3).map(function (item) { return { cards: item.cards, type: item.ret.type, score: item.score }; })
    };
  }

  function evaluateDoudizhuHand(cards, options) {
    options = options || {};
    var hand = sortCards(cards || []);
    var groups = groupByValue(hand);
    var power = 30 - roughDoudizhuTurns(hand) * 4;
    Object.keys(groups).forEach(function (key) {
      var value = Number(key), count = groups[key].length;
      if (count >= 4) power += 8;
      if (value === 15) power += count * 2.4;
      if (value >= 16) power += 4.5;
      if (value >= 13 && value < 15) power += count * 0.8;
    });
    if (groups[16] && groups[17]) power += 7;
    return Math.round(power * 10) / 10;
  }

  function recommendDoudizhuBid(cards, availableScores) {
    var power = evaluateDoudizhuHand(cards);
    var wanted = power >= 23 ? 3 : (power >= 16 ? 2 : (power >= 10 ? 1 : 0));
    var available = (availableScores || []).map(Number).sort(function (a, b) { return b - a; });
    for (var i = 0; i < available.length; i++) if (available[i] <= wanted) return { score: available[i], power: power, reason: '牌力 ' + power + '，预计 ' + roughDoudizhuTurns(cards || []) + ' 手完成' };
    return { score: 0, power: power, reason: '牌型分散或控制力不足，建议不叫' };
  }

  function getGuandanEngine() {
    return nodeGuandan || global.GuandanSuggest;
  }

  function roughGuandanTurns(hand, engine, levelRank) {
    var remaining = sortCards(hand);
    var turns = 0, guard = 0;
    while (remaining.length && guard++ < 30) {
      var candidates = engine.enumerate(remaining, levelRank).filter(function (candidate) { return !candidate.ret.bomb || candidate.cards.length === remaining.length; });
      if (!candidates.length) { turns += remaining.length; break; }
      candidates.sort(function (a, b) {
        var va = a.cards.length * 10 - (a.ret.bomb ? 80 : 0);
        var vb = b.cards.length * 10 - (b.ret.bomb ? 80 : 0);
        return vb - va;
      });
      remaining = withoutCards(remaining, candidates[0].cards);
      turns++;
    }
    return turns;
  }

  function suggestGuandanDetailed(myCards, lastInfo, options) {
    options = options || {};
    var engine = getGuandanEngine();
    if (!engine) return { cards: [], action: 'pass', reason: '掼蛋规则引擎未加载', metrics: {} };
    var hand = sortCards(myCards || []);
    var levelRank = Number(options.levelRank) || engine.rankFromLabel(options.levelLabel);
    var last = lastInfo && Number(lastInfo.len) ? {
      len: Number(lastInfo.len), key: Number(lastInfo.key) || 0, type: lastInfo.type || '', bomb: !!lastInfo.bomb,
      bombPower: Number(lastInfo.bombPower) || (lastInfo.type === 'JOKER_BOMB' ? 100 : (lastInfo.type === 'STRAIGHT_FLUSH' ? 5.5 : (lastInfo.type === 'BOMB' ? Number(lastInfo.len) : 0)))
    } : { len: 0 };
    var leadMode = !last.len || (lastInfo && lastInfo.ctxPos === 'self');
    var candidates = engine.enumerate(hand, levelRank).filter(function (candidate) { return leadMode || engine.canBeat(candidate.ret, last); });
    if (!candidates.length) return { cards: [], action: 'pass', reason: '没有合法压制牌，保留牌型', metrics: { remainingTurns: roughGuandanTurns(hand, engine, levelRank) } };

    if (!leadMode && options.lastIsPartner) {
      var finishers = candidates.filter(function (candidate) { return candidate.cards.length === hand.length; });
      if (finishers.length) candidates = finishers;
      else return { cards: [], action: 'pass', reason: '队友持有牌权，配合让牌', metrics: { remainingTurns: roughGuandanTurns(hand, engine, levelRank) } };
    }

    candidates.forEach(function (candidate) {
      var remaining = withoutCards(hand, candidate.cards);
      var turns = remaining.length ? roughGuandanTurns(remaining, engine, levelRank) : 0;
      var score = turns * 58 + remaining.length * 0.7 + Number(candidate.ret.key || 0) * 0.28;
      if (!remaining.length) score -= 100000;
      if (candidate.ret.bomb) score += Number(options.opponentMinCardCount || 99) <= 3 ? 15 : 125;
      if (candidate.ret.type === 'JOKER_BOMB') score += Number(options.opponentMinCardCount || 99) <= 2 ? 8 : 120;
      if (leadMode) score -= candidate.cards.length * 4;
      if (leadMode && Number(options.teammateCardCount || 99) === 1 && candidate.ret.type === 'SINGLE') score -= 35;
      if (leadMode && Number(options.opponentMinCardCount || 99) === 1 && candidate.ret.type === 'SINGLE') score += 48;
      candidate.score = score;
    });
    candidates.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      if (a.cards.length !== b.cards.length) return leadMode ? b.cards.length - a.cards.length : a.cards.length - b.cards.length;
      return Number(a.ret.key || 0) - Number(b.ret.key || 0);
    });
    var best = candidates[0];
    var left = withoutCards(hand, best.cards);
    return {
      cards: best.cards,
      action: 'play',
      reason: left.length ? ('兼顾队友牌权，出后预计约 ' + roughGuandanTurns(left, engine, levelRank) + ' 手走完') : '本手可以直接走完',
      metrics: { remainingTurns: roughGuandanTurns(left, engine, levelRank), type: best.ret.type, candidateCount: candidates.length },
      alternatives: candidates.slice(0, 3).map(function (item) { return { cards: item.cards, type: item.ret.type, score: item.score }; })
    };
  }

  var SmartAI = {
    doudizhu: {
      enumerate: enumerateDoudizhu,
      suggestDetailed: suggestDoudizhuDetailed,
      suggest: function (cards, lastInfo, options) { return suggestDoudizhuDetailed(cards, lastInfo, options).cards; },
      evaluateHand: evaluateDoudizhuHand,
      recommendBid: recommendDoudizhuBid,
      roughTurns: roughDoudizhuTurns
    },
    guandan: {
      suggestDetailed: suggestGuandanDetailed,
      suggest: function (cards, lastInfo, options) { return suggestGuandanDetailed(cards, lastInfo, options).cards; }
    }
  };

  global.SmartAI = SmartAI;
  if (typeof module !== 'undefined' && module.exports) module.exports.SmartAI = SmartAI;
})(typeof window !== 'undefined' ? window : global);
