"use strict";

/**
 * VLESS over WebSocket (TCP only) + a small page that shows the client link.
 *
 * Environment variables (all optional except VLESS_UUID on stateless hosts):
 *   VLESS_UUID    user id. If missing: uuid.txt is used, else a random one is made.
 *   VLESS_NAME    label and last part of the path (/ws/<name>), default "Luffy".
 *   VLESS_HOST    public host for the link (default: taken from the request).
 *   VLESS_PORT    public port for the link (default: taken from the request).
 *   VLESS_TLS     "1" forces security=tls in the link.
 *   VLESS_DEBUG   "1" also logs destination hosts.
 *   PORT / SERVER_PORT   listening port (default 8000).
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

// ---------------------------------------------------------------- config
const NAME = (process.env.VLESS_NAME || "Luffy").replace(/[^A-Za-z0-9._-]/g, "") || "Luffy";
const HOST_OVERRIDE = (process.env.VLESS_HOST || "").trim();
const PORT_OVERRIDE = (process.env.VLESS_PORT || "").trim();
const FORCE_TLS = process.env.VLESS_TLS === "1";
const DEBUG = process.env.VLESS_DEBUG === "1";

const RAW_PORT = String(process.env.SERVER_PORT || process.env.PORT || "8000");
const LISTEN_TARGET = /^\d+$/.test(RAW_PORT) ? Number(RAW_PORT) : RAW_PORT; // pipe names allowed

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function loadUuid() {
  const fromEnv = (process.env.VLESS_UUID || "").trim().toLowerCase();
  if (fromEnv) return fromEnv;

  const file = path.join(__dirname, "uuid.txt");
  try {
    const fromFile = fs.readFileSync(file, "utf8").trim().toLowerCase();
    if (fromFile) return fromFile;
  } catch (_) {
    /* no file */
  }

  const fresh = crypto.randomUUID();
  try {
    fs.writeFileSync(file, fresh);
  } catch (_) {
    /* read-only disk */
  }
  console.warn("[config] VLESS_UUID is not set: using a random UUID. It may change on restart!");
  console.warn("[config] Set the VLESS_UUID environment variable to keep your link stable.");
  return fresh;
}

const USER_UUID = loadUuid();
if (!UUID_RE.test(USER_UUID)) {
  console.error(`[config] Invalid UUID: "${USER_UUID}"`);
  process.exit(1);
}
const UUID_BYTES = Buffer.from(USER_UUID.replace(/-/g, ""), "hex");

// ---------------------------------------------------------------- VLESS
/** Parses the first VLESS request frame. Returns null if invalid. */
function parseRequest(buf) {
  if (buf.length < 24) return null;
  if (!buf.subarray(1, 17).equals(UUID_BYTES)) return null;

  const version = buf[0];
  let i = 18 + buf[17]; // skip addons
  if (buf.length < i + 4) return null;
  if (buf[i] !== 1) return null; // only TCP

  const port = buf.readUInt16BE(i + 1);
  const type = buf[i + 3];
  i += 4;

  let host;
  if (type === 1) {
    if (buf.length < i + 4) return null;
    host = `${buf[i]}.${buf[i + 1]}.${buf[i + 2]}.${buf[i + 3]}`;
    i += 4;
  } else if (type === 2) {
    if (buf.length <= i) return null;
    const len = buf[i++];
    if (len === 0 || buf.length < i + len) return null;
    host = buf.toString("utf8", i, i + len);
    i += len;
  } else if (type === 3) {
    if (buf.length < i + 16) return null;
    const groups = [];
    for (let k = 0; k < 16; k += 2) groups.push(buf.readUInt16BE(i + k).toString(16));
    host = groups.join(":");
    i += 16;
  } else {
    return null;
  }
  return { version, host, port, payload: buf.subarray(i) };
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

wss.on("connection", (ws) => {
  let remote = null;
  let started = false;

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  const closeAll = () => {
    if (remote) remote.destroy();
    try {
      ws.terminate();
    } catch (_) {
      /* already closed */
    }
  };

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return closeAll();
    const buf = Array.isArray(data) ? Buffer.concat(data) : data;

    // after the handshake: client -> target
    if (started) {
      if (remote && !remote.destroyed && !remote.write(buf)) {
        ws._socket.pause();
        remote.once("drain", () => ws._socket.resume());
      }
      return;
    }

    // first frame: VLESS request
    started = true;
    const req = parseRequest(buf);
    if (!req) {
      console.log("[vless] rejected: bad header (UUID mismatch or unsupported command)");
      return closeAll();
    }
    if (DEBUG) console.log(`[vless] connecting to ${req.host}:${req.port}`);

    remote = net.connect({ host: req.host, port: req.port });
    remote.setNoDelay(true);
    const timer = setTimeout(() => remote.destroy(new Error("connect timeout")), 10000);

    remote.once("connect", () => {
      clearTimeout(timer);
      if (req.payload.length) remote.write(req.payload);
      ws.send(Buffer.from([req.version, 0])); // VLESS response header

      remote.on("data", (chunk) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(chunk, () => {
          if (remote.isPaused() && ws.bufferedAmount < 512 * 1024) remote.resume();
        });
        if (ws.bufferedAmount > 1024 * 1024) remote.pause();
      });
    });

    remote.on("error", (err) => {
      clearTimeout(timer);
      if (DEBUG) console.log(`[vless] ${req.host}:${req.port} failed: ${err.code || err.message}`);
      closeAll();
    });
    remote.on("close", () => {
      clearTimeout(timer);
      closeAll();
    });
  });

  ws.on("close", closeAll);
  ws.on("error", closeAll);
});

// drop dead connections and keep idle ones alive through proxies
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {
      /* closing */
    }
  });
}, 30000);
heartbeat.unref();

// ---------------------------------------------------------------- link page
const first = (v) => String(v || "").split(",")[0].trim();
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Server-side link (used when JavaScript is off; the page script refines it). */
function buildLink(headers) {
  const raw = HOST_OVERRIDE || first(headers["x-forwarded-host"]) || headers.host || "localhost";
  let host = "localhost";
  let hostPort = "";
  try {
    const u = new URL("http://" + raw);
    host = u.hostname.replace(/^\[|\]$/g, "");
    hostPort = u.port;
  } catch (_) {
    /* keep defaults */
  }
  const proto = first(headers["x-forwarded-proto"]).toLowerCase();
  const tls = FORCE_TLS || proto === "https" || proto === "wss";
  const port = PORT_OVERRIDE || hostPort || first(headers["x-forwarded-port"]) || (tls ? "443" : "80");

  const params = { encryption: "none", security: tls ? "tls" : "none", type: "ws", host, path: `/ws/${NAME}` };
  if (tls) {
    params.sni = host;
    params.fp = "chrome";
    params.alpn = "http/1.1";
  }
  const uriHost = host.includes(":") ? `[${host}]` : host;
  return `vless://${USER_UUID}@${uriHost}:${port}?${new URLSearchParams(params)}#${encodeURIComponent(NAME)}`;
}

function renderPage(link) {
  const fixed = HOST_OVERRIDE || PORT_OVERRIDE || FORCE_TLS ? "1" : "0";
  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(NAME)}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f5ef;font-family:Tahoma,Arial,sans-serif;color:#0f172a;padding:24px;box-sizing:border-box}
.card{width:100%;max-width:560px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;box-sizing:border-box}
h1{margin:0 0 6px;font-size:24px}p{color:#475569;font-size:14px;line-height:1.9}
code{display:block;direction:ltr;text-align:left;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.8;word-break:break-all;user-select:all}
button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:12px;background:#0f766e;color:#fff;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer}
</style></head><body><div class="card">
<h1>${escapeHtml(NAME)}</h1><p>لینک اتصال VLESS شما:</p>
<code id="l" data-u="${USER_UUID}" data-n="${escapeHtml(NAME)}" data-fixed="${fixed}">${escapeHtml(link)}</code>
<button id="b">کپی لینک</button></div>
<script>
(function () {
  var e = document.getElementById('l');
  if (e.dataset.fixed !== '1') {
    var tls = location.protocol === 'https:', h = location.hostname;
    var p = location.port || (tls ? '443' : '80'), n = e.dataset.n;
    var q = 'encryption=none&security=' + (tls ? 'tls' : 'none') + '&type=ws&host=' + h +
            '&path=' + encodeURIComponent('/ws/' + n) + (tls ? '&sni=' + h + '&fp=chrome&alpn=http%2F1.1' : '');
    e.textContent = 'vless://' + e.dataset.u + '@' + (h.indexOf(':') > -1 ? '[' + h + ']' : h) + ':' + p +
                    '?' + q + '#' + encodeURIComponent(n);
  }
  document.getElementById('b').onclick = function () {
    var r = document.createRange(); r.selectNode(e);
    var s = getSelection(); s.removeAllRanges(); s.addRange(r);
    try { document.execCommand('copy'); } catch (x) {}
  };
})();
</script></body></html>`;
}

// ---------------------------------------------------------------- server
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"ok":true}');
  }
  if (url === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(renderPage(buildLink(req.headers)));
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.on("upgrade", (req, socket, head) => {
  const url = req.url.split("?")[0];
  if (!url.startsWith("/ws/")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

process.on("uncaughtException", (err) => console.error("[uncaught]", err));
process.on("unhandledRejection", (err) => console.error("[unhandled]", err));
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

const onListen = () => {
  console.log(`[ready] listening on ${LISTEN_TARGET}`);
  console.log(`[ready] UUID: ${USER_UUID}`);
};
if (typeof LISTEN_TARGET === "number") server.listen(LISTEN_TARGET, "0.0.0.0", onListen);
else server.listen(LISTEN_TARGET, onListen);
