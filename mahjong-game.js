// 四人麻将的服务端牌局模型。
// 采用 136 张标准牌，支持摸牌、出牌、吃、碰、明杠、暗杠和基础牌型胡牌。
// 牌面 value 为 0-33：万 0-8、条 9-17、筒 18-26、风牌 27-30、三元牌 31-33。

const TILE_COUNT = 34;
const PLAYER_COUNT = 4;

function cloneCard(card) {
  return card ? { value: card.value, type: card.type || 0 } : null;
}

function sameTile(a, b) {
  return !!a && !!b && Number(a.value) === Number(b.value);
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = cards[i];
    cards[i] = cards[j];
    cards[j] = tmp;
  }
  return cards;
}

function makeDeck() {
  const deck = [];
  for (let value = 0; value < TILE_COUNT; value++) {
    for (let copy = 0; copy < 4; copy++) deck.push({ value, type: 0 });
  }
  return shuffle(deck);
}

function countsFor(cards) {
  const counts = Array(TILE_COUNT).fill(0);
  (cards || []).forEach(card => {
    if (card && Number.isInteger(Number(card.value)) && Number(card.value) >= 0 && Number(card.value) < TILE_COUNT) {
      counts[Number(card.value)]++;
    }
  });
  return counts;
}

function isSuit(value) {
  return value >= 0 && value < 27;
}

function canTakeSequence(value) {
  return isSuit(value) && value % 9 <= 6;
}

// 检查一组牌是否能拆成指定数量的顺子/刻子，并留出一对将。
function isStandardWinning(cards, meldCount) {
  const counts = countsFor(cards);
  const needMelds = Math.max(0, Number(meldCount) || 0);
  const total = cards.length + needMelds * 3;
  if (total !== 14) return false;

  function removeMelds(left, groups) {
    if (groups === 0) return left.every(n => n === 0);
    let first = -1;
    for (let i = 0; i < left.length; i++) {
      if (left[i]) { first = i; break; }
    }
    if (first < 0) return false;

    if (left[first] >= 3) {
      left[first] -= 3;
      if (removeMelds(left, groups - 1)) return true;
      left[first] += 3;
    }

    if (canTakeSequence(first) && left[first + 1] && left[first + 2]) {
      left[first]--;
      left[first + 1]--;
      left[first + 2]--;
      if (removeMelds(left, groups - 1)) return true;
      left[first]++;
      left[first + 1]++;
      left[first + 2]++;
    }
    return false;
  }

  for (let pair = 0; pair < counts.length; pair++) {
    if (counts[pair] < 2) continue;
    counts[pair] -= 2;
    if (removeMelds(counts, 4 - needMelds)) return true;
    counts[pair] += 2;
  }
  return false;
}

function isSevenPairs(cards) {
  if (cards.length !== 14) return false;
  const counts = countsFor(cards);
  return counts.every(n => n === 0 || n === 2);
}

function sortCards(cards) {
  return (cards || []).slice(0).sort((a, b) => Number(a.value) - Number(b.value));
}

function removeTiles(hand, cards) {
  const next = hand.slice(0);
  for (const wanted of cards || []) {
    const index = next.findIndex(card => sameTile(card, wanted));
    if (index < 0) return null;
    next.splice(index, 1);
  }
  return next;
}

function firstChiOption(hand, discard) {
  if (!discard || !canTakeSequence(Number(discard.value))) return null;
  const value = Number(discard.value);
  const counts = countsFor(hand);
  const starts = [value, value - 1, value - 2];
  for (const start of starts) {
    if (start < 0 || !canTakeSequence(start)) continue;
    const needed = [start, start + 1, start + 2].filter(v => v !== value);
    if (needed.every(v => counts[v] > 0)) {
      return needed.map(v => ({ value: v, type: 0 }));
    }
  }
  return null;
}

class MahjongGame {
  constructor() {
    this.init();
  }

  init() {
    this.status = 0;
    this.wall = [];
    this.hands = [[], [], [], []];
    this.discards = [[], [], [], []];
    this.melds = [[], [], [], []];
    this.currentPos = 0;
    this.currentAction = 'discard';
    this.pendingClaim = null;
    this.lastDiscard = null;
    this.result = null;
  }

  start() {
    this.init();
    const deck = makeDeck();
    for (let pos = 0; pos < PLAYER_COUNT; pos++) {
      this.hands[pos] = sortCards(deck.splice(0, 13));
    }
    // 庄家先摸一张，开局直接进入出牌阶段。
    this.hands[0].push(deck.shift());
    this.hands[0] = sortCards(this.hands[0]);
    this.wall = deck;
    this.status = 2;
    this.currentPos = 0;
    this.currentAction = 'discard';
    return this;
  }

  getStatus() {
    return this.status;
  }

  getContextPosId() {
    return this.currentPos;
  }

  getCurrentAction() {
    return this.currentAction;
  }

  getCardsByPosId(posId) {
    return this.hands[Number(posId)] || [];
  }

  getCards() {
    return this.hands.map((cards, id) => ({ id, cards: cards.map(cloneCard) }));
  }

  getHandCounts() {
    return this.hands.reduce((out, cards, id) => {
      out[id] = cards.length;
      return out;
    }, {});
  }

  getDiscards() {
    return this.discards.map(cards => cards.map(cloneCard));
  }

  getMelds() {
    return this.melds.map(groups => groups.map(group => ({
      type: group.type,
      cards: group.cards.map(cloneCard),
    })));
  }

  getWallCount() {
    return this.wall.length;
  }

  getLastDiscard() {
    return this.lastDiscard ? {
      posId: this.lastDiscard.posId,
      card: cloneCard(this.lastDiscard.card),
    } : null;
  }

  getPendingClaim() {
    return this.pendingClaim;
  }

  canHu(posId, extraCard) {
    const pos = Number(posId);
    const hand = this.getCardsByPosId(pos).slice(0);
    if (extraCard) hand.push(cloneCard(extraCard));
    const openMelds = this.melds[pos].length;
    return isStandardWinning(hand, openMelds) || (openMelds === 0 && isSevenPairs(hand));
  }

  getTurnOptions(posId) {
    const pos = Number(posId);
    if (this.status !== 2 || pos < 0 || pos >= PLAYER_COUNT) return [];
    if (this.pendingClaim) {
      if (!this.pendingClaim.eligible.includes(pos) || this.pendingClaim.responded[pos]) return [];
      const options = ['pass'];
      const hand = this.hands[pos];
      const tile = this.pendingClaim.card;
      if (this.canHu(pos, tile)) options.unshift('hu');
      const count = countsFor(hand)[tile.value] || 0;
      if (count >= 3) options.push('gang');
      else if (count >= 2) options.push('peng');
      if (pos === this.pendingClaim.nextPos && firstChiOption(hand, tile)) options.push('chi');
      return options;
    }
    if (pos !== this.currentPos) return [];
    const options = [];
    if (this.canHu(pos)) options.push('hu');
    const counts = countsFor(this.hands[pos]);
    if (counts.some(n => n === 4)) options.push('gang');
    return options;
  }

  getPublicState() {
    const claimOptions = {};
    for (let pos = 0; pos < PLAYER_COUNT; pos++) claimOptions[pos] = this.getTurnOptions(pos);
    return {
      ctxPos: this.currentPos,
      action: this.currentAction,
      wallCount: this.wall.length,
      handCounts: this.getHandCounts(),
      discards: this.getDiscards(),
      melds: this.getMelds(),
      lastDiscard: this.getLastDiscard(),
      claimOptions,
    };
  }

  drawNext() {
    if (!this.wall.length) {
      this.status = 3;
      this.result = { gameType: 'mahjong', winner: [], loser: [], score: 0, ratio: 1, draw: true };
      return { status: true, drawCard: null, result: this.result };
    }
    const card = this.wall.shift();
    this.hands[this.currentPos].push(card);
    this.hands[this.currentPos] = sortCards(this.hands[this.currentPos]);
    this.currentAction = 'discard';
    return { status: true, drawCard: cloneCard(card) };
  }

  finishWin(winner, loser, winType) {
    this.status = 3;
    this.result = {
      gameType: 'mahjong',
      winner: [Number(winner)],
      loser: loser == null ? [0, 1, 2, 3].filter(pos => pos !== Number(winner)) : [Number(loser)],
      score: 1,
      ratio: 1,
      winType: winType || '胡牌',
    };
    this.pendingClaim = null;
    return { status: true, result: this.result };
  }

  discard(posId, card) {
    const pos = Number(posId);
    if (this.status !== 2 || this.pendingClaim || pos !== this.currentPos || this.currentAction !== 'discard') {
      return { status: false, msg: '还没轮到你出牌' };
    }
    const hand = this.hands[pos];
    const index = hand.findIndex(item => sameTile(item, card));
    if (index < 0) return { status: false, msg: '这张牌不在手牌中' };
    const out = hand.splice(index, 1)[0];
    this.discards[pos].push(out);
    this.lastDiscard = { posId: pos, card: cloneCard(out) };
    const nextPos = (pos + 1) % PLAYER_COUNT;
    const eligible = [];
    for (let target = 0; target < PLAYER_COUNT; target++) {
      if (target === pos) continue;
      const options = this.getClaimOptions(target, out, nextPos);
      if (options.length) eligible.push(target);
    }
    this.pendingClaim = {
      card: cloneCard(out),
      discarder: pos,
      nextPos,
      eligible,
      responded: {},
    };
    this.currentAction = 'claim';
    if (!eligible.length) return Object.assign({ card: cloneCard(out) }, this.advanceAfterClaim());
    return { status: true, card: cloneCard(out), drawCard: null };
  }

  getClaimOptions(pos, card, nextPos) {
    const options = [];
    if (this.canHu(pos, card)) options.push('hu');
    const count = countsFor(this.hands[pos])[card.value] || 0;
    if (count >= 3) options.push('gang');
    else if (count >= 2) options.push('peng');
    if (Number(pos) === Number(nextPos) && firstChiOption(this.hands[pos], card)) options.push('chi');
    return options;
  }

  advanceAfterClaim() {
    if (!this.pendingClaim) return { status: false, msg: '没有待处理的弃牌' };
    const nextPos = this.pendingClaim.nextPos;
    this.pendingClaim = null;
    this.currentPos = nextPos;
    const result = this.drawNext();
    if (result.result) return result;
    return { status: true, drawCard: result.drawCard };
  }

  passClaim(posId) {
    const pos = Number(posId);
    if (!this.pendingClaim || !this.pendingClaim.eligible.includes(pos) || this.pendingClaim.responded[pos]) {
      return { status: false, msg: '当前没有可跳过的操作' };
    }
    this.pendingClaim.responded[pos] = true;
    const done = this.pendingClaim.eligible.every(target => this.pendingClaim.responded[target]);
    return done ? this.advanceAfterClaim() : { status: true, waiting: true };
  }

  claim(posId, action) {
    const pos = Number(posId);
    if (!this.pendingClaim || !this.pendingClaim.eligible.includes(pos) || this.pendingClaim.responded[pos]) {
      return { status: false, msg: '当前没有可操作的弃牌' };
    }
    const tile = this.pendingClaim.card;
    const allowed = this.getClaimOptions(pos, tile, this.pendingClaim.nextPos);
    if (action === 'hu') {
      if (!allowed.includes('hu')) return { status: false, msg: '当前不能胡牌' };
      return this.finishWin(pos, this.pendingClaim.discarder, '放铳');
    }
    if (!allowed.includes(action)) return { status: false, msg: '当前不能执行该操作' };

    let take = [];
    if (action === 'peng') take = [tile, tile];
    if (action === 'gang') take = [tile, tile, tile];
    if (action === 'chi') take = firstChiOption(this.hands[pos], tile) || [];
    const nextHand = removeTiles(this.hands[pos], take);
    if (!nextHand) return { status: false, msg: '手牌状态已变化，请重试' };
    this.hands[pos] = nextHand;
    this.melds[pos].push({ type: action, cards: sortCards(take.concat([tile])) });
    const claimedRiver = this.discards[this.pendingClaim.discarder];
    if (claimedRiver && claimedRiver.length && sameTile(claimedRiver[claimedRiver.length - 1], tile)) claimedRiver.pop();
    this.pendingClaim = null;
    this.lastDiscard = null;
    this.currentPos = pos;
    this.currentAction = 'discard';

    let drawCard = null;
    if (action === 'gang') {
      const draw = this.drawNext();
      drawCard = draw.drawCard || null;
      if (draw.result) return Object.assign({ meld: Object.assign({}, this.melds[pos][this.melds[pos].length - 1], { taken: take.map(cloneCard) }) }, draw);
    }
    return {
      status: true,
      meld: Object.assign({}, this.melds[pos][this.melds[pos].length - 1], { taken: take.map(cloneCard) }),
      drawCard,
    };
  }

  concealedGang(posId, card) {
    const pos = Number(posId);
    if (this.status !== 2 || this.pendingClaim || pos !== this.currentPos || this.currentAction !== 'discard') {
      return { status: false, msg: '当前不能暗杠' };
    }
    const counts = countsFor(this.hands[pos]);
    const value = card && Number(card.value);
    const target = Number.isInteger(value) && counts[value] === 4
      ? value
      : counts.findIndex(n => n === 4);
    if (target < 0) return { status: false, msg: '没有可暗杠的牌' };
    const take = this.hands[pos].filter(item => item.value === target).slice(0, 4);
    this.hands[pos] = removeTiles(this.hands[pos], take);
    this.melds[pos].push({ type: 'angang', cards: take.map(cloneCard) });
    const draw = this.drawNext();
    return {
      status: true,
      meld: Object.assign({}, this.melds[pos][this.melds[pos].length - 1], { taken: take.map(cloneCard) }),
      drawCard: draw.drawCard || null,
      result: draw.result,
    };
  }

  getResult() {
    return this.result;
  }
}

module.exports = MahjongGame;
