const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

assert(html.includes("ROOM_RESUME_STORAGE_KEY = 'cardroom_room_resume_v1'"), '前端缺少房间恢复存储键');
assert(html.includes("this.client.on('connect'"), '前端缺少 Socket.IO 重连监听');
assert(html.includes("this.client.on('disconnect'"), '前端缺少断线监听');
assert(html.includes("this.client.emit('RESUME_ROOM'"), '前端缺少恢复事件发送');
assert(html.includes("this.client.on('RESUME_ROOM_ERROR'"), '前端缺少恢复失败处理');
assert(html.includes('class="connection-banner"'), '前端缺少断线状态提示');
assert(html.includes('style.css?v=reconnect-live-20260901-1'), '前端 CSS 缓存版本未更新');

assert(server.includes("socket.on('RESUME_ROOM'"), '服务端缺少 RESUME_ROOM 事件');
assert(server.includes('rememberReconnectSlot'), '服务端缺少断线回归槽');
assert(server.includes('handleDisconnectedClient'), '服务端缺少统一断线处理');
assert(server.includes('IDENTITY_MISMATCH'), '服务端缺少回归身份校验');

console.log('Reconnect UI regression checks passed: storage, socket lifecycle, resume protocol, and cache busting are wired.');
