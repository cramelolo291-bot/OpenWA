#!/usr/bin/env node
// Local receiver for OpenWA webhooks: verifies the HMAC signature on every delivery, keeps the
// events on disk, and shows the latest ones in a small page.
//
// The gateway signs each delivery with `X-OpenWA-Signature: sha256=<hex>`, an HMAC-SHA256 over the
// exact request body (see src/modules/webhook/utils/deliver-once.ts). This receiver recomputes it
// with the same secret and answers 401 when it does not match, so a forged or replayed-by-hand
// request never lands in the log.
//
// Routes
//   POST /hook      the webhook target (signature required)
//   GET  /          latest events, newest first
//   GET  /events    same data as JSON (?limit=1-200)
//   GET  /health    200 {"ok":true,"events":N,"secret":true|false}
//
// Env
//   OPENWA_WEBHOOK_PORT         listen port (default 2786)
//   OPENWA_WEBHOOK_SECRET_FILE  secret file (default data/webhook-secret)
//   OPENWA_WEBHOOK_LOG          append log (default data/webhook-events.log)
//
// Run: node scripts/webhook-receiver.mjs   (or ./scripts/up.sh, which starts it for you)
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.OPENWA_WEBHOOK_PORT ?? 2786);
const SECRET_FILE = path.resolve(ROOT, process.env.OPENWA_WEBHOOK_SECRET_FILE ?? 'data/webhook-secret');
const LOG_FILE = path.resolve(ROOT, process.env.OPENWA_WEBHOOK_LOG ?? 'data/webhook-events.log');
const MAX_BODY_BYTES = 1024 * 1024;
const KEEP = 200;

let secret = null;
try {
  secret = readFileSync(SECRET_FILE, 'utf8').trim() || null;
} catch {
  secret = null;
}

/** Bounded ring of recent deliveries; the log file keeps the full history. */
const recent = [];

function signatureMatches(rawBody, header) {
  if (!secret) return { ok: false, reason: 'receiver has no secret configured' };
  if (typeof header !== 'string' || !header.startsWith('sha256=')) {
    return { ok: false, reason: 'missing or malformed X-OpenWA-Signature' };
  }
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const given = Buffer.from(header);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return { ok: false, reason: 'signature length mismatch' };
  return timingSafeEqual(given, want)
    ? { ok: true }
    : { ok: false, reason: 'signature does not match this secret' };
}

function summarise(event) {
  const payload = event.payload ?? {};
  const from =
    payload.from ?? payload.chatId ?? payload.senderId ?? payload.recipient ?? payload.phone ?? null;
  const body = typeof payload.body === 'string' ? payload.body : null;
  return { from, body };
}

function renderPage() {
  const rows = recent
    .map((item) => {
      const { from, body } = summarise(item);
      const detail = [from, body].filter(Boolean).join(' — ') || 'tanpa detail';
      return `<tr><td><code>${escape(item.event)}</code></td><td>${escape(item.receivedAt)}</td><td>${escape(detail)}</td><td class="sig">✓</td></tr>`;
    })
    .join('\n');
  return `<!doctype html><html lang="id"><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenWA · penerima webhook</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:32px 20px; font:15px/1.55 ui-sans-serif,system-ui,sans-serif; color:#0d1b2a;
    background: radial-gradient(1100px 520px at 12% -8%, #dceeff, transparent 62%),
                radial-gradient(900px 480px at 92% 4%, #eaf6ff, transparent 58%), #f7fbff; }
  .wrap { max-width: 980px; margin: 0 auto; }
  .card { background: rgba(255,255,255,.72); border:1px solid rgba(255,255,255,.9);
    box-shadow: 0 18px 46px -26px rgba(23,78,140,.45), inset 0 1px 0 #fff;
    backdrop-filter: blur(18px) saturate(160%); border-radius: 22px; padding: 22px 24px; }
  h1 { margin:0 0 4px; font-size:20px; letter-spacing:-.01em; }
  p.hint { margin:0 0 18px; color:#4d6b8a; font-size:13.5px; }
  table { width:100%; border-collapse: collapse; font-size:13.5px; }
  th { text-align:left; font-weight:600; color:#40607f; padding:8px 10px; border-bottom:1px solid #dceaf7; }
  td { padding:9px 10px; border-bottom:1px solid #eaf3fb; vertical-align: top; }
  tr:last-child td { border-bottom:0; }
  code { background:#eef6ff; border-radius:6px; padding:1px 6px; color:#125c9c; }
  td.sig { color:#177a4b; font-weight:700; }
  .empty { color:#5a7a99; padding:18px 4px; }
</style>
<div class="wrap"><div class="card">
  <h1>Penerima webhook OpenWA</h1>
  <p class="hint">${recent.length} event terakhir · tanda tangan HMAC-SHA256 diverifikasi · log: <code>${escape(
    path.relative(ROOT, LOG_FILE),
  )}</code></p>
  ${
    recent.length
      ? `<table><thead><tr><th>Event</th><th>Diterima</th><th>Ringkasan</th><th>HMAC</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">Belum ada event. Kirim pesan WhatsApp atau restart sesi untuk memicu satu.</div>'
  }
</div></div></html>`;
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, events: recent.length, secret: Boolean(secret), log: path.relative(ROOT, LOG_FILE) });
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), KEEP);
    return json(res, 200, { count: recent.length, events: recent.slice(0, limit) });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(renderPage());
  }

  if (url.pathname !== '/hook') return json(res, 404, { error: 'not found' });
  if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });

  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      json(res, 413, { error: 'body too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const verdict = signatureMatches(raw, req.headers['x-openwa-signature']);
    const event = String(req.headers['x-openwa-event'] ?? '(tanpa event)');
    const deliveryId = String(req.headers['x-openwa-delivery-id'] ?? '');

    if (!verdict.ok) {
      console.error(`[webhook] REJECT ${event} — ${verdict.reason}`);
      return json(res, 401, { error: 'invalid signature', reason: verdict.reason });
    }

    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
    const entry = {
      receivedAt: new Date().toISOString(),
      event,
      deliveryId,
      retryCount: req.headers['x-openwa-retry-count'] ?? '0',
      signature: req.headers['x-openwa-signature'],
      bytes: Buffer.byteLength(raw),
      payload,
    };
    recent.unshift(entry);
    if (recent.length > KEEP) recent.pop();
    try {
      mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      console.error(`[webhook] tidak bisa menulis log: ${error.message}`);
    }
    console.log(`[webhook] OK ${event} (${entry.bytes} B, delivery ${deliveryId || '-'})`);
    return json(res, 200, { ok: true, received: event });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[webhook] menerima di http://0.0.0.0:${PORT}/hook`);
  console.log(`[webhook] secret: ${secret ? `dari ${path.relative(ROOT, SECRET_FILE)}` : 'TIDAK ADA — semua delivery akan ditolak 401'}`);
  console.log(`[webhook] log: ${path.relative(ROOT, LOG_FILE)}`);
});
