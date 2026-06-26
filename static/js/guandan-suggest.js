/* =====================================================================
 * 雀阁 · 掼蛋 AI 建议器（机器人 / 智囊共用）
 * 支持：单、对、三、葫芦、顺子、连对、三连、炸弹、同花顺、四王炸、
 *       红桃级牌逢人配。
 * 策略：
 *   - 自由出牌：优先减少手数，尽量走低牌组合；保留炸弹和万能牌。
 *   - 跟牌：用最小可压牌；队友出牌时默认不压，除非可以直接走完。
 *   - 炸弹：非必要不炸；对方快没牌或自己可收尾时才更积极。
 * ===================================================================== */
(function (global) {
  'use strict';

  var HEART_TYPE = 2;
  var NORMAL_VALUES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  var SEQUENCE_ORDER = [14, 15, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

  function rankFromLabel(label) {
    if (label === 'J') return 11;
    if (label === 'Q') return 12;
    if (label === 'K') return 13;
    if (label === 'A') return 14;
    if (label === '2') return 15;
    var n = Number(label);
    return n >= 3 && n <= 15 ? n : 15;
  }

  function cardKey(c) {
    return [c.value, c.type, c.deck == null ? 0 : c.deck].join('_');
  }

  function sortCards(cards) {
    return cards.slice(0).sort(function (a, b) {
      if (a.value !== b.value) return a.value - b.value;
      if (a.type !== b.type) return a.type - b.type;
      return (a.deck || 0) - (b.deck || 0);
    });
  }

  function isWild(card, levelRank) {
    return card.value === levelRank && card.type === HEART_TYPE;
  }

  function sameSuit(cards) {
    if (!cards.length) return false;
    return cards.every(function (c) { return c.type === cards[0].type && c.value < 16; });
  }

  function countValues(cards) {
    var out = {};
    cards.forEach(function (c) { out[c.value] = (out[c.value] || 0) + 1; });
    return out;
  }

  function groupByValue(cards, levelRank) {
    var groups = {};
    var wilds = [];
    sortCards(cards).forEach(function (c) {
      if (isWild(c, levelRank)) {
        wilds.push(c);
      } else {
        (groups[c.value] = groups[c.value] || []).push(c);
      }
    });
    return { groups: groups, wilds: wilds };
  }

  function withoutCards(cards, usedCards) {
    var used = {};
    usedCards.forEach(function (c) { used[cardKey(c)] = (used[cardKey(c)] || 0) + 1; });
    return cards.filter(function (c) {
      var k = cardKey(c);
      if (used[k]) {
        used[k]--;
        return false;
      }
      return true;
    });
  }

  function uniqPush(cands, cards, ret, source) {
    if (!cards || !cards.length || !ret || !ret.status) return;
    var seen = {};
    var dedup = [];
    cards.forEach(function (c) {
      var k = cardKey(c);
      if (!seen[k]) {
        seen[k] = true;
        dedup.push(c);
      }
    });
    if (dedup.length !== cards.length) return;
    var sig = dedup.map(cardKey).sort().join('|');
    if (cands._seen[sig]) return;
    cands._seen[sig] = true;
    cands.push({ cards: sortCards(dedup), ret: ret, source: source || '' });
  }

  function canBuildSameKind(cards, wildCount, size) {
    var normals = cards.filter(function (c) { return !c.__wild; });
    var counts = countValues(normals);
    var values = Object.keys(counts).map(Number).filter(function (v) { return v < 16; });
    if (!values.length) return { ok: wildCount >= size, key: 0 };
    if (values.length !== 1) return { ok: false };
    var v = values[0];
    return { ok: counts[v] + wildCount >= size, key: v };
  }

  function canBuildUnitSequence(cards, wildCount, unitSize, unitCount) {
    var normals = cards.filter(function (c) { return !c.__wild; });
    var counts = countValues(normals);
    var values = Object.keys(counts).map(Number);
    if (normals.some(function (c) { return c.value >= 16; })) return { ok: false };
    if (values.some(function (v) { return counts[v] > unitSize; })) return { ok: false };
    for (var start = 0; start <= SEQUENCE_ORDER.length - unitCount; start++) {
      var seq = SEQUENCE_ORDER.slice(start, start + unitCount);
      var need = 0;
      seq.forEach(function (v) { need += Math.max(0, unitSize - (counts[v] || 0)); });
      if (need <= wildCount && values.every(function (v) { return seq.indexOf(v) >= 0; })) {
        return { ok: true, key: start };
      }
    }
    return { ok: false };
  }

  function canBuildPairsSequence(cards, wildCount, pairCount) {
    return canBuildUnitSequence(cards, wildCount, 2, pairCount);
  }

  function canBuildTriplesSequence(cards, wildCount, tripleCount) {
    return canBuildUnitSequence(cards, wildCount, 3, tripleCount);
  }

  function canBuildStraight(cards, wildCount, len) {
    return canBuildUnitSequence(cards, wildCount, 1, len);
  }

  function analyze(cards, levelRank) {
    var cloned = cards.map(function (c) {
      var copy = {};
      Object.keys(c).forEach(function (k) { copy[k] = c[k]; });
      copy.__wild = isWild(c, levelRank);
      return copy;
    });
    var wildCount = cloned.filter(function (c) { return c.__wild; }).length;
    var normals = cloned.filter(function (c) { return !c.__wild; });
    var len = cloned.length;
    var values = normals.map(function (c) { return c.value; });
    var counts = countValues(normals);
    var countVals = Object.keys(counts).map(Number);
    if (!len) return { status: false };

    var jokers = cloned.filter(function (c) { return c.value >= 16; });
    if (len === 4 && jokers.length === 4) {
      return { status: true, len: len, key: 99, type: 'JOKER_BOMB', bomb: true, bombPower: 100 };
    }

    var sameKind = canBuildSameKind(cloned, wildCount, len);
    if (len >= 4 && sameKind.ok) {
      return { status: true, len: len, key: sameKind.key, type: 'BOMB', bomb: true, bombPower: len };
    }

    if (len === 5 && sameSuit(normals)) {
      var sf = canBuildStraight(cloned, wildCount, 5);
      if (sf.ok) return { status: true, len: len, key: sf.key, type: 'STRAIGHT_FLUSH', bomb: true, bombPower: 5.5 };
    }

    if (len === 1) return { status: true, len: len, key: cloned[0].value, type: 'SINGLE' };
    if (len === 2) {
      var pair = canBuildSameKind(cloned, wildCount, 2);
      if (pair.ok) return { status: true, len: len, key: pair.key, type: 'PAIR' };
    }
    if (len === 3) {
      var triple = canBuildSameKind(cloned, wildCount, 3);
      if (triple.ok) return { status: true, len: len, key: triple.key, type: 'TRIPLE' };
    }

    if (len === 5) {
      var straight = canBuildStraight(cloned, wildCount, 5);
      if (straight.ok) return { status: true, len: len, key: straight.key, type: 'STRAIGHT' };
      for (var tv = 3; tv <= 15; tv++) {
        var tripleNeed = Math.max(0, 3 - (counts[tv] || 0));
        if (tripleNeed > wildCount) continue;
        var leftWild = wildCount - tripleNeed;
        var rest = normals.filter(function (c) { return c.value !== tv; });
        var restCounts = countValues(rest);
        var pairValue = Object.keys(restCounts).map(Number).find(function (v) {
          return restCounts[v] + leftWild >= 2;
        });
        if (pairValue || (rest.length === 0 && leftWild >= 2)) {
          return { status: true, len: len, key: tv, type: 'FULL_HOUSE' };
        }
      }
    }

    if (len === 6) {
      var pairs = canBuildPairsSequence(cloned, wildCount, 3);
      if (pairs.ok) return { status: true, len: len, key: pairs.key, type: 'PAIRS_SEQ' };
    }
    if (len === 6) {
      var triples = canBuildTriplesSequence(cloned, wildCount, 2);
      if (triples.ok) return { status: true, len: len, key: triples.key, type: 'TRIPLES_SEQ' };
    }
    if (countVals.length === 1 && values.length + wildCount === len && len < 4) {
      return { status: true, len: len, key: countVals[0], type: len === 2 ? 'PAIR' : 'TRIPLE' };
    }
    return { status: false };
  }

  function canBeat(current, last) {
    if (!last || !last.len) return true;
    if (current.bomb || last.bomb) {
      if (!current.bomb) return false;
      if (!last.bomb) return true;
      if (current.bombPower !== last.bombPower) return current.bombPower > last.bombPower;
      return current.key > last.key;
    }
    return current.type === last.type && current.len === last.len && current.key > last.key;
  }

  function takeSameKind(parts, value, size, usedWilds) {
    var normals = (parts.groups[value] || []).slice(0, size);
    var need = size - normals.length;
    if (need < 0) need = 0;
    if (need > parts.wilds.length - usedWilds.length) return null;
    return normals.concat(parts.wilds.slice(usedWilds.length, usedWilds.length + need));
  }

  function addSameKindCandidates(cands, hand, levelRank, size, source) {
    var parts = groupByValue(hand, levelRank);
    var values = size === 2 ? NORMAL_VALUES.concat([16, 17]) : NORMAL_VALUES;
    values.forEach(function (v) {
      var cards = takeSameKind(parts, v, size, []);
      if (cards && cards.length === size) {
        var ret = analyze(cards, levelRank);
        uniqPush(cands, cards, ret, source);
      }
    });
  }

  function addStraightCandidates(cands, hand, levelRank, flushOnly) {
    var parts = groupByValue(hand, levelRank);
    var suits = flushOnly ? [0, 1, 2, 3] : [null];
    for (var start = 0; start <= SEQUENCE_ORDER.length - 5; start++) {
      suits.forEach(function (suit) {
        var cards = [];
        var usedWilds = 0;
        var ok = true;
        for (var i = 0; i < 5; i++) {
          var v = SEQUENCE_ORDER[start + i];
          var bucket = (parts.groups[v] || []).filter(function (c) { return suit == null || c.type === suit; });
          if (bucket.length) {
            cards.push(bucket[0]);
          } else if (usedWilds < parts.wilds.length) {
            cards.push(parts.wilds[usedWilds++]);
          } else {
            ok = false;
            break;
          }
        }
        if (ok) uniqPush(cands, cards, analyze(cards, levelRank), flushOnly ? 'straightFlush' : 'straight');
      });
    }
  }

  function addSequenceCandidates(cands, hand, levelRank, unit, groupCount, source) {
    var parts = groupByValue(hand, levelRank);
    for (var start = 0; start <= SEQUENCE_ORDER.length - groupCount; start++) {
      var cards = [];
      var usedWilds = 0;
      var ok = true;
      for (var i = 0; i < groupCount; i++) {
        var v = SEQUENCE_ORDER[start + i];
        var normals = (parts.groups[v] || []).slice(0, unit);
        cards = cards.concat(normals);
        var need = unit - normals.length;
        if (need > parts.wilds.length - usedWilds) { ok = false; break; }
        cards = cards.concat(parts.wilds.slice(usedWilds, usedWilds + need));
        usedWilds += need;
      }
      if (ok) uniqPush(cands, cards, analyze(cards, levelRank), source);
    }
  }

  function addFullHouseCandidates(cands, hand, levelRank) {
    var parts = groupByValue(hand, levelRank);
    NORMAL_VALUES.forEach(function (tripleValue) {
      var triple = takeSameKind(parts, tripleValue, 3, []);
      if (!triple) return;
      var rest = withoutCards(hand, triple);
      var restParts = groupByValue(rest, levelRank);
      NORMAL_VALUES.forEach(function (pairValue) {
        if (pairValue === tripleValue) return;
        var pair = takeSameKind(restParts, pairValue, 2, []);
        if (!pair) return;
        var cards = triple.concat(pair);
        uniqPush(cands, cards, analyze(cards, levelRank), 'fullHouse');
      });
    });
  }

  function addJokerBomb(cands, hand, levelRank) {
    var jokers = sortCards(hand.filter(function (c) { return c.value >= 16; }));
    if (jokers.length >= 4) uniqPush(cands, jokers.slice(0, 4), analyze(jokers.slice(0, 4), levelRank), 'jokerBomb');
  }

  function enumerate(hand, levelRank) {
    hand = sortCards(hand || []);
    var cands = [];
    cands._seen = {};
    hand.forEach(function (c) { uniqPush(cands, [c], analyze([c], levelRank), 'single'); });
    addSameKindCandidates(cands, hand, levelRank, 2, 'pair');
    addSameKindCandidates(cands, hand, levelRank, 3, 'triple');
    addFullHouseCandidates(cands, hand, levelRank);
    addStraightCandidates(cands, hand, levelRank, false);
    addSequenceCandidates(cands, hand, levelRank, 2, 3, 'pairsSeq');
    addSequenceCandidates(cands, hand, levelRank, 3, 2, 'triplesSeq');
    for (var size = 4; size <= Math.min(8, hand.length); size++) {
      addSameKindCandidates(cands, hand, levelRank, size, 'bomb');
    }
    addStraightCandidates(cands, hand, levelRank, true);
    addJokerBomb(cands, hand, levelRank);
    delete cands._seen;
    return cands;
  }

  function cardCost(card, levelRank) {
    if (isWild(card, levelRank)) return 12;
    if (card.value >= 16) return 14;
    if (card.value === 15) return 9;
    if (card.value >= 13) return 6;
    return Math.max(0, card.value - 3) * 0.3;
  }

  function comboCost(candidate, hand, levelRank, options, leadMode) {
    var ret = candidate.ret;
    var finish = candidate.cards.length === hand.length;
    var score = 0;
    score += ret.key || 0;
    score += candidate.cards.reduce(function (sum, c) { return sum + cardCost(c, levelRank); }, 0);
    score -= candidate.cards.length * (leadMode ? 3.8 : 1.2);

    if (ret.bomb) score += leadMode ? 90 : 46;
    if (ret.type === 'JOKER_BOMB') score += 180;
    if (ret.type === 'STRAIGHT_FLUSH') score += leadMode ? 60 : 22;
    if (candidate.source === 'straight' || candidate.source === 'pairsSeq' || candidate.source === 'triplesSeq') score -= 16;
    if (candidate.source === 'fullHouse') score -= 12;
    if (finish) score -= 1000;

    var oppMin = Number(options.opponentMinCardCount || 99);
    if (!leadMode && ret.bomb && oppMin <= 3) score -= 38;
    if (!leadMode && hand.length <= candidate.cards.length + 2) score -= 30;
    return score;
  }

  function normalizeLast(lastInfo) {
    if (!lastInfo || !lastInfo.len) return { len: 0 };
    return {
      len: Number(lastInfo.len) || 0,
      key: Number(lastInfo.key) || 0,
      type: lastInfo.type || '',
      bomb: !!lastInfo.bomb || lastInfo.type === 'BOMB' || lastInfo.type === 'STRAIGHT_FLUSH' || lastInfo.type === 'JOKER_BOMB',
      bombPower: Number(lastInfo.bombPower) || (lastInfo.type === 'JOKER_BOMB' ? 100 : (lastInfo.type === 'STRAIGHT_FLUSH' ? 5.5 : (lastInfo.type === 'BOMB' ? Number(lastInfo.len) || 0 : 0)))
    };
  }

  function suggest(myCards, lastInfo, options) {
    options = options || {};
    var levelRank = Number(options.levelRank) || rankFromLabel(options.levelLabel);
    var hand = sortCards((myCards || []).map(function (c) {
      return { value: Number(c.value), type: Number(c.type), deck: c.deck == null ? undefined : Number(c.deck) };
    }));
    if (!hand.length) return [];

    var last = normalizeLast(lastInfo);
    var leadMode = !last.len || (lastInfo && lastInfo.ctxPos === 'self');
    var candidates = enumerate(hand, levelRank).filter(function (cand) {
      return leadMode || canBeat(cand.ret, last);
    });
    if (!candidates.length) return [];

    if (!leadMode && options.lastIsPartner) {
      var finishers = candidates.filter(function (cand) { return cand.cards.length === hand.length; });
      if (finishers.length) candidates = finishers;
      else return [];
    }

    candidates.sort(function (a, b) {
      var sa = comboCost(a, hand, levelRank, options, leadMode);
      var sb = comboCost(b, hand, levelRank, options, leadMode);
      if (sa !== sb) return sa - sb;
      if (a.cards.length !== b.cards.length) return leadMode ? b.cards.length - a.cards.length : a.cards.length - b.cards.length;
      return (a.ret.key || 0) - (b.ret.key || 0);
    });
    return candidates[0].cards.map(function (c) {
      return { value: c.value, type: c.type, deck: c.deck };
    });
  }

  global.GuandanSuggest = {
    suggest: suggest,
    analyze: analyze,
    canBeat: canBeat,
    enumerate: enumerate,
    rankFromLabel: rankFromLabel
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports.GuandanSuggest = global.GuandanSuggest;
  }
})(typeof window !== 'undefined' ? window : global);
