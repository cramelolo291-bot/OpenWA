#!/usr/bin/env node
// Register, inspect, probe and delete OpenWA webhooks without hand-writing curl calls.
//
// The gateway already runs the delivery engine: fan-out per event, HMAC signing
// (`X-OpenWA-Signature: sha256=<hex>`) when a secret is set, retries up to 5 attempts, and a
// delivery-failure log with redrive. This script only talks to its API:
//
//   POST   /api/sessions/:sessionId/webhooks          create
//   GET    /api/webhooks                              list every session's webhooks
//   POST   /api/sessions/:sessionId/webhooks/:id/test  send one test payload now
//   DELETE /api/sessions/:sessionId/webhooks/:id      remove
//
// Usage
//   node scripts/register-webhook.mjs --url https://example.com/hook
//   node scripts/register-webhook.mjs --url https://example.com/hook --events message.received,session.disconnected --retry 5
//   node scripts/register-webhook.mjs --url https://example.com/hook --secret-file data/webhook-secret --no-test
//   node scripts/register-webhook.mjs --list
//   node scripts/register-webhook.mjs --test <id> --session utama
//   node scripts/register-webhook.mjs --delete <id>
//
// Options
//   --url <url>            receiver URL (http/https, required unless --list/--test/--delete)
//   --events <a,b>         comma-separated event names, default message.received; "*" = all events
//                          (message.receipt is never implied by "*", name it explicitly)
//   --secret-file <path>   file holding the HMAC secret (16-255 chars). The value is read from disk
//                          and sent once; it is never printed and never comes back from the API.
//   --retry <0-5>          total delivery attempts per event, default 3
//   --session <name|id>    session to register on, default: the first session the gateway returns
//   --no-test              skip the automatic POST .../:id/test after creating
//   --list                 print every registered webhook
//   --test <id>            send a test payload to one webhook
//   --delete <id>          delete one webhook
//
// Env: OPENWA_BASE_URL (default http://127.0.0.1:2785), OPENWA_API_KEY (default: data/.api-key)
//
// Note: the gateway's SSRF guard refuses private destinations (loopback, 10/8, 172.16/12,
// 192.168/16, link-local/metadata). A receiver on localhost or a LAN address needs its hostname in
// SSRF_ALLOWED_HOSTS in .env, then a gateway restart; otherwise registration answers 400.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = (process.env.OPENWA_BASE_URL ?? 'http://127.0.0.1:2785').replace(/\/+$/, '');

function fail(message, code = 1) {
  console.error(`GAGAL: ${message}`);
  process.exit(code);
}

function apiKey() {
  if (process.env.OPENWA_API_KEY) return process.env.OPENWA_API_KEY.trim();
  try {
    return readFileSync(path.join(ROOT, 'data', '.api-key'), 'utf8').trim();
  } catch {
    fail('kunci API tidak ditemukan: isi data/.api-key atau set OPENWA_API_KEY');
  }
}

async function call(method, apiPath, body) {
  let response;
  try {
    response = await fetch(`${BASE}${apiPath}`, {
      method,
      headers: {
        'X-API-Key': apiKey(),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    fail(`tidak bisa menghubungi gateway di ${BASE} (${error.message}). Jalankan ./scripts/up.sh dulu.`);
  }
  const text = await response.text();
  let parsed;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const detail =
      typeof parsed === 'string' ? parsed : (parsed?.message ?? JSON.stringify(parsed ?? {}));
    fail(`HTTP ${response.status} dari ${method} ${apiPath}: ${Array.isArray(detail) ? detail.join('; ') : detail}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = { events: null, retry: 3, test: true };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${token} butuh nilai`);
      i += 1;
      return value;
    };
    switch (token) {
      case '--url':
        args.url = next();
        break;
      case '--events':
        args.events = next().split(',').map((e) => e.trim()).filter(Boolean);
        break;
      case '--secret-file':
        args.secretFile = next();
        break;
      case '--retry':
        args.retry = Number(next());
        if (!Number.isInteger(args.retry) || args.retry < 0 || args.retry > 5) fail('--retry harus 0-5');
        break;
      case '--session':
        args.session = next();
        break;
      case '--list':
        args.list = true;
        break;
      case '--test':
        args.testId = next();
        break;
      case '--delete':
        args.deleteId = next();
        break;
      case '--no-test':
        args.test = false;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        fail(`opsi tidak dikenal: ${token} (pakai --help)`);
    }
  }
  return args;
}

function readSecret(file) {
  const value = readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8').trim();
  if (value.length < 16) fail(`${file}: secret harus minimal 16 karakter`);
  if (value.length > 255) fail(`${file}: secret maksimal 255 karakter`);
  return value;
}

async function resolveSession(wanted) {
  const list = await call('GET', '/api/sessions');
  const sessions = Array.isArray(list) ? list : (list?.sessions ?? list?.data ?? []);
  if (!sessions.length) fail('tidak ada sesi di gateway; jalankan ./scripts/up.sh lalu cek session');
  if (!wanted) return sessions[0];
  const found = sessions.find((s) => s.id === wanted || s.name === wanted);
  if (!found) {
    fail(`sesi "${wanted}" tidak ada (tersedia: ${sessions.map((s) => s.name).join(', ')})`);
  }
  return found;
}

function describe(hook) {
  const parts = [
    `id ${hook.id}`,
    `sesi ${hook.sessionId ?? '?'}`,
    `${hook.active === false ? 'nonaktif' : 'aktif'}`,
    `events ${(hook.events ?? []).join(',') || '-'}`,
    `retry ${hook.retryCount ?? 0}`,
    hook.lastTriggeredAt ? `terakhir ${hook.lastTriggeredAt}` : 'belum pernah dipicu',
  ];
  return `${hook.url}\n  ${parts.join(' · ')}`;
}

const HELP = `Pemakaian:
  node scripts/register-webhook.mjs --url https://example.com/hook [--events a,b] [--secret-file data/webhook-secret] [--retry 3] [--session utama] [--no-test]
  node scripts/register-webhook.mjs --list
  node scripts/register-webhook.mjs --test <id> [--session utama]
  node scripts/register-webhook.mjs --delete <id>

Event yang tersedia: message.received, message.sent, message.ack, message.receipt, message.failed,
message.revoked, message.reaction, message.edited, status.received, session.status, session.qr,
session.authenticated, session.disconnected, session.reconnect_loop, session.restriction,
presence.update, event.response, poll.vote, group.join, group.leave, group.update,
group.join_request, call.received, call.accepted, call.rejected, call.missed, atau "*".`;

const args = parseArgs(process.argv.slice(2));

try {
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.list) {
    const hooks = await call('GET', '/api/webhooks');
    const rows = Array.isArray(hooks) ? hooks : (hooks?.data ?? []);
    if (!rows.length) {
      console.log('Belum ada webhook terdaftar.');
      process.exit(0);
    }
    console.log(`${rows.length} webhook terdaftar:`);
    for (const hook of rows) console.log(`- ${describe(hook)}`);
    process.exit(0);
  }

  if (args.testId) {
    const session = await resolveSession(args.session);
    const result = await call('POST', `/api/sessions/${session.id}/webhooks/${args.testId}/test`);
    if (result?.success) {
      console.log(`Uji terkirim ke webhook ${args.testId} — receiver menjawab HTTP ${result.statusCode ?? '?'}.`);
      process.exit(0);
    }
    console.error(`Uji GAGAL — HTTP ${result?.statusCode ?? '?'}${result?.error ? `: ${result.error}` : ''}`);
    process.exit(2);
  }

  if (args.deleteId) {
    const session = await resolveSession(args.session);
    await call('DELETE', `/api/sessions/${session.id}/webhooks/${args.deleteId}`);
    console.log(`Webhook ${args.deleteId} dihapus.`);
    process.exit(0);
  }

  if (!args.url) fail('--url wajib (atau pakai --list / --test / --delete). Lihat --help.');

  const session = await resolveSession(args.session);
  const body = {
    url: args.url,
    events: args.events ?? ['message.received'],
    retryCount: args.retry,
  };
  if (args.secretFile) body.secret = readSecret(args.secretFile);

  const hook = await call('POST', `/api/sessions/${session.id}/webhooks`, body);
  console.log(`Webhook dibuat pada sesi ${session.name ?? session.id}:`);
  console.log(`- ${describe(hook)}`);
  console.log(
    body.secret
      ? 'Secret terpasang — setiap pengiriman membawa X-OpenWA-Signature: sha256=<hmac> dari body mentah.'
      : 'Tanpa secret — receiver tidak bisa memverifikasi bahwa request benar dari gateway. Pakai --secret-file untuk itu.',
  );
  if (!args.test) process.exit(0);

  const result = await call('POST', `/api/sessions/${session.id}/webhooks/${hook.id}/test`);
  if (result?.success) {
    console.log(`Uji pengiriman sukses — receiver menjawab HTTP ${result.statusCode ?? '?'}.`);
    process.exit(0);
  }
  console.error(
    `Webhook tersimpan, tapi uji pengiriman GAGAL — HTTP ${result?.statusCode ?? '?'}${
      result?.error ? `: ${result.error}` : ''
    }. Cek URL/receiver, lalu ulangi: node scripts/register-webhook.mjs --test ${hook.id}`,
  );
  process.exit(2);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
