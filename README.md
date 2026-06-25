# 雀阁 · 纸牌房

> **Forked from** [laivv/doudizhu](https://github.com/laivv/doudizhu.git)

> 基于 Node.js + Vue 2 + Socket.IO 的多人在线纸牌房，支持 **动态开房 / 快速匹配 / 好友房号 / 斗地主 / 掼蛋 / 观战 / 国风音画**。


---

## 特性

- **动态房间** — 玩家可以开公开房、开私密房、输入房号加入好友房，也可以快速入局自动匹配空房。
- **多玩法架构** — 斗地主与掼蛋作为独立玩法接入，后续可继续扩展新的纸牌规则。
- **斗地主** — 三人叫分、底牌、地主/农民阵营、炸弹翻倍、春天结算、AI 陪玩与智囊推荐。
- **掼蛋** — 四人两副牌、对家组队、级牌升级、红桃级牌逢人配、炸弹/同花顺/四王炸、头游队伍升级结算。
- **AI 对手** — 斗地主房内一键「召唤 A I 对手」，自动填空座；真人加入时 AI 自动让座、全员退房时自动清场。
- **观战模式** — 不入座也能旁观对局，棋谱牌势一览无余。
- **智囊推荐** — 自己回合点「智 囊」即可由内置 AI 自动选出最经济的合法跟牌。
- **国风视效** — 玉绿背景、朱漆按钮、鎏金徽印；地主登场金光，农民登场玉色光晕；炸弹/王炸/飞机各自专属字幕特效。
- **Web Audio 音效** — 出牌、不出、叫分、炸弹皆有合成音色，可一键静音。
- **房间聊天** — 茶馆闲话面板，自由输入或下拉选「快语」短句。
- **移动端适配** — 大厅、开房、手牌、聊天和操作按钮针对手机竖屏做了响应式布局。
- **可选 SSO** — 内置 JWT 校验入口，便于与 Discuz 等论坛对接（参见 [discuz-sso/README.md](discuz-sso/README.md)）。

---

## 截图

<img width="1702" height="1255" alt="f2f1befc878f15cbbcc39238c5bf0546" src="https://github.com/user-attachments/assets/c0f47639-e6af-4997-acc0-a038c1d9f319" />
<img width="1700" height="1257" alt="e2384b186038c64b40103a9f2db9d653" src="https://github.com/user-attachments/assets/87b166c5-42a3-408c-bd00-d52e17a57634" />


---

## 快速开始

确保已安装 Node.js（建议 ≥ 18）。

```sh
git clone https://github.com/laivv/doudizhu.git
cd doudizhu
npm install
npm start
```

默认监听 **8002** 端口，浏览器访问：

```
http://localhost:8002
```

输入「雅号」后即可进入大厅：

- 选择「斗地主」或「掼蛋」后点「快速入局」。
- 点「开公开房」等待陌生玩家加入。
- 点「开私密房」后把房号发给朋友。
- 输入好友给你的房号可直接加入。

---

## 操作指南

### 自己回合的按钮顺序

```
[ 出 牌 ]   [ 智 囊 ]   [ 不 出 ]
   ↑ 朱漆      ↑ 墨色      ↑ 玉绿
```

- **出 牌**：将选中的牌打出（必须是合法牌型，且能压过上家）。
- **智 囊**：让 AI 自动帮你选牌；若无可压制的牌会提示「建议不出」。
- **不 出**：跳过本轮（仅当上家不是自己时可见）。

### 房间与等待区

- **准 备**：标记自己已就绪；三人全部就绪自动开局。
- **召 唤 A I 对 手**：斗地主房内有空座时显示，把所有空位填上 AI。
- **请 走 A I**：斗地主房内有 AI 时显示，清退所有 AI 等真人。
- **房号**：房间顶部显示，私密房可复制房号给好友加入。

### 叫分

听到「叫分」环节时，依次显示可叫分数（1/2/3）和「不叫」按钮，点击即可。

### 掼蛋

- 四人开局，两副牌，每人 27 张。
- 0/2 与 1/3 为固定对家。
- 当前级牌从 2 开始，红桃级牌为逢人配，可参与常规牌型组合。
- 支持单张、对子、三张、三带二、顺子、连对、钢板、炸弹、同花顺、四王炸。
- 头游队伍按名次升级：双下 +3，二三名 +2，其余 +1。

### AI 让座规则

- 真人入座时若该位被 AI 占用且未在游戏中 → AI **拱手让座**。
- 桌内最后一名真人离席 / 掉线 → 服务端自动清退该桌所有 AI 并重置牌局。
- 一局结束后，留在桌上的 AI **自动重新就绪**；若全员就绪则立即开下一局。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 服务端 | Node.js · Express · Socket.IO 4 · jsonwebtoken |
| 前端 | Vue 2（CDN 单文件）· jQuery · layer 弹层 |
| 通信 | WebSocket（事件：`CREATE_ROOM` / `JOIN_ROOM` / `QUICK_JOIN` / `SITDOWN` / `PREPARE` / `CALL_SCORE` / `PLAY_CARD` / `USER_MESSAGE` / `SPECTATE` / `ADD_BOTS` / `REMOVE_BOTS` …） |
| 音效 | 原生 Web Audio API（无第三方依赖） |
| 牌型校验 | `static/js/parser.js`（A / AA / AAA / AAAB / AAABB / ABCDE / AABBCC / AAABBB / AAAABC / AAAABBCC / AAAA / KING） |
| AI 决策 | `static/js/ai-suggest.js`（同时供前端「智囊」与服务端「机器人」使用） |

---

## 项目结构

```
quege-card-room/
├── server.js              # Express + Socket.IO 入口；含 AI 机器人调度
├── game.js                # 游戏状态机（发牌 / 叫分 / 出牌 / 胜负）
├── guandan-game.js        # 掼蛋状态机（两副牌 / 级牌 / 逢人配 / 升级）
├── core-ai.js             # 服务端 AI 辅助
├── core-validator.js      # 服务端牌型校验
├── package.json
├── discuz-sso/            # 可选：与 Discuz 论坛 SSO 对接示例
└── static/
    ├── index.html         # Vue SPA 单页
    ├── css/
    │   ├── base.css
    │   ├── style.css      # 国风主题样式
    │   └── theme.css
    ├── images/
    │   └── screenshots/   # 文档截图
    └── js/
        ├── parser.js      # 牌型识别
        ├── ai-suggest.js  # AI 选牌引擎（前后端共用）
        ├── effects.js     # 特效字幕 + Web Audio 音效
        ├── vue.min.js
        ├── jquery.min.js
        └── layer/         # layer 弹层组件
```

---

## 可选：Discuz SSO 对接

若要让论坛会员免登录进入游戏，可参考 [discuz-sso/README.md](discuz-sso/README.md)：论坛侧颁发 JWT，前端在 `?token=` 中带入，服务端 `io.use` 中间件校验通过后建立连接。

---

## License

MIT — 详见 LICENSE。

> 注：`static/images/` 内的扑克 / 桌面贴图素材来源于网络，**不在 MIT 许可范围内**，仅作演示用途；如商业使用请自行替换。
