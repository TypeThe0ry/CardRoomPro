/* =====================================================================
 * 雀阁 · AI 选牌建议（智囊）
 * 仅依赖 parser.js (validate)，不修改其他模块。
 * 全局对象：window.AISuggest
 *   AISuggest.suggest(myCards, lastInfo)
 *     myCards: [{value,type,selected?}, ...]
 *     lastInfo: { len, key, type, ctxPos } 上家最后牌信息；
 *               若 ctxPos === 'self' 或 lastInfo.len===0 则视为自由出牌。
 *     return:  [{value,type}, ...]   建议的牌列表（按需排序），空数组表示无可出。
 * 设计：
 *   - 自由出牌：取手中最小的合法单张/对/三不带。
 *   - 跟牌：枚举手中相同 type 且 key 更大的组合，选最经济的；不行再尝试炸弹/王炸。
 * ===================================================================== */
(function (global) {
  'use strict';

  function clone(arr) { return arr.slice(0); }
  function byValAsc(a, b) { return a.value - b.value; }

  // 把手牌按 value 分组
  function groupByValue(cards) {
    var g = {};
    cards.forEach(function (c) {
      if (!g[c.value]) g[c.value] = [];
      g[c.value].push(c);
    });
    return g;
  }

  // 选 n 张值为 v 的牌（不足返回 null）
  function pickN(group, v, n) {
    var arr = group[v];
    if (!arr || arr.length < n) return null;
    return arr.slice(0, n);
  }

  // 收集所有炸弹（4 张）和王炸
  function collectBombs(cards) {
    var g = groupByValue(cards);
    var out = [];
    Object.keys(g).forEach(function (v) {
      v = +v;
      if (g[v].length >= 4 && v < 16) {
        out.push({ key: v, cards: g[v].slice(0, 4), type: 'AAAA' });
      }
    });
    if (g[16] && g[17]) {
      out.push({ key: 16, cards: [g[16][0], g[17][0]], type: 'KING' });
    }
    out.sort(function (a, b) { return a.key - b.key; });
    return out;
  }

  // 自由出牌：尽量出最小的非关键牌（避免拆炸弹）
  function freePlay(cards) {
    var g = groupByValue(cards);
    var values = Object.keys(g).map(Number).sort(function (a, b) { return a - b; });
    // 优先：单张 (跳过会拆炸的)
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (g[v].length === 1 && v < 16) return [g[v][0]];
    }
    // 然后对子
    for (i = 0; i < values.length; i++) {
      v = values[i];
      if (g[v].length === 2) return g[v].slice(0, 2);
    }
    // 三张
    for (i = 0; i < values.length; i++) {
      v = values[i];
      if (g[v].length === 3) return g[v].slice(0, 3);
    }
    // 实在没办法（只剩炸弹/王炸）
    if (g[16] && g[17]) return [g[16][0], g[17][0]];
    for (i = 0; i < values.length; i++) {
      v = values[i];
      if (g[v].length >= 1) return [g[v][0]];
    }
    return [];
  }

  // 跟单
  function followSingle(cards, key) {
    var g = groupByValue(cards);
    var values = Object.keys(g).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v > key && g[v].length === 1 && v < 16) return [g[v][0]];
    }
    for (i = 0; i < values.length; i++) {
      v = values[i];
      if (v > key && g[v].length >= 1) return [g[v][0]];
    }
    return null;
  }

  // 跟对
  function followPair(cards, key) {
    var g = groupByValue(cards);
    var values = Object.keys(g).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v > key && g[v].length >= 2 && v < 16) return g[v].slice(0, 2);
    }
    return null;
  }

  // 跟三不带
  function followTriple(cards, key) {
    var g = groupByValue(cards);
    var values = Object.keys(g).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v > key && g[v].length >= 3 && v < 16) return g[v].slice(0, 3);
    }
    return null;
  }

  // 跟三带一
  function followTripleOne(cards, key) {
    var triple = followTriple(cards, key);
    if (!triple) return null;
    var rest = cards.filter(function (c) { return c.value !== triple[0].value; });
    rest.sort(byValAsc);
    if (!rest.length) return null;
    return triple.concat([rest[0]]);
  }

  // 跟三带二
  function followTriplePair(cards, key) {
    var triple = followTriple(cards, key);
    if (!triple) return null;
    var rest = cards.filter(function (c) { return c.value !== triple[0].value; });
    var g = groupByValue(rest);
    var values = Object.keys(g).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (g[v].length >= 2 && v < 16) return triple.concat(g[v].slice(0, 2));
    }
    return null;
  }

  // 跟顺子（指定长度）
  function followStraight(cards, key, len) {
    // 按值去重并排序
    var g = groupByValue(cards);
    var values = Object.keys(g).map(Number).filter(function (v) { return v < 15; }).sort(function (a, b) { return a - b; });
    // 找一个起始 v > key，其后连续 len 个值都存在
    for (var i = 0; i < values.length; i++) {
      var start = values[i];
      if (start <= key) continue;
      var ok = true;
      for (var k = 0; k < len; k++) {
        if (values.indexOf(start + k) === -1) { ok = false; break; }
      }
      if (ok) {
        var pick = [];
        for (var k2 = 0; k2 < len; k2++) {
          pick.push(g[start + k2][0]);
        }
        return pick;
      }
    }
    return null;
  }

  // 跟连对
  function followPairs(cards, key, len) {
    // len = 总张数（必为偶数），对数 = len/2
    var pairs = len / 2;
    var g = groupByValue(cards);
    var values = Object.keys(g).map(Number).filter(function (v) { return v < 15 && g[v].length >= 2; }).sort(function (a, b) { return a - b; });
    for (var i = 0; i < values.length; i++) {
      var start = values[i];
      if (start <= key) continue;
      var ok = true;
      for (var k = 0; k < pairs; k++) {
        if (values.indexOf(start + k) === -1) { ok = false; break; }
      }
      if (ok) {
        var pick = [];
        for (var k2 = 0; k2 < pairs; k2++) {
          pick = pick.concat(g[start + k2].slice(0, 2));
        }
        return pick;
      }
    }
    return null;
  }

  // 跟飞机不带
  function followPlane(cards, key, len) {
    var triples = len / 3;
    var g = groupByValue(cards);
    var values = Object.keys(g).map(Number).filter(function (v) { return v < 15 && g[v].length >= 3; }).sort(function (a, b) { return a - b; });
    for (var i = 0; i < values.length; i++) {
      var start = values[i];
      if (start <= key) continue;
      var ok = true;
      for (var k = 0; k < triples; k++) {
        if (values.indexOf(start + k) === -1) { ok = false; break; }
      }
      if (ok) {
        var pick = [];
        for (var k2 = 0; k2 < triples; k2++) {
          pick = pick.concat(g[start + k2].slice(0, 3));
        }
        return pick;
      }
    }
    return null;
  }

  // 用炸弹/王炸压制
  function followBomb(cards, lastType, lastKey) {
    var bombs = collectBombs(cards);
    for (var i = 0; i < bombs.length; i++) {
      var b = bombs[i];
      if (lastType === 'AAAA') {
        if (b.type === 'AAAA' && b.key > lastKey) return b.cards;
        if (b.type === 'KING') return b.cards;
      } else if (lastType === 'KING') {
        // 无敌
        return null;
      } else {
        return b.cards;
      }
    }
    return null;
  }

  function suggest(myCards, lastInfo) {
    if (!myCards || !myCards.length) return [];
    var hand = myCards.map(function (c) { return { value: c.value, type: c.type }; });
    hand.sort(byValAsc);

    var freeMode = !lastInfo || !lastInfo.len || lastInfo.ctxPos === 'self';
    if (freeMode) {
      return freePlay(hand);
    }

    var t = lastInfo.type;
    var key = lastInfo.key;
    var len = lastInfo.len;
    var pick = null;

    switch (t) {
      case 'A':       pick = followSingle(hand, key); break;
      case 'AA':      pick = followPair(hand, key); break;
      case 'AAA':     pick = followTriple(hand, key); break;
      case 'AAAB':    pick = followTripleOne(hand, key); break;
      case 'AAABB':   pick = followTriplePair(hand, key); break;
      case 'ABCDE':   pick = followStraight(hand, key, len); break;
      case 'AABBCC':  pick = followPairs(hand, key, len); break;
      case 'AAABBB':  pick = followPlane(hand, key, len); break;
      case 'AAAA':    pick = followBomb(hand, 'AAAA', key); break;
      case 'KING':    pick = null; break;
      default:        pick = null;
    }

    if (!pick) {
      pick = followBomb(hand, t, key);
    }
    return pick || [];
  }

  global.AISuggest = { suggest: suggest };
})(typeof window !== 'undefined' ? window : this);
