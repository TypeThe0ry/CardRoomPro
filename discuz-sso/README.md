# Discuz 3.5 与 Doudizhu 在线游戏（JWT SSO）集成说明

本目录提供一个最小可用的 Discuz 3.5 SSO 接入示例：在用户登录后生成 JWT（JSON Web Token），并设置浏览器 cookie `discuz_token`。

前提
- 你已有一套运行中的 Discuz 3.5；本站点与游戏前端在同一域或可共享 cookie（否则需额外处理跨域）。
- Node 游戏服务器（doudizhu-online）已经部署并配置为从握手 `auth.token` 中验证 JWT（本仓库已修改 `server.js`）。

安装步骤（在 Discuz 站点服务器上）

1. 进入 Discuz 站点根目录并安装 JWT 依赖：

```bash
cd /path/to/discuz
composer require firebase/php-jwt
```

2. 将本目录 `discuz-sso` 上传到 Discuz 根目录（保持 `sso.php` 路径，例如：`/path/to/discuz/discuz-sso/sso.php`）。

3. 在 Discuz 登录成功后调用 SSO 设定函数。

   编辑 `member.php`（登录相关逻辑，可能路径为 `member.php?mod=logging&action=login`），找到登录成功分支（通常是 `if ($_G['uid'])` 或相关块），加入：

```php
require_once DISCUZ_ROOT . './discuz-sso/sso.php';
doudizhu_set_jwt_cookie($_G['uid'], $_G['member']['username']);
```

4. 在登出逻辑处清除 cookie（可在 `member.php?mod=logging&action=logout` 或模板退出逻辑处）加入：

```php
require_once DISCUZ_ROOT . './discuz-sso/sso.php';
doudizhu_clear_jwt_cookie();
```

5. 配置 JWT secret

- 强烈建议通过环境变量 `JWT_SECRET` 为 Discuz 与 Node 服务器分别设置相同的强随机字符串，或者在 Discuz 配置文件中定义常量 `DISCUZ_SSO_SECRET`：

```php
// 在 Discuz 配置或入口文件中加入：
define('DISCUZ_SSO_SECRET', '请替换为一个强随机字符串');
```

6. 确保 cookie domain 与 secure 设置

- 默认 `sso.php` 中 cookie `domain` 留空，请替换为你的站点主域（如 `.example.com`）以便子域共享。
- 如果使用 HTTPS，请确保 `secure` 为 true（脚本会基于 `$_SERVER['HTTPS']` 自动设置）。

7. 前端与服务器

- 前端（`static/index.html`）已经实现读取 `discuz_token` 并在连接时通过 socket.io `auth.token` 发送到 Node 服务器。
- Node 服务器需要使用与 Discuz 相同的 `JWT_SECRET` 来校验 token（本仓库 `server.js` 已使用 `process.env.JWT_SECRET || 'change_this_in_production'`）。

调试建议
- 如果自动登录失败，可在浏览器控制台检查 cookie `discuz_token` 是否存在、是否过期。
- 在 Discuz 端临时将 `doudizhu_set_jwt_cookie()` 的返回值打印或记录到日志以检查生成的 token。
- 使用 jwt.io 工具可以解码 token 检查 payload（请不要把 secret 放到公共场合）。

常见问题
- 如果你的网站和游戏不在同一域名下，浏览器默认不会发送 cookie，需使用跨域登录（例如：Discuz 登录后通过 AJAX 将 token 传给游戏域的登录接口，或配置顶级域名共享 cookie）。

联系方式
- 如果需要，我可以把 `sso.php` 改写为更符合你 Discuz 环境的插件格式（完整插件包），或把集成步骤写成补丁脚本。
