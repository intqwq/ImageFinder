#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
INSTALL_DIR=${PIXELTRACE_INSTALL_DIR:-/opt/pixeltrace}
PORT=${PIXELTRACE_PORT:-18103}

if [[ ! ${PORT} =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "PIXELTRACE_PORT must be a valid TCP port." >&2
  exit 1
fi
if ! command -v python3 >/dev/null; then
  echo "Python 3 is required." >&2
  exit 1
fi
if ! command -v bridge >/dev/null; then
  echo "Bridge is not installed. Install https://github.com/intqwq/Bridge first." >&2
  exit 1
fi

if ! id pixeltrace >/dev/null 2>&1; then
  useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin pixeltrace
fi

install -d -o root -g root -m 0755 "${INSTALL_DIR}"
for file in index.html styles.css app.js matcher-core.js server.py; do
  install -o root -g root -m 0644 "${REPO_DIR}/${file}" "${INSTALL_DIR}/${file}"
done
sed "s#http://127.0.0.1:18103#http://127.0.0.1:${PORT}#" \
  "${REPO_DIR}/bridge-registration.json" > "${INSTALL_DIR}/bridge-registration.json"
chmod 0644 "${INSTALL_DIR}/bridge-registration.json"

install -o root -g root -m 0644 "${REPO_DIR}/deploy/pixeltrace.service" /etc/systemd/system/pixeltrace.service
printf 'PIXELTRACE_PORT=%s\n' "${PORT}" > /etc/default/pixeltrace
chmod 0644 /etc/default/pixeltrace

systemctl daemon-reload
systemctl enable --now pixeltrace.service

for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null
bridge register "${INSTALL_DIR}/bridge-registration.json"

echo "PixelTrace is healthy and registered at https://pixeltrace.intqwq.com"
