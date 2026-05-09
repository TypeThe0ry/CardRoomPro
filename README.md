# 雀阁 · 在线斗地主

> **Forked from** [laivv/doudizhu](https://github.com/laivv/doudizhu.git)

> **Fight the Landlord** — 一桌国风茶馆，三人对坐，落子如雀。
> 基于 Node.js + Vue 2 + Socket.IO 的多人在线斗地主，支持 **真人对战 / AI 陪玩 / 观战 / 智囊推荐 / 国风音画**。

![雀阁 · 入座](static/images/screenshots/login.png)

---

## 特性

- **多桌多人** — 大厅可见所有牌桌，随时入座或离席；同一桌三人到齐自动开局。
- **AI 对手** — 桌内一键「召唤 A I 对手」，自动填空座；真人加入时 AI 自动让座、全员退桌时自动清场。AI 引擎覆盖单/对/三带/顺子/连对/飞机（带单/带对）/4 带 2/炸弹/王炸的完整跟出策略。
- **观战模式** — 不入座也能旁观对局，棋谱牌势一览无余。
- **智囊推荐** — 自己回合点「智 囊」即可由内置 AI 自动选出最经济的合法跟牌。
- **国风视效** — 玉绿背景、朱漆按钮、鎏金徽印；地主登场金光，农民登场玉色光晕；炸弹/王炸/飞机各自专属字幕特效。
- **Web Audio 音效** — 出牌、不出、叫分、炸弹皆有合成音色，可一键静音。
- **桌面聊天** — 茶馆闲话面板，自由输入或下拉选「快语」短句。
- **可选 SSO** — 内置 JWT 校验入口，便于与 Discuz 等论坛对接（参见 [discuz-sso/README.md](discuz-sso/README.md)）。

---

## 截图

| 入座厅 | 牌桌 |
| :---: | :---: |
| ![登录](static/images/screenshots/login.png) | ![对局](static/images/screenshots/room.png) |

> 截图存放于 `static/images/screenshots/`。如需更新，把新图覆盖同名文件即可。

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

输入「雅号」后即可进入大厅 → 选桌入座 → 点「准备」或「召唤 A I 对手」开始对局。

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

### 等待区按钮

- **准 备**：标记自己已就绪；三人全部就绪自动开局。
- **召 唤 A I 对 手**：当桌内有空座时显示，把所有空位填上 AI。
- **请 走 A I**：当桌内有 AI 时显示，清退所有 AI 等真人。

### 叫分

听到「叫分」环节时，依次显示可叫分数（1/2/3）和「不叫」按钮，点击即可。

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
| 通信 | WebSocket（事件：`SITDOWN` / `PREPARE` / `CALL_SCORE` / `PLAY_CARD` / `USER_MESSAGE` / `SPECTATE` / `ADD_BOTS` / `REMOVE_BOTS` …） |
| 音效 | 原生 Web Audio API（无第三方依赖） |
| 牌型校验 | `static/js/parser.js`（A / AA / AAA / AAAB / AAABB / ABCDE / AABBCC / AAABBB / AAAABC / AAAABBCC / AAAA / KING） |
| AI 决策 | `static/js/ai-suggest.js`（同时供前端「智囊」与服务端「机器人」使用） |

---

## 项目结构

```
fight-the-landlord/
├── server.js              # Express + Socket.IO 入口；含 AI 机器人调度
├── game.js                # 游戏状态机（发牌 / 叫分 / 出牌 / 胜负）
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
