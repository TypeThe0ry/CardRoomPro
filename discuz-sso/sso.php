<?php
/**
 * Discuz 3.5 SSO helper for doudizhu-online
 *
 * 用途：在 Discuz 登录成功后生成 JWT 并设置浏览器 cookie `discuz_token`，
 * 前端会读取此 cookie 并在 socket.io 握手时发送给 Node 游戏服务器，
 * Node 端使用相同的 secret 验证 token 后可自动登录用户。
 *
 * 说明（简要）：
 *  - 需要在 Discuz 站点安装 Composer 依赖 `firebase/php-jwt`：
 *      composer require firebase/php-jwt
 *  - 将本文件放到 Discuz 根目录或便于 include 的位置，例如放到站点根目录下的 `discuz-sso/sso.php`
 *  - 在 Discuz 登录成功逻辑处（例如 `member.php?mod=logging&action=login` 登录成功分支）调用 `doudizhu_set_jwt_cookie($uid, $username)`
 *  - 在登出逻辑处调用 `doudizhu_clear_jwt_cookie()` 清除 cookie
 *  - 确保 Node 游戏服务器和 Discuz 端使用相同的 `JWT_SECRET`（可通过环境变量 `JWT_SECRET` 或在 config 中定义常量 `DISCUZ_SSO_SECRET`）
 *
 * 安全提示：生产环境务必设置强随机字符串作为 JWT secret，并通过 HTTPS，设置合适的 cookie domain。不要把弱 secret 写入代码库。
 */

// 载入 Composer autoload（根据你站点的实际路径调整）
if (file_exists(__DIR__ . '/vendor/autoload.php')) {
    require_once __DIR__ . '/vendor/autoload.php';
} else if (file_exists(__DIR__ . '/../vendor/autoload.php')) {
    require_once __DIR__ . '/../vendor/autoload.php';
} else {
    // 如果在 Discuz 环境中，可能需要调整路径或先在站点根目录运行 composer
    // 这里不强制失败，调用方应确保依赖存在
}

use Firebase\JWT\JWT;

// 获取 secret：优先使用常量 DISCUZ_SSO_SECRET，其次 ENV，最后默认（仅开发用）
$SSO_SECRET = defined('DISCUZ_SSO_SECRET') ? DISCUZ_SSO_SECRET : (getenv('JWT_SECRET') ?: 'change_this_in_production');

/**
 * 设置 JWT cookie
 * @param int $uid
 * @param string $username
 * @param int $ttl 秒，默认 24 小时
 */
function doudizhu_set_jwt_cookie($uid, $username, $ttl = 86400) {
    global $SSO_SECRET;
    if (!$uid || !$username) return false;
    $issuedAt = time();
    $expire = $issuedAt + intval($ttl);
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '';
    $avatarUrl = $host ? ($scheme . '://' . $host . '/uc_server/avatar.php?uid=' . rawurlencode((string)$uid) . '&size=middle') : '';
    $payload = [
        'uid' => intval($uid),
        'username' => strval($username),
        'avatarUrl' => $avatarUrl,
        'iat' => $issuedAt,
        'exp' => $expire,
    ];
    try {
        $jwt = JWT::encode($payload, $SSO_SECRET, 'HS256');
    } catch (Exception $e) {
        error_log('JWT encode error: ' . $e->getMessage());
        return false;
    }

    // 默认 domain 请替换为你的域名（例如 '.example.com'），以便子域名共享 cookie
    $domain = '';
    // 是否使用安全 cookie (https)
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');

    // 尽量兼容老 PHP 版本，不使用 options 数组（PHP < 7.3）
    setcookie('discuz_token', $jwt, $expire, '/', $domain, $secure, false);
    // 返回 token 以便调试或其它用途
    return $jwt;
}

/**
 * 清除 JWT cookie
 */
function doudizhu_clear_jwt_cookie() {
    // 将 cookie 设置为过去时间以便浏览器删除
    $domain = '';
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    setcookie('discuz_token', '', time() - 3600, '/', $domain, $secure, false);
    return true;
}

/**
 * 辅助：如果在 Discuz 环境中使用，可以直接根据全局 $_G 设置 cookie
 * 在 Discuz 登录成功处调用：
 *   require_once DISCUZ_ROOT.'./discuz-sso/sso.php';
 *   doudizhu_set_jwt_cookie($_G['uid'], $_G['member']['username']);
 * 在登出处调用：
 *   doudizhu_clear_jwt_cookie();
 */

?>
