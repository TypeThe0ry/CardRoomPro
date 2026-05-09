<?php
/**
 * Example Discuz integration: generate a JWT for logged-in user and set cookie.
 *
 * Requirements:
 *  - install firebase/php-jwt via Composer: `composer require firebase/php-jwt`
 *  - call this script (or similar logic) after successful Discuz login.
 *  - set a strong secret in your environment or config and keep it private.
 *
 * This example sets a cookie named `discuz_token` that the browser will send
 * and the client JS will forward to the game server via socket.io auth.
 */

require __DIR__ . '/vendor/autoload.php';
use Firebase\JWT\JWT;
use Firebase\JWT\Key;

// Replace with your secret and choose a secure storage for it
$secret = getenv('JWT_SECRET') ?: 'change_this_in_production';

// Example: get Discuz user info after login. Replace with actual Discuz user variables.
// For demonstration we assume $uid and $username are available after login.
$uid = isset($uid) ? intval($uid) : (isset($_SESSION['uid']) ? intval($_SESSION['uid']) : 0);
$username = isset($username) ? $username : (isset($_SESSION['username']) ? $_SESSION['username'] : 'guest');

if (!$uid) {
    http_response_code(403);
    echo 'Not logged in';
    exit;
}

$issuedAt = time();
$expire = $issuedAt + 60 * 60 * 24; // token valid for 24 hours; tune as needed

$payload = [
    'uid' => $uid,
    'username' => $username,
    'iat' => $issuedAt,
    'exp' => $expire,
    // you can add more custom claims if needed
];

$jwt = JWT::encode($payload, $secret, 'HS256');

// Set cookie for the frontend. Adjust domain and secure flags for production.
setcookie('discuz_token', $jwt, [
    'expires' => $expire,
    'path' => '/',
    'domain' => '', // set your domain if needed: '.example.com'
    'secure' => isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'httponly' => false, // must be accessible by JS so set false
    'samesite' => 'Lax'
]);

// You can redirect back to the app or return JSON
header('Content-Type: application/json; charset=utf-8');
echo json_encode(['success' => true, 'token_set' => true]);

// Example usage: include or call this code after Discuz login hook so the cookie is present for the browser.

?>
