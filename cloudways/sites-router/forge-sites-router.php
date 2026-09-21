<?php
/**
 * Forge Nexxus — sites router.
 *
 * Serves a member's published website at <slug>.sites.forgenexxus.com from
 * this Cloudways server, by fetching the page the Convex deployment holds and
 * passing it back. Convex stays the one place a published page lives; this
 * file is only the doorway that a branded hostname can knock on.
 *
 * It answers for the sites domain and for a member's own custom domain, and
 * for nothing else: .htaccess decides which hostnames reach it, and the
 * checks below decide again rather than trusting that. Anything it does not
 * recognise gets the same page an unpublished site gets.
 *
 * Install: see README.md beside this file.
 */

declare(strict_types=1);

// ---------------------------------------------------------------------------
// Configuration. These are the only lines to change on the server.
// ---------------------------------------------------------------------------

/** The Convex deployment that holds published pages. No trailing slash. */
const FORGE_CONVEX_ORIGIN = 'https://polished-ram-883.convex.site';

/** The domain member sites sit under. Must match Convex's SITES_DOMAIN. */
const FORGE_SITES_DOMAIN = 'sites.forgenexxus.com';

/** Seconds to wait for the deployment. Total covers the whole request. */
const FORGE_CONNECT_TIMEOUT = 5;
const FORGE_TOTAL_TIMEOUT = 12;

/** Hostnames served as member sites even though they are not under the sites
 *  domain: a member's own domain, once it is also added to this application in
 *  Cloudways and has a certificate. Lowercase, no port, exact matches. */
const FORGE_CUSTOM_DOMAINS = [
    // 'shop.example.com',
];

// ---------------------------------------------------------------------------
// The two pages this file can produce itself.
//
// The first is the page the deployment serves for an unpublished site, kept
// identical to the copy in `convex/http.ts` so the same condition looks the
// same whichever server answered. The second is this router's own, for when
// the deployment could not be reached at all.
// ---------------------------------------------------------------------------

const FORGE_PAGE_STYLE = 'body{margin:0;min-height:100vh;box-sizing:border-box;padding:24px 16px;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;background:#121315;color:#e9ebee;text-align:center}p{color:#9fa1a4}';

function forge_page(string $title, string $heading, string $body, bool $noindex = false): string
{
    $head = $noindex ? '<meta name="robots" content="noindex">' : '';
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . $head
        . '<title>' . htmlspecialchars($title, ENT_QUOTES, 'UTF-8') . '</title>'
        . '<style>' . FORGE_PAGE_STYLE . '</style></head><body><main>'
        . '<h1>' . htmlspecialchars($heading, ENT_QUOTES, 'UTF-8') . '</h1>'
        . '<p>' . htmlspecialchars($body, ENT_QUOTES, 'UTF-8') . '</p>'
        . '</main></body></html>';
}

/** Sends a response and stops. HEAD gets the headers and no body. */
function forge_send(int $status, string $html, array $headers = []): void
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    foreach ($headers as $name => $value) {
        header($name . ': ' . $value);
    }
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
        echo $html;
    }
    exit;
}

function forge_not_published(): void
{
    forge_send(404, forge_page(
        'Not published',
        'Nothing here yet',
        "This site isn't published, or the address has changed."
    ), ['Cache-Control' => 'no-store']);
}

function forge_unavailable(string $reason): void
{
    error_log('forge-sites-router: ' . $reason);
    forge_send(502, forge_page(
        'Site unavailable',
        "This site isn't loading right now",
        "Something on our side didn't answer. Try again in a moment.",
        true
    ), ['Cache-Control' => 'no-store', 'Retry-After' => '30']);
}

// ---------------------------------------------------------------------------
// Which site was asked for.
// ---------------------------------------------------------------------------

/** The hostname the visitor typed, without its port or trailing dot. */
function forge_host(): string
{
    $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
    $host = strtolower(trim($host));
    // An IPv6 literal is bracketed; neither it nor a port is part of the name.
    if (strpos($host, '[') === 0) {
        $host = substr($host, 0, (int) strpos($host, ']') + 1);
    } elseif (($colon = strrpos($host, ':')) !== false) {
        $host = substr($host, 0, $colon);
    }
    return rtrim($host, '.');
}

/**
 * The slug in `<slug>.sites.forgenexxus.com`, or null when the host is not a
 * site address of that shape. The rules are the ones `slugProblem` enforces in
 * `convex/sites.ts`: 3 to 40 characters, lowercase letters, digits and inner
 * hyphens. Checking here as well is what keeps a crafted hostname from
 * reaching for anything but a site.
 */
function forge_slug_for(string $host): ?string
{
    $suffix = '.' . FORGE_SITES_DOMAIN;
    $length = strlen($host) - strlen($suffix);
    if ($length <= 0 || substr($host, $length) !== $suffix) {
        return null;
    }
    $slug = substr($host, 0, $length);
    if (strlen($slug) < 3 || strlen($slug) > 40) {
        return null;
    }
    return preg_match('/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/', $slug) === 1 ? $slug : null;
}

// ---------------------------------------------------------------------------
// Asking the deployment.
// ---------------------------------------------------------------------------

/**
 * Fetches one page. Returns the status, the body, and the few headers worth
 * passing on. A transport failure is tried once more before it is called one:
 * a dropped connection between two servers is usually nothing.
 */
function forge_fetch(string $url): array
{
    if (!function_exists('curl_init')) {
        forge_unavailable('PHP has no cURL extension, so the deployment cannot be reached');
    }
    $keep = ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options'];
    for ($attempt = 0; $attempt < 2; $attempt++) {
        $headers = [];
        $handle = curl_init($url);
        curl_setopt_array($handle, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => FORGE_CONNECT_TIMEOUT,
            CURLOPT_TIMEOUT => FORGE_TOTAL_TIMEOUT,
            // cURL undoes any compression, so the encoding is never passed on.
            CURLOPT_ENCODING => '',
            CURLOPT_USERAGENT => 'ForgeNexxus-SitesRouter/1.0',
            CURLOPT_HTTPHEADER => ['Accept: text/html'],
            CURLOPT_HEADERFUNCTION => function ($handle, $line) use (&$headers, $keep) {
                $at = strpos($line, ':');
                if ($at !== false) {
                    $name = strtolower(trim(substr($line, 0, $at)));
                    if (in_array($name, $keep, true)) {
                        $headers[$name] = trim(substr($line, $at + 1));
                    }
                }
                return strlen($line);
            },
        ]);
        $body = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $error = curl_error($handle);
        curl_close($handle);
        if ($body !== false && $status !== 0) {
            return ['status' => $status, 'body' => (string) $body, 'headers' => $headers];
        }
        if ($attempt === 0) {
            usleep(250000);
        } else {
            forge_unavailable('could not reach ' . FORGE_CONVEX_ORIGIN . ': ' . $error);
        }
    }
    forge_unavailable('could not reach ' . FORGE_CONVEX_ORIGIN);
}

// ---------------------------------------------------------------------------
// The request.
// ---------------------------------------------------------------------------

// A built site's forms are static markup with nothing behind them, so a
// visitor who presses one sends a POST to this same address. Serving the page
// again is what a plain static host does and what the member expects to see;
// an error page would suggest something broke when nothing did. The body goes
// nowhere, which is the honest outcome of a form with nothing connected.
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET' && $method !== 'HEAD' && $method !== 'POST') {
    forge_send(405, forge_page(
        'Not allowed',
        'Nothing here yet',
        "This site isn't published, or the address has changed."
    ), ['Allow' => 'GET, HEAD, POST', 'Cache-Control' => 'no-store']);
}

$host = forge_host();
$slug = forge_slug_for($host);
$known = $slug !== null || in_array($host, FORGE_CUSTOM_DOMAINS, true);
if (!$known) {
    forge_not_published();
}

// A published site is one page. Every other path gets the same answer the
// deployment gives for one: there is nothing at that address.
$path = strtok((string) ($_SERVER['REQUEST_URI'] ?? '/'), '?');
if ($path !== '/' && $path !== '/index.html' && $path !== '') {
    forge_not_published();
}

$url = $slug !== null
    ? FORGE_CONVEX_ORIGIN . '/sites/' . rawurlencode($slug)
    : FORGE_CONVEX_ORIGIN . '/site-by-host?host=' . rawurlencode($host);

$answer = forge_fetch($url);

// 200 and 404 are the deployment speaking about the site, and both are passed
// on as they are -- a 404 carries the very page this router would have shown.
// Anything else is the deployment having trouble, which is not a thing to
// dress up as a missing site.
if ($answer['status'] !== 200 && $answer['status'] !== 404) {
    forge_unavailable('the deployment answered ' . $answer['status'] . ' for ' . $host);
}

http_response_code($answer['status']);
header('Content-Type: ' . ($answer['headers']['content-type'] ?? 'text/html; charset=utf-8'));
header('X-Content-Type-Options: ' . ($answer['headers']['x-content-type-options'] ?? 'nosniff'));
header('Cache-Control: ' . ($answer['headers']['cache-control'] ?? 'no-store'));
if (isset($answer['headers']['content-security-policy'])) {
    header('Content-Security-Policy: ' . $answer['headers']['content-security-policy']);
}
if ($method !== 'HEAD') {
    echo $answer['body'];
}
