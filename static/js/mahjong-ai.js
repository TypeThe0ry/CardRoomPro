/* =====================================================================
 * 雀阁 · 麻将 AI（机器人 / 智囊共用）
 *
 * 决策依据：标准型与七对向听数、有效进张数量、公开牌剩余量、牌河安全度、
 * 局面阶段以及吃碰杠之后的牌效变化。模块不读取其他玩家暗牌。
 * ===================================================================== */
(function (global) {
  'use strict';

  var TILE_COUNT = 34;
  var TILE_LABELS = [
    '一万', '二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万',
    '一条', '二条', '三条', '四条', '五条', '六条', '七条', '八条', '九条',
    '一筒', '二筒', '三筒', '四筒', '五筒', '六筒', '七筒', '八筒', '九筒',
    '东', '南', '西', '北', '中', '发', '白'
  ];

  function tileValue(tile) {
    return tile == null ? -1 : Number(tile.value == null ? tile : tile.value);
  }

  function cloneTile(tile) {
    return { value: tileValue(tile), type: Number(tile && tile.type) || 0 };
  }

  function countsFor(cards) {
    var counts = Array(TILE_COUNT).fill(0);
    (cards || []).forEach(function (tile) {
      var value = tileValue(tile);
      if (value >= 0 && value < TILE_COUNT) counts[value]++;
    });
    return counts;
  }

  function cardsFromCounts(counts) {
    var cards = [];
    for (var value = 0; value < TILE_COUNT; value++) {
      for (var n = 0; n < counts[value]; n++) cards.push({ value: value, type: 0 });
    }
    return cards;
  }

  function isSuit(value) {
    return value >= 0 && value < 27;
  }

  function rank(value) {
    return value % 9;
  }

  function standardShanten(cards, openMelds) {
    var counts = countsFor(cards);
    var memo = {};
    var best = 8;
    openMelds = Math.max(0, Math.min(4, Number(openMelds) || 0));

    function walk(index, melds, taatsu, pair) {
      while (index < TILE_COUNT && counts[index] === 0) index++;
      if (melds > 4) return;
      if (melds + taatsu > 4) taatsu = 4 - melds;
      var lowerBound = 8 - melds * 2 - taatsu - pair;
      if (lowerBound >= best && index >= TILE_COUNT) return;
      if (index >= TILE_COUNT) {
        if (lowerBound < best) best = lowerBound;
        return;
      }

      var key = index + '|' + counts.join('') + '|' + melds + '|' + taatsu + '|' + pair;
      if (memo[key] != null && memo[key] <= lowerBound) return;
      memo[key] = lowerBound;

      if (counts[index] >= 3) {
        counts[index] -= 3;
        walk(index, melds + 1, taatsu, pair);
        counts[index] += 3;
      }

      if (isSuit(index) && rank(index) <= 6 && counts[index + 1] && counts[index + 2]) {
        counts[index]--; counts[index + 1]--; counts[index + 2]--;
        walk(index, melds + 1, taatsu, pair);
        counts[index]++; counts[index + 1]++; counts[index + 2]++;
      }

      if (!pair && counts[index] >= 2) {
        counts[index] -= 2;
        walk(index, melds, taatsu, 1);
        counts[index] += 2;
      }

      if (melds + taatsu < 4 && counts[index] >= 2) {
        counts[index] -= 2;
        walk(index, melds, taatsu + 1, pair);
        counts[index] += 2;
      }

      if (melds + taatsu < 4 && isSuit(index)) {
        if (rank(index) <= 7 && counts[index + 1]) {
          counts[index]--; counts[index + 1]--;
          walk(index, melds, taatsu + 1, pair);
          counts[index]++; counts[index + 1]++;
        }
        if (rank(index) <= 6 && counts[index + 2]) {
          counts[index]--; counts[index + 2]--;
          walk(index, melds, taatsu + 1, pair);
          counts[index]++; counts[index + 2]++;
        }
      }

      counts[index]--;
      walk(index, melds, taatsu, pair);
      counts[index]++;
    }

    walk(0, openMelds, 0, 0);
    return best;
  }

  function sevenPairsShanten(cards, openMelds) {
    if (Number(openMelds) > 0) return 99;
    var counts = countsFor(cards);
    var pairs = 0;
    var distinct = 0;
    counts.forEach(function (n) {
      if (n > 0) distinct++;
      if (n >= 2) pairs++;
    });
    return 6 - pairs + Math.max(0, 7 - distinct);
  }

  function calculateShanten(cards, openMelds) {
    return Math.min(standardShanten(cards, openMelds), sevenPairsShanten(cards, openMelds));
  }

  function flattenTiles(groups) {
    var out = [];
    if (!groups) return out;
    if (Array.isArray(groups)) {
      groups.forEach(function (item) {
        if (Array.isArray(item)) out = out.concat(flattenTiles(item));
        else if (item && Array.isArray(item.cards)) out = out.concat(flattenTiles(item.cards));
        else if (item && item.value != null) out.push(item);
      });
      return out;
    }
    Object.keys(groups).forEach(function (key) { out = out.concat(flattenTiles(groups[key])); });
    return out;
  }

  function remainingCounts(hand, options) {
    options = options || {};
    var visible = (hand || []).concat(flattenTiles(options.discards), flattenTiles(options.melds));
    var used = countsFor(visible);
    return used.map(function (n) { return Math.max(0, 4 - n); });
  }

  function effectiveTiles(cards, openMelds, remaining) {
    var current = calculateShanten(cards, openMelds);
    var values = [];
    var total = 0;
    for (var value = 0; value < TILE_COUNT; value++) {
      if (!remaining[value]) continue;
      var next = cards.concat([{ value: value, type: 0 }]);
      if (calculateShanten(next, openMelds) < current) {
        values.push(value);
        total += remaining[value];
      }
    }
    return { values: values, total: total };
  }

  function opponentRiverLists(discards, selfPos) {
    var lists = [];
    if (!discards) return lists;
    if (Array.isArray(discards)) {
      discards.forEach(function (river, pos) {
        if (Number(pos) !== Number(selfPos)) lists.push(flattenTiles(river));
      });
    } else {
      Object.keys(discards).forEach(function (key) {
        if (key !== 'self') lists.push(flattenTiles(discards[key]));
      });
    }
    return lists;
  }

  function tileDanger(value, options, visibleCounts) {
    options = options || {};
    var rivers = opponentRiverLists(options.discards, options.selfPos);
    if (rivers.some(function (river) { return river.some(function (tile) { return tileValue(tile) === value; }); })) return 0.15;

    var late = Math.max(0, Math.min(1, (83 - Number(options.wallCount == null ? 83 : options.wallCount)) / 83));
    var aggression = 0;
    var meldGroups = options.melds || [];
    if (Array.isArray(meldGroups)) {
      meldGroups.forEach(function (groups, pos) {
        if (Number(pos) !== Number(options.selfPos)) aggression += (groups || []).length;
      });
    } else {
      Object.keys(meldGroups).forEach(function (key) { if (key !== 'self') aggression += (meldGroups[key] || []).length; });
    }

    if (value >= 27) {
      var seenHonor = visibleCounts[value] || 0;
      if (seenHonor >= 3) return 0.25;
      if (seenHonor === 2) return 0.9 + late;
      if (seenHonor === 1) return 1.8 + late * 1.4;
      return 2.8 + late * 2 + aggression * 0.12;
    }

    var r = rank(value);
    var base = r === 0 || r === 8 ? 1.15 : (r === 1 || r === 7 ? 1.8 : 2.6);
    var sujiSafe = rivers.some(function (river) {
      return river.some(function (tile) {
        var other = tileValue(tile);
        return other >= 0 && other < 27 && Math.floor(other / 9) === Math.floor(value / 9) && Math.abs(rank(other) - r) === 3;
      });
    });
    if (sujiSafe) base *= 0.62;
    return base + late * 1.8 + aggression * 0.1;
  }

  function shapePenalty(value, counts) {
    if (counts[value] >= 2) return 2.6;
    if (value >= 27) return counts[value] === 1 ? -0.25 : 0;
    var r = rank(value);
    var neighbors = 0;
    if (r > 0 && counts[value - 1]) neighbors += 1.2;
    if (r < 8 && counts[value + 1]) neighbors += 1.2;
    if (r > 1 && counts[value - 2]) neighbors += 0.55;
    if (r < 7 && counts[value + 2]) neighbors += 0.55;
    return neighbors;
  }

  function analyzeDiscards(hand, options) {
    options = options || {};
    var openMelds = Number(options.openMelds) || 0;
    var remaining = remainingCounts(hand, options);
    var visibleCounts = remaining.map(function (n) { return 4 - n; });
    var counts = countsFor(hand);
    var late = Math.max(0, Math.min(1, (83 - Number(options.wallCount == null ? 83 : options.wallCount)) / 83));
    var candidates = [];

    for (var value = 0; value < TILE_COUNT; value++) {
      if (!counts[value]) continue;
      var nextCounts = counts.slice(0);
      nextCounts[value]--;
      var next = cardsFromCounts(nextCounts);
      var shanten = calculateShanten(next, openMelds);
      var effective = effectiveTiles(next, openMelds, remaining);
      var danger = tileDanger(value, options, visibleCounts);
      var keepShape = shapePenalty(value, counts);
      var score = shanten * 125 - effective.total * 3.2 + keepShape * 5 + danger * (3 + late * 13);
      if (value >= 27 && counts[value] === 1 && visibleCounts[value] >= 2) score -= 10;
      if (value < 27 && (rank(value) === 0 || rank(value) === 8) && keepShape < 0.8) score -= 3;
      candidates.push({
        card: { value: value, type: 0 },
        value: value,
        label: TILE_LABELS[value],
        shanten: shanten,
        ukeire: effective.total,
        effectiveTiles: effective.values,
        danger: Math.round(danger * 10) / 10,
        score: score
      });
    }

    candidates.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      if (a.shanten !== b.shanten) return a.shanten - b.shanten;
      if (a.ukeire !== b.ukeire) return b.ukeire - a.ukeire;
      return a.value - b.value;
    });
    return candidates;
  }

  function shantenLabel(shanten) {
    if (shanten < 0) return '已和牌';
    if (shanten === 0) return '听牌';
    return shanten + ' 向听';
  }

  function formatReason(best) {
    if (!best) return '暂无可分析的弃牌';
    var waits = best.effectiveTiles.map(function (value) { return TILE_LABELS[value]; });
    if (best.shanten === 0) {
      return '打 ' + best.label + ' 后听 ' + (waits.join('、') || '未知牌') + '，牌池约剩 ' + best.ukeire + ' 张';
    }
    return '打 ' + best.label + ' 后为 ' + shantenLabel(best.shanten) + '，' + waits.length + ' 种进张约 ' + best.ukeire + ' 张';
  }

  function suggestDiscard(hand, options) {
    var candidates = analyzeDiscards(hand, options);
    var best = candidates[0] || null;
    return {
      action: best ? 'discard' : 'pass',
      card: best ? cloneTile(best.card) : null,
      shanten: best ? best.shanten : 99,
      ukeire: best ? best.ukeire : 0,
      effectiveTiles: best ? best.effectiveTiles.slice(0) : [],
      danger: best ? best.danger : 0,
      reason: formatReason(best),
      alternatives: candidates.slice(0, 3)
    };
  }

  function removeValues(hand, values) {
    var next = (hand || []).map(cloneTile);
    for (var i = 0; i < values.length; i++) {
      var index = next.findIndex(function (tile) { return tile.value === values[i]; });
      if (index < 0) return null;
      next.splice(index, 1);
    }
    return next;
  }

  function chiNeeds(hand, discard) {
    var value = tileValue(discard);
    if (!isSuit(value)) return null;
    var counts = countsFor(hand);
    var starts = [value, value - 1, value - 2];
    for (var i = 0; i < starts.length; i++) {
      var start = starts[i];
      if (start < 0 || !isSuit(start) || rank(start) > 6 || Math.floor(start / 9) !== Math.floor(value / 9)) continue;
      var needed = [start, start + 1, start + 2].filter(function (v) { return v !== value; });
      if (needed.every(function (v) { return counts[v] > 0; })) return needed;
    }
    return null;
  }

  function baseEfficiency(hand, options) {
    var openMelds = Number(options.openMelds) || 0;
    var remaining = remainingCounts(hand, options);
    var shanten = calculateShanten(hand, openMelds);
    var effective = effectiveTiles(hand, openMelds, remaining);
    return { shanten: shanten, ukeire: effective.total };
  }

  function chooseClaim(hand, actions, discard, options) {
    options = options || {};
    actions = actions || [];
    if (actions.indexOf('hu') >= 0) return { action: 'hu', reason: '已满足和牌条件，立即胡牌' };

    var baseline = baseEfficiency(hand, options);
    var openMelds = Number(options.openMelds) || 0;
    var choices = [{ action: 'pass', shanten: baseline.shanten, ukeire: baseline.ukeire, score: baseline.shanten * 120 - baseline.ukeire * 2.5, reason: '保持门前牌效' }];
    var value = tileValue(discard);

    function addMeldChoice(action, needed) {
      var afterTake = removeValues(hand, needed);
      if (!afterTake) return;
      var nextOptions = {};
      Object.keys(options).forEach(function (key) { nextOptions[key] = options[key]; });
      nextOptions.openMelds = openMelds + 1;
      var advice = suggestDiscard(afterTake, nextOptions);
      var pressure = Number(options.wallCount || 83) < 32 ? 5 : 0;
      var score = advice.shanten * 120 - advice.ukeire * 2.8 + advice.danger * pressure;
      if (action === 'chi') score += 5;
      choices.push({ action: action, shanten: advice.shanten, ukeire: advice.ukeire, score: score, discard: advice.card, reason: action + '后' + advice.reason });
    }

    if (actions.indexOf('gang') >= 0) {
      var gangHand = removeValues(hand, [value, value, value]);
      if (gangHand) {
        var gangShanten = calculateShanten(gangHand, openMelds + 1);
        choices.push({ action: 'gang', shanten: gangShanten, ukeire: baseline.ukeire + 4, score: gangShanten * 120 - (baseline.ukeire + 4) * 2.8 - 7, reason: '杠后补张，且不明显损失向听' });
      }
    }
    if (actions.indexOf('peng') >= 0) addMeldChoice('peng', [value, value]);
    if (actions.indexOf('chi') >= 0) {
      var needed = chiNeeds(hand, discard);
      if (needed) addMeldChoice('chi', needed);
    }

    choices.sort(function (a, b) { return a.score - b.score; });
    var best = choices[0];
    if (best.action !== 'pass' && best.shanten > baseline.shanten) best = choices.find(function (item) { return item.action === 'pass'; }) || best;
    return best;
  }

  function shouldConcealedGang(hand, options) {
    options = options || {};
    var counts = countsFor(hand);
    var value = counts.findIndex(function (n) { return n === 4; });
    if (value < 0) return { action: 'pass', reason: '没有可暗杠的牌' };
    var before = calculateShanten(hand, Number(options.openMelds) || 0);
    var afterHand = removeValues(hand, [value, value, value, value]);
    var after = calculateShanten(afterHand, (Number(options.openMelds) || 0) + 1);
    var safe = after <= before && Number(options.wallCount == null ? 83 : options.wallCount) > 8;
    return { action: safe ? 'gang' : 'pass', card: { value: value, type: 0 }, reason: safe ? '暗杠不增加向听并获得补张' : '暗杠会破坏当前牌效，建议保留', shanten: after };
  }

  var MahjongAI = {
    TILE_LABELS: TILE_LABELS,
    calculateShanten: calculateShanten,
    effectiveTiles: effectiveTiles,
    analyzeDiscards: analyzeDiscards,
    suggestDiscard: suggestDiscard,
    chooseClaim: chooseClaim,
    shouldConcealedGang: shouldConcealedGang,
    remainingCounts: remainingCounts
  };

  global.MahjongAI = MahjongAI;
  if (typeof module !== 'undefined' && module.exports) module.exports.MahjongAI = MahjongAI;
})(typeof window !== 'undefined' ? window : global);
