# Discuz SSO 集成指南

本目录提供 Discuz 与“雀阁 · 纸牌房”的 JWT 单点登录示例。接入后，Discuz 已登录用户可以免手动起名进入游戏，游戏服务器会识别用户 `uid`、用户名和头像，并把斗地主 / 掼蛋战绩分别写入数据库。

## 目录内容

```text
discuz-sso/
├── bridge.php     # 推荐入口：检查 Discuz 登录态，签发 JWT 并跳回游戏
├── health.php     # SSO secret 健康检查
├── sso.php        # 旧式 cookie 集成辅助函数
└── README.md      # 本文档
```

推荐使用 `bridge.php`。它会在用户已登录 Discuz 时生成 JWT，并通过 URL hash 返回游戏：

```text
https://game.example.com/#token=<JWT>
```

游戏前端读取 token 后通过 Socket.IO `auth.token` 发给 Node 服务端校验。

## 前提

- 已有可运行的 Discuz 站点。
- Discuz 站点已安装 PHP JWT 依赖。
- 游戏服务端和 Discuz 端使用同一个强随机 JWT 密钥。
- 游戏服务端可访问用于保存积分的 MySQL 数据库。
- 生产环境建议全程 HTTPS。

## 安装 PHP JWT 依赖

在 Discuz 站点根目录执行：

```bash
cd /path/to/discuz
composer require firebase/php-jwt
```

如果无法使用 Composer，也可以把 `firebase/php-jwt` 的 `src/` 文件放到 Discuz 或本目录下；`bridge.php` 已包含常见路径的兜底加载逻辑。

## 放置文件

把本目录复制到 Discuz 站点根目录：

```text
/path/to/discuz/discuz-sso/bridge.php
/path/to/discuz/discuz-sso/health.php
/path/to/discuz/discuz-sso/sso.php
```

## 配置 JWT Secret

Discuz 端和 Node 游戏端必须使用完全一致的密钥。

推荐在 Discuz 的 `config/config_global.php` 中增加：

```php
define('DISCUZ_SSO_SECRET', 'replace-with-a-strong-random-secret');
```

Node 端可以通过环境变量或 `config.json` 配置：

```bash
export JWT_SECRET='replace-with-a-strong-random-secret'
```

也可以在项目根目录创建 `sso-secret.txt`，但生产环境更推荐环境变量或受控配置文件。

## 配置游戏端登录入口

前端默认使用：

```text
https://zwwx.club/discuz-sso/bridge.php
```

如果你的论坛域名不同，修改 `static/index.html` 中的：

```js
discuzLoginUrl: 'https://your-discuz-domain/discuz-sso/bridge.php'
```

用户点击“使用 ZWWX.CLUB 账号登录”后，会跳转到该入口。`bridge.php` 会在登录成功后跳回当前游戏域名。

## 健康检查

Discuz 端：

```text
https://forum.example.com/discuz-sso/health.php
```

游戏端：

```text
https://game.example.com/api/sso/health
```

两个接口都会返回密钥指纹。指纹一致，说明两边使用的是同一个 secret。接口不会泄露明文密钥。

## 数据库积分持久化

游戏服务启动时会自动创建两张表：

```text
<DB_TABLE_PREFIX>doudizhu_score
<DB_TABLE_PREFIX>guandan_score
```

例如默认前缀 `pre_`：

```text
pre_doudizhu_score
pre_guandan_score
```

两张表结构相同：

| 字段 | 说明 |
| --- | --- |
| `uid` | Discuz 用户 uid，主键 |
| `username` | 最近一次记录的用户名 |
| `score` | 当前玩法累计积分 |
| `games` | 当前玩法总局数 |
| `wins` / `losses` | 胜 / 负局数 |
| `landlord_games` | 斗地主地主局数；掼蛋中保留但通常为 0 |
| `landlord_wins` | 斗地主地主胜局数；掼蛋中保留但通常为 0 |
| `updated_at` | 最近更新时间戳 |

## Node 端数据库配置

可以使用环境变量：

```bash
export DB_HOST=127.0.0.1
export DB_PORT=3306
export DB_USER=discuz
export DB_PASSWORD='replace-with-password'
export DB_NAME=discuz
export DB_TABLE_PREFIX=pre_
export SCORE_BASE=1
node server.js
```

也可以复制根目录 `config.example.json` 为 `config.json`：

```json
{
  "PORT": 8002,
  "JWT_SECRET": "与论坛 DISCUZ_SSO_SECRET 完全一致的字符串",
  "DB_HOST": "127.0.0.1",
  "DB_PORT": 3306,
  "DB_USER": "discuz",
  "DB_PASSWORD": "数据库密码",
  "DB_NAME": "discuz",
  "DB_TABLE_PREFIX": "pre_",
  "DB_DISABLE": 0,
  "SCORE_BASE": 1
}
```

`config.json` 已加入 `.gitignore`，不要提交。

## 最小数据库权限

如果允许游戏服务自动建表：

```sql
GRANT SELECT, INSERT, UPDATE, CREATE
ON `discuz`.`pre_doudizhu_score`
TO 'discuz_game'@'localhost';

GRANT SELECT, INSERT, UPDATE, CREATE
ON `discuz`.`pre_guandan_score`
TO 'discuz_game'@'localhost';

FLUSH PRIVILEGES;
```

如果生产环境不允许自动建表，可以先手动建表，再去掉 `CREATE` 权限。

## 手动建表 SQL

```sql
CREATE TABLE IF NOT EXISTS `pre_doudizhu_score` (
  `uid` INT UNSIGNED NOT NULL PRIMARY KEY,
  `username` VARCHAR(64) NOT NULL DEFAULT '',
  `score` INT NOT NULL DEFAULT 0,
  `games` INT UNSIGNED NOT NULL DEFAULT 0,
  `wins` INT UNSIGNED NOT NULL DEFAULT 0,
  `losses` INT UNSIGNED NOT NULL DEFAULT 0,
  `landlord_games` INT UNSIGNED NOT NULL DEFAULT 0,
  `landlord_wins` INT UNSIGNED NOT NULL DEFAULT 0,
  `updated_at` INT UNSIGNED NOT NULL DEFAULT 0,
  KEY `idx_score` (`score`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `pre_guandan_score` LIKE `pre_doudizhu_score`;
```

## 计分规则

只有通过 JWT 登录的真人玩家会记录积分。游客、AI、观战用户不计分。

斗地主：

```text
base = 叫分 × 倍率 × SCORE_BASE
地主胜：地主 +2base，农民各 -base
地主负：地主 -2base，农民各 +base
```

掼蛋：

```text
base = 升级数 × SCORE_BASE
胜方两人各 +base
负方两人各 -base
```

掼蛋升级数：

- 双下：`+3`
- 头游队友二三名：`+2`
- 其他胜局：`+1`

## 查询接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/score/me?gameType=doudizhu&token=<JWT>` | 当前用户斗地主战绩 |
| `GET /api/score/me?gameType=guandan&token=<JWT>` | 当前用户掼蛋战绩 |
| `GET /api/score/top?gameType=doudizhu&limit=20` | 斗地主排行榜 |
| `GET /api/score/top?gameType=guandan&limit=20` | 掼蛋排行榜 |
| `GET /api/sso/health` | 游戏端 SSO 密钥健康检查 |

用户登录和对局结算后，服务端也会通过 Socket.IO 推送 `MY_SCORE` 给本人。

## 头像同步

游戏端会优先使用 JWT payload 中的 `avatarUrl`。如果 payload 没有头像，可通过 `DISCUZ_AVATAR_BASE` 配置头像模板：

```bash
export DISCUZ_AVATAR_BASE='https://forum.example.com/uc_server/avatar.php?uid={uid}&size=middle'
```

模板中的 `{uid}` 会被替换为 Discuz uid。

## 常见问题

### 自动登录失败

检查：

- Discuz 用户是否已登录。
- `bridge.php` 是否能访问。
- `DISCUZ_SSO_SECRET` 与 Node 端 `JWT_SECRET` 指纹是否一致。
- 游戏域名是否在 `redirect` 白名单逻辑允许范围内。

### JWT 校验失败

访问：

```text
/discuz-sso/health.php
/api/sso/health
```

对比返回的 `fingerprint`。

### 数据库没有写入

检查：

- Node 启动日志是否显示已连接 MySQL。
- 玩家是否使用 Discuz 登录，而不是访客身份。
- 数据库账号是否有对应两张积分表的 `SELECT / INSERT / UPDATE` 权限。
- 游戏是否自然结算完成。

### 排行榜为空

排行榜只展示已入库数据。先使用 Discuz 账号完成至少一局斗地主或掼蛋。

### 跨域 cookie 不生效

当前推荐通过 `bridge.php` + URL hash 返回 token，不依赖跨站 cookie。若仍使用 `sso.php` cookie 模式，请确保：

- 游戏和论坛在同一顶级域名下。
- cookie domain 设置为顶级域，例如 `.example.com`。
- HTTPS 环境下 `secure` 设置正确。

## 旧式 cookie 集成

`sso.php` 仍保留两个辅助函数：

```php
doudizhu_set_jwt_cookie($uid, $username);
doudizhu_clear_jwt_cookie();
```

这是早期集成方式，适合游戏和论坛共享 cookie 的同域部署。新部署更推荐 `bridge.php`。
