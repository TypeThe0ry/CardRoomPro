const assert = require('assert');
const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(__dirname, '..', 'static', 'css', 'style.css'), 'utf8');

// 观战只读座位：斗地主/掼蛋的底部玩家不能因为隐藏手牌而被一起隐藏。
assert.match(
  indexHtml,
  /class="player-wrapper player-self-ctx"[^>]*v-if="roomState\.state > 0 &&/,
  'spectator card-game seat must render during an active round'
);
assert.match(indexHtml, /:class="\{'spectator-self': isSpec\}"/, 'card-game spectator seat marker is missing');

// 麻将观战必须有第四个可视座位，但仍只渲染牌背和公开副露，不泄露手牌。
assert.match(indexHtml, /class="mahjong-seat mahjong-seat-bottom"[^>]*v-if="isSpec && posState\.self\.state"/, 'mahjong spectator bottom seat is missing');
assert.match(indexHtml, /mahjongBackCount\('self'\)/, 'mahjong spectator bottom seat must use concealed tile backs');
assert.match(indexHtml, /mahjong\.melds\.self/, 'mahjong spectator bottom seat must render public melds');
assert.match(styleCss, /\.room-spec \.player-self-ctx\s*\{[\s\S]*?display:\s*block/, 'spectator card-game seat is still hidden by CSS');
assert.match(styleCss, /\.mahjong-seat-bottom\s*\{/, 'mahjong spectator bottom-seat CSS is missing');

console.log('spectator UI regression checks passed');
