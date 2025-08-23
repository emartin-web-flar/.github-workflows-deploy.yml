/**
 * Reverse proxy + full-domain rewriting (streaming)
 * - Maps your domain (https://sharpsburgcounseling.com) to the origin
 *   (https://www.community-christian.net/sharpsburg-counseling)
 * - Rewrites ALL text responses (HTML/CSS/JS/JSON/etc) so absolute links,
 *   inline scripts/CSS, meta refresh, etc. never leak the origin domain.
 * - Handles redirects (Location header rewriting).
 */

const MY_DOMAIN = "https://sharpsburgcounseling.com";          // your public domain
const ORIGIN_DOMAIN = "https://www.community-christian.net";    // origin host
const ORIGIN_BASE = "/sharpsburg-counseling";                   // origin base path

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Map incoming path on your domain -> origin path
    // If already prefixed with ORIGIN_BASE, don't add it again.
    // Otherwise, add ORIGIN_BASE in front so /about -> /sharpsburg-counseling/about
    const incomingPath = url.pathname;
    const originPath = incomingPath.startsWith(ORIGIN_BASE)
      ? incomingPath
      : ORIGIN_BASE + incomingPath;

    const targetUrl = ORIGIN_DOMAIN + originPath + url.search;

    // Forward request to origin (no auto-follow so we can rewrite Location)
    const passBody = request.method === "GET" || request.method === "HEAD" ? null : request.body;
    const originResp = await fetch(targetUrl, {
      method: request.method,
      headers: buildForwardHeaders(request.headers),
      body: passBody,
      redirect: "manual"
    });

    // Handle 3xx redirects by rewriting Location
    if (originResp.status >= 300 && originResp.status < 400) {
      const loc = originResp.headers.get("Location");
      if (loc) {
        const newLoc = rewriteAbsoluteUrl(loc);
        return new Response(null, {
          status: originResp.status,
          headers: setCommonHeaders(copyHeaders(originResp.headers, ["location"]), [["Location", newLoc]])
        });
      }
      // No location header; just pass through
      return passthrough(originResp);
    }

    // Decide whether to stream-rewrite body
    const ct = originResp.headers.get("content-type") || "";
    if (shouldTransform(ct)) {
      // Stream transform text responses
      const transformed = transformStream(originResp.body, rewriteTextStreaming);
      const headers = setCommonHeaders(
        copyHeaders(originResp.headers),
        [
          // Normalize content-type to keep encoding consistent
          ["content-type", canonicalizeContentType(ct)]
        ]
      );
      return new Response(transformed, {
        status: originResp.status,
        headers
      });
    }

    // Binary or non-text: just pass through, but still fix CSP & CORS if needed
    return passthrough(originResp);
  }
};

/* ----------------------- helpers ----------------------- */

// Forward most headers but set Host to origin host, and drop hop-by-hop headers
function buildForwardHeaders(reqHeaders) {
  const h = new Headers();
  for (const [k, v] of reqHeaders.entries()) {
    const lk = k.toLowerCase();
    if (["host", "cf-connecting-ip", "x-forwarded-for", "x-real-ip", "content-length"].includes(lk)) continue;
    if (["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"].includes(lk)) continue;
    h.set(k, v);
  }
  h.set("Host", new URL(ORIGIN_DOMAIN).host);
  return h;
}

// Copy headers optionally keeping only a subset
function copyHeaders(headers, keepLowercase = null) {
  const out = new Headers();
  const keep = keepLowercase && new Set(keepLowercase.map(x => x.toLowerCase()));
  for (const [k, v] of headers.entries()) {
    if (keep && !keep.has(k.toLowerCase())) continue;
    out.set(k, v);
  }
  return out;
}

// Add/override headers
function setCommonHeaders(headers, pairs = []) {
  const h = new Headers(headers);

  // So your content can be embedded and scripts run as expected after rewriting
  h.delete("content-security-policy");
  h.delete("content-security-policy-report-only");
  h.set("x-proxy-by", "cf-worker-mask");

  // Basic CORS open (helps when the site uses fetch/XHR to same-host after rewrite)
  h.set("access-control-allow-origin", MY_DOMAIN);
  h.set("access-control-allow-credentials", "true");

  for (const [k, v] of pairs) h.set(k, v);
  return h;
}

// Should we transform this content-type?
function shouldTransform(contentType) {
  const t = contentType.toLowerCase();
  return (
    t.includes("text/") ||
    t.includes("application/javascript") ||
    t.includes("application/x-javascript") ||
    t.includes("application/json") ||
    t.includes("application/xml") ||
    t.includes("image/svg+xml")
  );
}

// Normalize CT to include charset
function canonicalizeContentType(ct) {
  const base = ct.split(";")[0].trim();
  // HTML default to UTF-8; for other text types, UTF-8 is safe
  return `${base}; charset=utf-8`;
}

// Pass through as-is
function passthrough(resp) {
  return new Response(resp.body, {
    status: resp.status,
    headers: setCommonHeaders(resp.headers)
  });
}

/* ------------------- URL/HTML rewriting ------------------- */

/**
 * Map absolute origin URLs -> your domain, maintaining paths correctly:
 *  - https://www.community-christian.net/sharpsburg-counseling/abc  -> https://sharpsburgcounseling.com/abc
 *  - https://www.community-christian.net/asset.png                   -> https://sharpsburgcounseling.com/sharpsburg-counseling/asset.png
 *  - //www.community-christian.net/...                               -> (same mapping as above, protocol-relative)
 */
function rewriteAbsoluteUrl(raw) {
  try {
    // Handle protocol-relative
    if (raw.startsWith("//")) raw = "https:" + raw;

    const u = new URL(raw, ORIGIN_DOMAIN); // base for relative inputs
    // Only rewrite if it points at the origin host
    if (u.host !== new URL(ORIGIN_DOMAIN).host) return raw;

    const path = u.pathname;
    if (path.startsWith(ORIGIN_BASE)) {
      // Drop ORIGIN_BASE on public side
      const newPath = path.slice(ORIGIN_BASE.length) || "/";
      return MY_DOMAIN + newPath + (u.search || "") + (u.hash || "");
    } else {
      // Paths outside the counseling base get prefixed so they resolve back to origin root.
      // e.g. /hs-fs/file.css -> /sharpsburg-counseling/hs-fs/file.css
      const newPath = ORIGIN_BASE + (path.startsWith("/") ? path : "/" + path);
      return MY_DOMAIN + newPath + (u.search || "") + (u.hash || "");
    }
  } catch {
    return raw;
  }
}

/**
 * Streaming text transform:
 * - Rewrites any absolute origin URL to your domain using rewriteAbsoluteUrl()
 * - Also fixes common inline patterns: meta refresh, window.location, fetch URLs, CSS url()
 *
 * We operate on text safely by buffering a small tail between chunks to avoid
 * splitting match tokens (carry window).
 */
function transformStream(readable, rewriterFn) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const CARRY = 1024; // carry ~1KB between chunks for boundary safety

  const ts = new TransformStream({
    start() {
      this.buffer = "";
    },
    transform(chunk, controller) {
      let text = decoder.decode(chunk, { stream: true });
      this.buffer += text;

      if (this.buffer.length > CARRY * 2) {
        const keepTail = this.buffer.slice(-CARRY);
        const head = this.buffer.slice(0, -CARRY);
        const rewrittenHead = rewriterFn(head);
        controller.enqueue(encoder.encode(rewrittenHead));
        this.buffer = keepTail;
      }
    },
    flush(controller) {
      if (this.buffer && this.buffer.length) {
        const out = rewriterFn(this.buffer);
        controller.enqueue(encoder.encode(out));
      }
    }
  });

  return readable.pipeThrough(ts);
}

function rewriteTextStreaming(text) {
  // 1) Absolute URLs that include the base path: drop the base
  //    https://www.community-christian.net/sharpsburg-counseling/... -> https://sharpsburgcounseling.com/...
  text = text.replace(
    /https?:\/\/www\.community-christian\.net\/sharpsburg-counseling([^\s"'()<]*)/gi,
    (_m, rest) => `${MY_DOMAIN}${rest || ""}`
  );

  // 2) Absolute URLs to origin root (no base): add /sharpsburg-counseling prefix
  //    https://www.community-christian.net/... -> https://sharpsburgcounseling.com/sharpsburg-counseling/...
  text = text.replace(
    /https?:\/\/www\.community-christian\.net(\/[^\s"'()<]*)/gi,
    (_m, path) => `${MY_DOMAIN}${ORIGIN_BASE}${path || ""}`
  );

  // 3) Protocol-relative URLs //www.community-christian.net/...
  text = text.replace(
    /\/\/www\.community-christian\.net\/sharpsburg-counseling([^\s"'()<]*)/gi,
    (_m, rest) => `${MY_DOMAIN}${rest || ""}`
  );
  text = text.replace(
    /\/\/www\.community-christian\.net(\/[^\s"'()<]*)/gi,
    (_m, path) => `${MY_DOMAIN}${ORIGIN_BASE}${path || ""}`
  );

  // 4) Meta refresh content="0; url=..."
  text = text.replace(
    /(http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=)([^"']+)(["'])/gi,
    (m, pre, url, post) => pre + rewriteAbsoluteUrl(url) + post
  );

  // 5) CSS url("https://www.community-christian.net/...") and url(//...)
  text = text.replace(
    /url\(\s*["']?(https?:)?\/\/www\.community-christian\.net([^)'" ]*)["']?\s*\)/gi,
    (_m, proto, path) => `url(${rewriteAbsoluteUrl(`https:${"//www.community-christian.net"}${path}`)})`
  );

  // 6) Common inline JS redirects: window.location / document.location / location.href
  text = text.replace(
    /(window|document)?\.?\s*location(?:\.href)?\s*=\s*["']([^"']+)["']/gi,
    (_m, _obj, url) => `${_obj ? _obj + "." : ""}location.href="${rewriteAbsoluteUrl(url)}"`
  );

  // 7) fetch("https://www.community-christian.net/..."), XHR, etc.
  text = text.replace(
    /(\bfetch\s*\(\s*["'])([^"']+)(["'])/gi,
    (_m, pre, url, post) => pre + rewriteAbsoluteUrl(url) + post
  );
  text = text.replace(
    /(\bopen\s*\(\s*["'](?:GET|POST|PUT|DELETE|HEAD)["']\s*,\s*["'])([^"']+)(["'])/gi,
    (_m, pre, url, post) => pre + rewriteAbsoluteUrl(url) + post
  );

  return text;
}
