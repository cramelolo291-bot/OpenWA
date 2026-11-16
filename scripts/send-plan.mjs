#!/usr/bin/env node
/**
 * Kirim rencana/spec markdown ke WhatsApp sebagai link Plannotator yang bisa dianotasi.
 *
 * Plannotator menyimpan share berukuran kecil sepenuhnya di dalam hash URL (deflate-raw +
 * base64url dari `{ p: markdown, a: [] }`), jadi tidak butuh server, akun, atau login: link
 * yang dibuat di sini bisa langsung dibuka di ponsel penerima dan dianotasi di sana.
 *
 * Pemakaian:
 *   node scripts/send-plan.mjs rencana.md                  # kirim ke chat diri sendiri di sesi utama
 *   node scripts/send-plan.mjs rencana.md --to 6285xxxx    # kirim ke nomor lain
 *   cat rencana.md | node scripts/send-plan.mjs - --dry-run # hanya cetak link (tanpa kirim)
 *
 * Opsi: --to <nomor> | --session <nama sesi> | --title <judul> | --text <teks pengantar> | --dry-run
 *
 * Env: OPENWA_API_URL (http://127.0.0.1:2785), OPENWA_API_KEY (default: isi data/.api-key),
 * OPENWA_SESSION (utama), OPENWA_PLAN_TO (nomor tujuan), PLANNOTATOR_SHARE_BASE
 * (https://share.plannotator.ai).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const API_URL = (process.env.OPENWA_API_URL || 'http://127.0.0.1:2785').replace(/\/+$/, '');
const SHARE_BASE = (process.env.PLANNOTATOR_SHARE_BASE || 'https://share.plannotator.ai').replace(/\/+$/, '');
const ROOT = path.resolve(import.meta.dirname, '..');
const MAX_TEXT_LENGTH = 4096;

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Kirim rencana markdown sebagai link Plannotator lewat WhatsApp.

  node scripts/send-plan.mjs <file.md|-> [opsi]

Opsi:
  --to <nomor>       nomor tujuan (default: OPENWA_PLAN_TO, atau nomor sesi sendiri)
  --session <nama>   nama sesi WhatsApp (default: OPENWA_SESSION atau "utama")
  --title <judul>    judul rencana di pesan pengantar (default: nama file)
  --text <teks>      teks pengantar (default: "Rencana siap direview: <judul>")
  --dry-run          cetak link + rencana pesan, jangan kirim

Env: OPENWA_API_URL, OPENWA_API_KEY, OPENWA_SESSION, OPENWA_PLAN_TO, PLANNOTATOR_SHARE_BASE`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = { file: null, to: null, session: process.env.OPENWA_SESSION || 'utama', title: null, text: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--to') opts.to = argv[++i];
    else if (arg === '--session') opts.session = argv[++i];
    else if (arg === '--title') opts.title = argv[++i];
    else if (arg === '--text') opts.text = argv[++i];
    else if (arg.startsWith('--')) {
      console.error(`Opsi tidak dikenal: ${arg}`);
      usage(2);
    } else if (opts.file === null) opts.file = arg;
    else {
      console.error(`Argumen berlebih: ${arg}`);
      usage(2);
    }
  }
  if (opts.file === null) usage(2);
  return opts;
}

/** deflate-raw + base64url, sama persis dengan compress() di @plannotator/core. */
async function compressPayload(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function buildShareUrl(markdown) {
  const hash = await compressPayload({ p: markdown, a: [] });
  return { url: `${SHARE_BASE}/#${hash}`, hashLength: hash.length };
}

function readPlan(file) {
  if (file === '-') return readFileSync(0, 'utf8');
  return readFileSync(path.resolve(process.cwd(), file), 'utf8');
}

function apiKey() {
  if (process.env.OPENWA_API_KEY) return process.env.OPENWA_API_KEY.trim();
  try {
    return readFileSync(path.join(ROOT, 'data', '.api-key'), 'utf8').trim();
  } catch {
    throw new Error('Kunci API tidak ditemukan: set OPENWA_API_KEY atau sediakan data/.api-key');
  }
}

async function api(pathname) {
  const response = await fetch(`${API_URL}/api${pathname}`, {
    headers: { 'X-API-Key': apiKey() },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`GET ${pathname} → HTTP ${response.status}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

async function resolveSession(name) {
  const sessions = await api('/sessions');
  const list = Array.isArray(sessions) ? sessions : [];
  const found = list.find(session => session.name === name) || (list.length === 1 ? list[0] : null);
  if (!found) {
    throw new Error(`Sesi "${name}" tidak ditemukan. Sesi tersedia: ${list.map(s => s.name).join(', ') || '(kosong)'}`);
  }
  if (found.status !== 'ready') {
    throw new Error(`Sesi "${found.name}" berstatus ${found.status}; jalankan ./scripts/up.sh atau start sesi dulu`);
  }
  return found;
}

async function sendText(sessionId, chatId, text) {
  const response = await fetch(`${API_URL}/api/sessions/${sessionId}/messages/send-text`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, text }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`send-text → HTTP ${response.status}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

const opts = parseArgs(process.argv.slice(2));
const markdown = readPlan(opts.file).trim();
if (!markdown) {
  console.error('Rencana kosong.');
  process.exit(2);
}

const { url, hashLength } = await buildShareUrl(markdown);
const title = opts.title || (opts.file === '-' ? 'Rencana' : path.basename(opts.file, path.extname(opts.file)));
const intro = opts.text || `Rencana siap direview: *${title}*`;
const message = `${intro}\n\n${url}`;

console.log(`link   : ${url}`);
console.log(`panjang: ${markdown.length} karakter markdown → ${hashLength} karakter hash, pesan ${message.length}/${MAX_TEXT_LENGTH}`);

if (message.length > MAX_TEXT_LENGTH) {
  console.error(
    `\nPesan ${message.length} karakter melebihi batas WhatsApp (${MAX_TEXT_LENGTH}). ` +
      'Pecah dokumennya, atau kirim link tanpa teks pengantar (--text "").',
  );
  process.exit(3);
}

if (opts.dryRun) {
  console.log('\n--dry-run: tidak ada yang dikirim. Pesan yang akan dikirim:\n');
  console.log(message);
  process.exit(0);
}

const session = await resolveSession(opts.session);
const number = (opts.to || process.env.OPENWA_PLAN_TO || session.phone || '').replace(/[^0-9]/g, '');
if (!number) throw new Error('Nomor tujuan tidak diketahui: pakai --to <nomor> atau set OPENWA_PLAN_TO');

const result = await sendText(session.id, `${number}@c.us`, message);
console.log(`terkirim: sesi ${session.name} → ${number}@c.us, messageId ${result?.messageId || result?.id || '(tidak dilaporkan)'}`);
