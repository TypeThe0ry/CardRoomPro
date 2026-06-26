const HEART_TYPE = 2;
const SEQUENCE_ORDER = [14, 15, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function randomIndex(max) {
  return Math.floor(Math.random() * (max + 1));
}

function nextPos(posId) {
  return (Number(posId) + 1) % 4;
}

function makeDeck() {
  const cards = [];
  for (let deck = 0; deck < 2; deck++) {
    for (let value = 3; value <= 15; value++) {
      for (let type = 0; type < 4; type++) {
        cards.push({ value, type, deck });
      }
    }
    cards.push({ value: 16, type: 0, deck });
    cards.push({ value: 17, type: 0, deck });
  }
  return cards;
}

function cardKey(card) {
  return [card.value, card.type, card.deck == null ? 0 : card.deck].join('_');
}

function sortCards(cards) {
  return cards.sort((a, b) => {
    if (a.value !== b.value) return a.value - b.value;
    if (a.type !== b.type) return a.type - b.type;
    return (a.deck || 0) - (b.deck || 0);
  });
}

function labelValue(value) {
  if (value === 11) return 'J';
  if (value === 12) return 'Q';
  if (value === 13) return 'K';
  if (value === 14) return 'A';
  if (value === 15) return '2';
  return String(value);
}

function isWild(card, levelRank) {
  return card.value === levelRank && card.type === HEART_TYPE;
}

function countValues(cards) {
  const counts = {};
  cards.forEach(card => {
    counts[card.value] = (counts[card.value] || 0) + 1;
  });
  return counts;
}

function sameSuit(cards) {
  if (!cards.length) return false;
  return cards.every(card => card.type === cards[0].type && card.value < 16);
}

function canBuildSameKind(cards, wildCount, size) {
  const normals = cards.filter(c => !c.__wild);
  const counts = countValues(normals);
  const values = Object.keys(counts).map(Number).filter(v => v < 16);
  if (!values.length) {
    return { ok: wildCount >= size, key: 0 };
  }
  if (values.length !== 1) return { ok: false };
  const v = values[0];
  return { ok: counts[v] + wildCount >= size, key: v };
}

function canBuildUnitSequence(cards, wildCount, unitSize, unitCount) {
  const normals = cards.filter(c => !c.__wild);
  const counts = countValues(normals);
  const values = Object.keys(counts).map(Number);
  if (normals.some(c => c.value >= 16)) return { ok: false };
  if (values.some(v => counts[v] > unitSize)) return { ok: false };
  for (let start = 0; start <= SEQUENCE_ORDER.length - unitCount; start++) {
    const seq = SEQUENCE_ORDER.slice(start, start + unitCount);
    let need = 0;
    seq.forEach(v => { need += Math.max(0, unitSize - (counts[v] || 0)); });
    if (need <= wildCount && values.every(v => seq.includes(v))) {
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
  const cloned = cards.map(c => Object.assign({}, c, { __wild: isWild(c, levelRank) }));
  const wildCount = cloned.filter(c => c.__wild).length;
  const normals = cloned.filter(c => !c.__wild);
  const len = cloned.length;
  const values = normals.map(c => c.value);
  const counts = countValues(normals);
  const countVals = Object.keys(counts).map(Number);

  if (!len) return { status: false };

  const jokers = cloned.filter(c => c.value >= 16);
  if (len === 4 && jokers.length === 4) {
    return { status: true, len, key: 99, type: 'JOKER_BOMB', bomb: true, bombPower: 100 };
  }

  const sameKind = canBuildSameKind(cloned, wildCount, len);
  if (len >= 4 && sameKind.ok) {
    return { status: true, len, key: sameKind.key, type: 'BOMB', bomb: true, bombPower: len };
  }

  if (len === 5 && sameSuit(normals)) {
    const straight = canBuildStraight(cloned, wildCount, 5);
    if (straight.ok) {
      return { status: true, len, key: straight.key, type: 'STRAIGHT_FLUSH', bomb: true, bombPower: 5.5 };
    }
  }

  if (len === 1) return { status: true, len, key: cloned[0].value, type: 'SINGLE' };

  if (len === 2) {
    const pair = canBuildSameKind(cloned, wildCount, 2);
    if (pair.ok) return { status: true, len, key: pair.key, type: 'PAIR' };
  }

  if (len === 3) {
    const triple = canBuildSameKind(cloned, wildCount, 3);
    if (triple.ok) return { status: true, len, key: triple.key, type: 'TRIPLE' };
  }

  if (len === 5) {
    const straight = canBuildStraight(cloned, wildCount, 5);
    if (straight.ok) return { status: true, len, key: straight.key, type: 'STRAIGHT' };

    for (let tripleValue = 3; tripleValue <= 15; tripleValue++) {
      const tripleNeed = Math.max(0, 3 - (counts[tripleValue] || 0));
      if (tripleNeed > wildCount) continue;
      const leftWild = wildCount - tripleNeed;
      const rest = normals.filter(c => c.value !== tripleValue);
      const restCounts = countValues(rest);
      const pairValue = Object.keys(restCounts).map(Number).find(v => restCounts[v] + leftWild >= 2);
      if (pairValue || (rest.length === 0 && leftWild >= 2)) {
        return { status: true, len, key: tripleValue, type: 'FULL_HOUSE' };
      }
    }
  }

  if (len === 6) {
    const pairs = canBuildPairsSequence(cloned, wildCount, 3);
    if (pairs.ok) return { status: true, len, key: pairs.key, type: 'PAIRS_SEQ' };
  }

  if (len === 6) {
    const triples = canBuildTriplesSequence(cloned, wildCount, 2);
    if (triples.ok) return { status: true, len, key: triples.key, type: 'TRIPLES_SEQ' };
  }

  if (countVals.length === 1 && values.length + wildCount === len && len < 4) {
    return { status: true, len, key: countVals[0], type: len === 2 ? 'PAIR' : 'TRIPLE' };
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

function GuandanGame(options) {
  options = options || {};
  this.levelRank = options.levelRank || 15;
  this.init();
}

Object.assign(GuandanGame.prototype, {
  init() {
    this.contextCards = [];
    this.status = 0;
    this.contextPosId = 0;
    this.lastCardInfo = { posId: '', len: 0, key: '', type: '', bomb: false, bombPower: 0 };
    this.passCount = 0;
    this.finishOrder = [];
    this.finished = {};
    return this;
  },
  start() {
    this.status = 2;
    this.passCount = 0;
    this.finishOrder = [];
    this.finished = {};
    this.contextPosId = randomIndex(3);
    this.initCards();
    return this;
  },
  initCards() {
    const source = makeDeck();
    const groups = [0, 1, 2, 3].map(id => ({ id, cards: [] }));
    let maxIndex = source.length - 1;
    for (let pos = 0; pos < 4; pos++) {
      for (let j = 0; j < 27; j++) {
        const offset = randomIndex(maxIndex);
        groups[pos].cards.push(source[offset]);
        source.splice(offset, 1);
        maxIndex--;
      }
      sortCards(groups[pos].cards);
    }
    this.contextCards = groups;
    return groups;
  },
  getStatus() {
    return this.status;
  },
  getContextPosId() {
    return this.contextPosId;
  },
  getCards() {
    return this.contextCards;
  },
  getCardsByPosId(posId) {
    const group = this.contextCards.find(item => item.id === Number(posId));
    return group ? group.cards : null;
  },
  getLevelLabel() {
    return labelValue(this.levelRank);
  },
  checkExist(cards, posId) {
    const hand = (this.getCardsByPosId(posId) || []).slice(0);
    const used = new Set();
    for (let i = 0; i < cards.length; i++) {
      let found = -1;
      for (let j = 0; j < hand.length; j++) {
        if (used.has(j)) continue;
        if (cardKey(hand[j]) === cardKey(cards[i])) {
          found = j;
          break;
        }
      }
      if (found < 0) return false;
      used.add(found);
    }
    return true;
  },
  removeCards(cards, posId) {
    const hand = this.getCardsByPosId(posId);
    cards.forEach(card => {
      const idx = hand.findIndex(curr => cardKey(curr) === cardKey(card));
      if (idx >= 0) hand.splice(idx, 1);
    });
  },
  validate(posId, cards) {
    if (!cards || !cards.length) {
      const canPass = this.lastCardInfo.len > 0 && this.lastCardInfo.posId !== posId;
      return { status: !!canPass, key: '', type: '', len: 0 };
    }
    if (!this.checkExist(cards, posId)) return { status: false };
    const ret = analyze(cards, this.levelRank);
    if (!ret.status) return ret;
    if (!canBeat(ret, this.lastCardInfo)) return { status: false };
    return ret;
  },
  nextActive(fromPos) {
    let p = nextPos(fromPos);
    for (let i = 0; i < 4; i++) {
      if (!this.finished[p]) return p;
      p = nextPos(p);
    }
    return p;
  },
  next(posId, cards) {
    posId = Number(posId);
    if (posId !== this.contextPosId || this.finished[posId]) {
      this.status = 5;
      return this;
    }
    const isPass = !cards || !cards.length;
    if (isPass) {
      const validPass = this.lastCardInfo.len > 0 && this.lastCardInfo.posId !== posId;
      if (!validPass) {
        this.status = 5;
        return this;
      }
      this.passCount++;
      const activePlayers = 4 - this.finishOrder.length;
      if (this.passCount >= activePlayers - 1) {
        const leader = Number(this.lastCardInfo.posId);
        const nextLeader = this.finished[leader] ? this.nextActive(leader) : leader;
        this.lastCardInfo = { posId: nextLeader, len: 0, key: '', type: '', bomb: false, bombPower: 0 };
        this.passCount = 0;
        this.contextPosId = Number(nextLeader);
      } else {
        this.contextPosId = this.nextActive(posId);
      }
      return this;
    }
    const ret = this.validate(posId, cards);
    if (!ret.status) {
      this.status = 5;
      return this;
    }
    this.removeCards(cards, posId);
    this.lastCardInfo = {
      posId,
      len: ret.len,
      key: ret.key,
      type: ret.type,
      bomb: !!ret.bomb,
      bombPower: ret.bombPower || 0
    };
    this.passCount = 0;
    if (!this.getCardsByPosId(posId).length && !this.finished[posId]) {
      this.finished[posId] = true;
      this.finishOrder.push(posId);
    }
    if (this.isGameOver()) {
      this.status = 3;
      return this;
    }
    this.contextPosId = this.nextActive(posId);
    return this;
  },
  isGameOver() {
    if (this.finishOrder.length < 2) return false;
    const firstTeam = this.finishOrder[0] % 2;
    return this.finishOrder.filter(pos => pos % 2 === firstTeam).length === 2;
  },
  getResult() {
    const first = this.finishOrder[0];
    const winnerTeam = first % 2;
    const winner = [winnerTeam, winnerTeam + 2].sort((a, b) => a - b);
    const loser = [1 - winnerTeam, 3 - winnerTeam].sort((a, b) => a - b);
    const second = this.finishOrder[1];
    let rankDelta = 1;
    if (winner.includes(second)) rankDelta = 3;
    else if (this.finishOrder[2] != null && winner.includes(this.finishOrder[2])) rankDelta = 2;
    return {
      gameType: 'guandan',
      winner,
      loser,
      finishOrder: this.finishOrder.slice(0),
      rankDelta,
      levelRank: this.levelRank,
      levelLabel: this.getLevelLabel()
    };
  }
});

module.exports = GuandanGame;
