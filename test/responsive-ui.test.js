const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'static', 'css', 'style.css'), 'utf8');

assert.match(indexHtml, /<nav class="row text-right quick-bar"[^>]*aria-label="大厅功能"/, '大厅导航缺少语义化 nav');
assert.match(indexHtml, /<div class="quick-actions">[\s\S]*快速入局[\s\S]*<\/div>/, '移动端导航缺少可收缩操作区');
assert.match(indexHtml, /data\.byGame/, '统计面板未读取服务端实时分玩法数据');
assert.match(indexHtml, /Math\.max\(220, Math\.min\(900, \(window\.innerWidth \|\| 360\) - 20\)\)/, '历史弹窗宽度仍可能超出视口');
assert.match(indexHtml, /Math\.max\(180, Math\.min\(780, \(window\.innerHeight \|\| 480\) - 60\)\)/, '历史弹窗高度未按视口预留标题栏');
assert.match(css, /\.quick-actions\s*\{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)/, '移动端导航没有三列自适应布局');
assert.match(css, /\.layui-layer\.layui-layer-page\s*\{[\s\S]*max-width: calc\(100vw - 20px\)/, '弹窗缺少视口宽度上限');
assert.match(css, /\.layui-layer\.layui-layer-page \.layui-layer-content\s*\{[\s\S]*overflow-x: hidden/, '弹窗内容仍可能横向溢出');
assert.match(css, /button:focus-visible[\s\S]*outline: 2px solid/, '键盘焦点样式缺失');
assert.match(css, /prefers-reduced-motion: reduce/, '低动态偏好未处理');
console.log('Responsive UI tests passed: mobile navigation, modal bounds, live stats hook, focus, and reduced motion.');
