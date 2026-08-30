'use strict';

const SmartAI = require('./static/js/smart-ai').SmartAI;
const GuandanSuggest = require('./static/js/guandan-suggest').GuandanSuggest;

const AI_DIFFICULTIES = Object.freeze({
  easy: Object.freeze({ label: '简单', minDelay: 1500, variance: 900 }),
  normal: Object.freeze({ label: '标准', minDelay: 850, variance: 850 }),
  hard: Object.freeze({ label: '困难', minDelay: 500, variance: 600 }),
});

function normalizeAiDifficulty(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (normalized === 'easy' || normalized === 'low' || normalized === '1' || normalized === '简单') return 'easy';
  if (normalized === 'hard' || normalized === 'high' || normalized === '3' || normalized === '困难') return 'hard';
  return 'normal';
}

function aiDifficultyLabel(value) {
  return AI_DIFFICULTIES[normalizeAiDifficulty(value)].label;
}

function reactionDelay(value) {
  const profile = AI_DIFFICULTIES[normalizeAiDifficulty(value)];
  return profile.minDelay + Math.floor(Math.random() * profile.variance);
}

function cloneCards(cards) {
  return (cards || []).map(card => ({
    value: Number(card.value),
    type: Number(card.type) || 0,
    ...(card.deck == null ? {} : { deck: Number(card.deck) }),
  }));
}

function doudizhuCanBeat(candidate, last) {
  if (!last.len) return true;
  const current = candidate && candidate.ret;
  if (!current) return false;
  if (current.type === 'KING') return last.type !== 'KING';
  if (last.type === 'KING') return false;
  if (current.type === 'AAAA') return last.type !== 'AAAA' || Number(current.key) > Number(last.key);
  if (last.type === 'AAAA') return false;
  return current.type === last.type && Number(current.len) === Number(last.len) && Number(current.key) > Number(last.key);
}

function normalizedDoudizhuLast(lastInfo) {
  return lastInfo && Number(lastInfo.len) ? {
    len: Number(lastInfo.len),
    key: Number(lastInfo.key) || 0,
    type: lastInfo.type || '',
  } : { len: 0, key: 0, type: '' };
}

// 简单档故意使用“最小合法牌型”策略，只保留基本规则意识，不做牌力评估和残局协作。
function easyDoudizhu(hand, lastInfo, options) {
  const cards = (hand || []).slice(0);
  if (!cards.length) return [];
  const last = normalizedDoudizhuLast(lastInfo);
  const leadMode = !last.len || (lastInfo && lastInfo.ctxPos === 'self');
  let candidates = SmartAI.doudizhu.enumerate(cards).filter(candidate => leadMode || doudizhuCanBeat(candidate, last));
  if (!candidates.length) return [];

  if (!leadMode && options && options.lastIsPartner) {
    const finishers = candidates.filter(candidate => candidate.cards.length === cards.length);
    if (!finishers.length) return [];
    candidates = finishers;
  }

  candidates.sort((a, b) => {
    const bombA = a.ret && a.ret.bomb ? 1 : 0;
    const bombB = b.ret && b.ret.bomb ? 1 : 0;
    if (bombA !== bombB) return bombA - bombB;
    if (a.cards.length !== b.cards.length) return a.cards.length - b.cards.length;
    return Number(a.ret.key || 0) - Number(b.ret.key || 0);
  });
  return cloneCards(candidates[0].cards);
}

function doudizhuSuggest(hand, lastInfo, options) {
  options = Object.assign({}, options || {});
  options.difficulty = normalizeAiDifficulty(options.difficulty);
  if (options.difficulty === 'easy') return easyDoudizhu(hand, lastInfo, options);
  return cloneCards(SmartAI.doudizhu.suggest(hand, lastInfo, options));
}

function chooseAvailableScore(availableScores, wanted) {
  const available = (availableScores || []).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  for (let i = 0; i < available.length; i++) {
    if (available[i] <= wanted) return available[i];
  }
  return 0;
}

function doudizhuBid(hand, availableScores, difficulty) {
  const level = normalizeAiDifficulty(difficulty);
  const base = SmartAI.doudizhu.recommendBid(hand, availableScores);
  if (level === 'normal') return base;

  const power = Number(base.power) || 0;
  // 简单档保守叫分；困难档更重视牌力和抢地主机会。
  const wanted = level === 'easy'
    ? (power >= 18 ? 1 : 0)
    : (power >= 20 ? 3 : (power >= 14 ? 2 : (power >= 8 ? 1 : 0)));
  return Object.assign({}, base, {
    score: chooseAvailableScore(availableScores, wanted),
    reason: (level === 'easy' ? '保守叫分' : '按牌力积极叫分') + '，牌力 ' + power,
  });
}

function normalizedGuandanLast(lastInfo) {
  return lastInfo && Number(lastInfo.len) ? {
    len: Number(lastInfo.len),
    key: Number(lastInfo.key) || 0,
    type: lastInfo.type || '',
    bomb: !!lastInfo.bomb || ['BOMB', 'STRAIGHT_FLUSH', 'JOKER_BOMB'].indexOf(lastInfo.type) > -1,
    bombPower: Number(lastInfo.bombPower) || (lastInfo.type === 'JOKER_BOMB' ? 100 : (lastInfo.type === 'STRAIGHT_FLUSH' ? 5.5 : (lastInfo.type === 'BOMB' ? Number(lastInfo.len) : 0))),
  } : { len: 0 };
}

// 掼蛋简单档同样只找最小合法牌，队友控牌时不会主动争牌，除非可以直接走完。
function easyGuandan(hand, lastInfo, options) {
  const cards = (hand || []).slice(0);
  if (!cards.length) return [];
  const levelRank = Number(options && options.levelRank) || GuandanSuggest.rankFromLabel(options && options.levelLabel);
  const last = normalizedGuandanLast(lastInfo);
  const leadMode = !last.len || (lastInfo && lastInfo.ctxPos === 'self');
  let candidates = GuandanSuggest.enumerate(cards, levelRank).filter(candidate => leadMode || GuandanSuggest.canBeat(candidate.ret, last));
  if (!candidates.length) return [];

  if (!leadMode && options && options.lastIsPartner) {
    const finishers = candidates.filter(candidate => candidate.cards.length === cards.length);
    if (!finishers.length) return [];
    candidates = finishers;
  }

  candidates.sort((a, b) => {
    const bombA = a.ret && a.ret.bomb ? 1 : 0;
    const bombB = b.ret && b.ret.bomb ? 1 : 0;
    if (bombA !== bombB) return bombA - bombB;
    if (a.cards.length !== b.cards.length) return a.cards.length - b.cards.length;
    return Number(a.ret.key || 0) - Number(b.ret.key || 0);
  });
  return cloneCards(candidates[0].cards);
}

function guandanSuggest(hand, lastInfo, options) {
  options = Object.assign({}, options || {});
  options.difficulty = normalizeAiDifficulty(options.difficulty);
  if (options.difficulty === 'easy') return easyGuandan(hand, lastInfo, options);
  return cloneCards(SmartAI.guandan.suggest(hand, lastInfo, options));
}

module.exports = {
  AI_DIFFICULTIES,
  normalizeAiDifficulty,
  aiDifficultyLabel,
  reactionDelay,
  doudizhuSuggest,
  doudizhuBid,
  guandanSuggest,
};
