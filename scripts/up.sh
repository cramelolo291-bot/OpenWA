#!/usr/bin/env bash
# One command to bring OpenWA back after a VM restore: install dependencies when node_modules is
# gone, boot the gateway, wait for /api/health to answer 200, then wait until the WhatsApp session
# is ready (AUTO_START_SESSIONS=true in .env does the connecting) and print a status summary.
#
# Overridable: OPENWA_PORT (2785), OPENWA_SESSION (utama), OPENWA_HEALTH_TIMEOUT (180s),
# OPENWA_SESSION_TIMEOUT (300s), OPENWA_LOG (/tmp/openwa-api.log).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT_VALUE="${OPENWA_PORT:-2785}"
BASE="http://127.0.0.1:${PORT_VALUE}"
KEY_FILE="data/.api-key"
SESSION_NAME="${OPENWA_SESSION:-utama}"
HEALTH_TIMEOUT="${OPENWA_HEALTH_TIMEOUT:-180}"
SESSION_TIMEOUT="${OPENWA_SESSION_TIMEOUT:-300}"
LOG_FILE="${OPENWA_LOG:-/tmp/openwa-api.log}"
PID_FILE="data/gateway.pid"
DASH_PORT="${OPENWA_DASH_PORT:-3000}"
DASH_LOG="${OPENWA_DASH_LOG:-/tmp/openwa-dashboard.log}"
DASH_PID_FILE="data/dashboard.pid"
DASH_TIMEOUT="${OPENWA_DASH_TIMEOUT:-120}"
# The *.style.dev preview hostname changes on every VM restore and is only known to the Freebuff
# tooling, so the script reads it from OPENWA_PREVIEW_HOST or the copy saved at data/preview-host.
PREVIEW_HOSTS="${OPENWA_PREVIEW_HOST:-}"
if [ -s data/preview-hosts ]; then
  saved_hosts="$(tr '\n' ',' <data/preview-hosts | sed 's/,,*/,/g; s/,$//')"
  if [ -n "$saved_hosts" ]; then
    if [ -n "$PREVIEW_HOSTS" ]; then PREVIEW_HOSTS="${PREVIEW_HOSTS},${saved_hosts}"; else PREVIEW_HOSTS="$saved_hosts"; fi
  fi
fi
# The link printed in the summary is the most recently recorded hostname.
PREVIEW_HOST="$(printf '%s' "$PREVIEW_HOSTS" | tr ',' '\n' | tail -n 1)"

say() { printf '%s\n' "$*"; }
warn() { printf 'PERINGATAN: %s\n' "$*" >&2; }
die() { printf 'GAGAL: %s\n' "$*" >&2; exit "${2:-1}"; }

health_code() {
  curl -s -m 5 -o /dev/null -w '%{http_code}' "${BASE}/api/health" 2>/dev/null || echo 000
}
api_key() {
  if [ -s "$KEY_FILE" ]; then tr -d '\r\n' <"$KEY_FILE"; fi
}
api_get() {
  local path="$1" key
  key="$(api_key)"
  if [ -n "$key" ]; then
    curl -s -m 10 -H "X-API-Key: ${key}" "${BASE}${path}" || true
  else
    curl -s -m 10 "${BASE}${path}" || true
  fi
}

# --- dependencies ------------------------------------------------------------------------------
if [ ! -d node_modules ]; then
  command -v npm >/dev/null 2>&1 || die "npm tidak ada di PATH"
  say "dependensi: node_modules hilang, menjalankan npm ci (bisa 1-2 menit) ..."
  npm ci --no-audit --no-fund || die "npm ci gagal — lihat output di atas"
else
  say "dependensi: sudah terpasang"
fi

if [ ! -d dashboard/node_modules ]; then
  command -v npm >/dev/null 2>&1 || die "npm ada di PATH? tidak ditemukan"
  say "dasbor: dashboard/node_modules hilang, menjalankan npm ci di dashboard ..."
  (cd dashboard && npm ci --no-audit --no-fund) || die "npm ci di dashboard gagal — lihat output di atas"
else
  say "dasbor: dependensi sudah terpasang"
fi

# --- gateway ------------------------------------------------------------------------------------
if [ "$(health_code)" = "200" ]; then
  say "gateway: sudah hidup di ${BASE} (tidak dinyalakan ulang)"
  STARTED="dipakai ulang"
else
  STARTED="baru dinyalakan"
  if [ ! -f .env ]; then
    warn ".env tidak ada — gateway kemungkinan gagal boot. Salin .env.minimal ke .env lalu sesuaikan."
  fi
  mkdir -p data
  say "gateway: menyalakan (log: ${LOG_FILE}) ..."
  setsid nohup npm run start >>"$LOG_FILE" 2>&1 </dev/null &
  echo $! >"$PID_FILE"
fi

deadline=$((SECONDS + HEALTH_TIMEOUT))
while [ "$(health_code)" != "200" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    tail -n 20 "$LOG_FILE" >&2 2>/dev/null || true
    die "health tidak 200 setelah ${HEALTH_TIMEOUT}s (log: ${LOG_FILE})" 2
  fi
  sleep 3
done
say "gateway: health 200"

# --- session ------------------------------------------------------------------------------------
if [ -z "$(api_key)" ]; then
  warn "${KEY_FILE} kosong — status sesi tidak bisa dibaca. Isi kunci gateway lalu jalankan ulang."
  exit 3
fi

status="" name="" phone="" err=""
deadline=$((SECONDS + SESSION_TIMEOUT))
while :; do
  line="$(api_get /api/sessions | node -e '
    let raw = "";
    process.stdin.on("data", d => (raw += d)).on("end", () => {
      try {
        const list = JSON.parse(raw);
        const want = process.argv[1];
        const rows = Array.isArray(list) ? list : [];
        const s = rows.find(r => r.name === want) || rows[0];
        if (!s) { console.log("tidak-ada||||"); return; }
        console.log([s.status, s.name, s.phone || "-", s.lastError || "-"].join("|"));
      } catch {
        console.log("tidak-terbaca||||");
      }
    });' "$SESSION_NAME" 2>/dev/null || echo "tidak-terbaca||||")"

  status="${line%%|*}"
  rest="${line#*|}"
  name="${rest%%|*}"
  rest="${rest#*|}"
  phone="${rest%%|*}"
  err="${rest#*|}"

  [ "$status" = "ready" ] && break

  if [ "$SECONDS" -ge "$deadline" ]; then
    say "sesi: ${name:-$SESSION_NAME} belum ready (status: ${status:-?}) setelah ${SESSION_TIMEOUT}s"
    [ "$err" != "-" ] && [ -n "$err" ] && say "       error terakhir: ${err}"
    say "       lihat ${LOG_FILE}; cek juga sesi di dashboard."
    exit 4
  fi
  sleep 3
done
say "sesi: ${name} ready (${phone})"

# --- dashboard ----------------------------------------------------------------------------------
DASH_OK=1
DASH_STATE=""
dash_code() {
  curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${DASH_PORT}/" 2>/dev/null || echo 000
}

if [ "$(dash_code)" = "200" ]; then
  say "dasbor: dev server sudah hidup di port ${DASH_PORT} (tidak dinyalakan ulang)"
  DASH_STATE="dipakai ulang"
else
  say "dasbor: menyalakan Vite di port ${DASH_PORT} (log: ${DASH_LOG}) ..."
  (
    cd dashboard
    if [ -n "$PREVIEW_HOST" ]; then
      env __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="$PREVIEW_HOSTS" \
        setsid nohup npx vite --host 0.0.0.0 --port "$DASH_PORT" --strictPort >>"$DASH_LOG" 2>&1 </dev/null &
    else
      setsid nohup npx vite --host 0.0.0.0 --port "$DASH_PORT" --strictPort >>"$DASH_LOG" 2>&1 </dev/null &
    fi
    echo $! >"../${DASH_PID_FILE}"
  )
  DASH_STATE="baru dinyalakan"
  dash_deadline=$((SECONDS + DASH_TIMEOUT))
  while [ "$(dash_code)" != "200" ]; do
    if [ "$SECONDS" -ge "$dash_deadline" ]; then
      tail -n 20 "$DASH_LOG" >&2 2>/dev/null || true
      warn "Vite tidak menjawab 200 di port ${DASH_PORT} setelah ${DASH_TIMEOUT}s (log: ${DASH_LOG})"
      DASH_OK=0
      break
    fi
    sleep 2
  done
fi
if [ "$DASH_OK" = "1" ]; then say "dasbor: HTTP 200 di port ${DASH_PORT}"; fi

# --- summary ------------------------------------------------------------------------------------
plugin_line="$(api_get /api/plugins | node -e '
  let raw = "";
  process.stdin.on("data", d => (raw += d)).on("end", () => {
    try {
      const j = JSON.parse(raw);
      const list = Array.isArray(j) ? j : j.data || j.plugins || j.items || [];
      const p = list.find(x => x.id === "personal-assistant");
      if (!p) { console.log("belum terpasang"); return; }
      const c = p.config || {};
      const provider = [c.model, c.apiBaseUrl].filter(Boolean).join(" @ ") || "belum dikonfigurasi";
      const keyState = c.apiKey ? "terisi" : "kosong";
      console.log(`${p.name || p.id} v${p.version} — status ${p.status}, kunci API provider ${keyState} (${provider})`);
    } catch {
      console.log("tidak terbaca");
    }
  });' 2>/dev/null || echo "tidak terbaca")"

gateway_note="${STARTED:-baru dinyalakan}"
if [ -f "$PID_FILE" ]; then gateway_note="${gateway_note}, pid $(cat "$PID_FILE" 2>/dev/null || echo '?')"; fi

say ""
say "Ringkasan"
say "  gateway : HTTP 200 — ${BASE} (${gateway_note})"
say "  sesi    : ${name} ready, nomor ${phone}"
say "  plugin  : ${plugin_line}"
if [ "$DASH_OK" = "1" ]; then
  say "  dasbor  : HTTP 200 — http://127.0.0.1:${DASH_PORT} (${DASH_STATE})"
  if [ -n "$PREVIEW_HOST" ]; then
    say "  preview : https://${PREVIEW_HOST}/"
  else
    say "  preview : host belum diketahui — buka panel Browser, atau set OPENWA_PREVIEW_HOST=<hostname>"
  fi
else
  say "  dasbor  : GAGAL menyala — lihat ${DASH_LOG}"
fi
say "  log     : ${LOG_FILE}"
if [ -s data/assistant-key ]; then
  say "  provider: kunci siap — jalankan: node scripts/configure-assistant-provider.mjs groq"
else
  say "  provider: data/assistant-key belum ada; plugin menunggu kunci"
fi

[ "$DASH_OK" = "1" ] || exit 5
