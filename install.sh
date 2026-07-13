#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="E3DC SOH Monitor"
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/e3dc-soh-monitor"
ENV_FILE="$ENV_DIR/env"
SYSTEMD_DIR="$HOME/.config/systemd/user"

ASSUME_YES=0
SKIP_SYSTEMD=0
SKIP_MEASURE=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --no-systemd) SKIP_SYSTEMD=1 ;;
    --no-measure) SKIP_MEASURE=1 ;;
    -h|--help)
      cat <<'EOF'
Installiert den E3DC SOH Monitor im aktuellen Ordner.

Optionen:
  -y, --yes        Rückfragen automatisch mit Ja beantworten
  --no-systemd    systemd-User-Services nicht einrichten
  --no-measure    erste Testmessung überspringen
  -h, --help      Hilfe anzeigen
EOF
      exit 0
      ;;
    *) printf 'Unbekannte Option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

info() {
  printf '\033[1;34m==>\033[0m %s\n' "$1"
}

ok() {
  printf '\033[1;32m✓\033[0m %s\n' "$1"
}

warn() {
  printf '\033[1;33m!\033[0m %s\n' "$1"
}

fail() {
  printf '\033[1;31mFehler:\033[0m %s\n' "$1" >&2
  exit 1
}

trap 'rc=$?; fail "Unerwarteter Abbruch in Zeile $LINENO (Exit $rc)"' ERR

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

ask_yes_no() {
  local prompt="$1"
  local default="${2:-n}"
  local answer

  if [[ "$ASSUME_YES" -eq 1 ]]; then
    [[ "$default" == "y" ]]
    return
  fi

  if [[ "$default" == "y" ]]; then
    read -r -p "$prompt [J/n] " answer
    [[ -z "$answer" || "$answer" =~ ^[JjYy]$ ]]
  else
    read -r -p "$prompt [j/N] " answer
    [[ "$answer" =~ ^[JjYy]$ ]]
  fi
}

python_major_minor() {
  "$1" - <<'PY'
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}")
PY
}

python_is_supported() {
  "$1" - <<'PY'
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
}

first_existing_executable() {
  local candidate
  for candidate in "$@"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

first_existing_file() {
  local candidate
  for candidate in "$@"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

find_home_file() {
  local name="$1"
  find "$HOME" -maxdepth 5 -type f -name "$name" -print -quit 2>/dev/null
}

find_home_executable() {
  local name="$1"
  find "$HOME" -maxdepth 5 -type f -name "$name" -perm -u+x -print -quit 2>/dev/null
}

env_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\$}"
  value="${value//\`/\\\`}"
  printf '"%s"' "$value"
}

shell_arg_quote() {
  local value="$1"
  value="${value//\'/\'\\\'\'}"
  printf "'%s'" "$value"
}

env_file_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { value=$0; sub(/^[^=]*=/, "", value); print value }' "$ENV_FILE" |
    tail -n 1 |
    sed -E 's/^"(.*)"$/\1/'
}

install_debian_packages_if_wanted() {
  if ! command_exists apt-get || ! command_exists sudo; then
    return 0
  fi

  if ask_yes_no "Benötigte Debian/Ubuntu-Pakete jetzt installieren?" "y"; then
    sudo apt-get update
    sudo apt-get install -y python3 python3-venv
  fi
}

write_env_file() {
  local e3dcset_bin="$1"
  local e3dcset_config="$2"
  local e3dcset_tags="$3"
  local e3dcset_args=""

  mkdir -p "$ENV_DIR"
  if [[ -n "$e3dcset_tags" ]]; then
    e3dcset_args="-t $(shell_arg_quote "$e3dcset_tags")"
  fi

  cat > "$ENV_FILE" <<EOF
E3DCSET_BIN=$(env_quote "$e3dcset_bin")
E3DCSET_CONFIG=$(env_quote "$e3dcset_config")
E3DCSET_ARGS=$(env_quote "$e3dcset_args")
E3DC_BATTERY_MODULE=0
E3DC_SOH_HOST=127.0.0.1
E3DC_SOH_PORT=8321
EOF
}

install_systemd_units() {
  mkdir -p "$SYSTEMD_DIR"

  cat > "$SYSTEMD_DIR/e3dc-soh-web.service" <<EOF
[Unit]
Description=E3DC SOH Monitor Web-App

[Service]
Type=simple
WorkingDirectory=$(env_quote "$APP_DIR")
EnvironmentFile=-$(env_quote "$ENV_FILE")
ExecStart=$(env_quote "$APP_DIR/.venv/bin/python") $(env_quote "$APP_DIR/app.py")
Restart=on-failure

[Install]
WantedBy=default.target
EOF

  cat > "$SYSTEMD_DIR/e3dc-soh-measure.service" <<EOF
[Unit]
Description=E3DC SOH Messung

[Service]
Type=oneshot
WorkingDirectory=$(env_quote "$APP_DIR")
EnvironmentFile=-$(env_quote "$ENV_FILE")
ExecStart=$(env_quote "$APP_DIR/.venv/bin/python") $(env_quote "$APP_DIR/measure.py") --source timer
EOF

  cat > "$SYSTEMD_DIR/e3dc-soh-measure.timer" <<'EOF'
[Unit]
Description=Tägliche E3DC SOH Messung

[Timer]
OnCalendar=*-*-* 06:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now e3dc-soh-web.service
  systemctl --user enable --now e3dc-soh-measure.timer
}

warn_if_port_is_busy() {
  local port
  port="$(env_file_value E3DC_SOH_PORT)"
  port="${port:-8321}"
  if command_exists ss && ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port"; then
    warn "Port $port ist belegt. Falls die App bereits manuell läuft, kann der Service-Start fehlschlagen."
  fi
}

info "Installiere $APP_NAME"

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  fail "Bitte nicht mit sudo/root ausführen. Starte das Skript als normaler Benutzer."
fi

if [[ ! -f "$APP_DIR/requirements.txt" || ! -f "$APP_DIR/measure.py" || ! -f "$APP_DIR/app.py" ]]; then
  fail "Das sieht nicht nach dem e3dc-soh-monitor Projektordner aus."
fi

if ! command_exists python3; then
  warn "python3 fehlt."
  install_debian_packages_if_wanted
fi

command_exists python3 || fail "python3 fehlt weiterhin. Installiere Python 3.10+ und starte erneut."

PYTHON_VERSION="$(python_major_minor python3)"
python_is_supported python3 || fail "Python $PYTHON_VERSION ist zu alt. Benötigt wird Python 3.10 oder neuer."
ok "Python $PYTHON_VERSION"

info "Python-Umgebung vorbereiten"
if [[ -d "$APP_DIR/.venv" ]] && ! "$APP_DIR/.venv/bin/python" --version >/dev/null 2>&1; then
  warn "Vorhandene .venv ist unvollständig; sie wird neu erstellt."
  python3 -m venv --clear "$APP_DIR/.venv"
fi

python3 -m venv "$APP_DIR/.venv" || {
  warn "Virtuelle Umgebung konnte nicht erstellt werden. Auf Debian/Ubuntu fehlt oft python3-venv."
  install_debian_packages_if_wanted
  python3 -m venv "$APP_DIR/.venv"
}

"$APP_DIR/.venv/bin/python" -m pip install --upgrade pip
"$APP_DIR/.venv/bin/python" -m pip install -r "$APP_DIR/requirements.txt"
ok "Python-Abhängigkeiten installiert"

if [[ -f "$ENV_FILE" ]]; then
  ok "Konfiguration existiert bereits: $ENV_FILE"
else
  E3DCSET_FROM_PATH="$(command -v e3dcset || true)"
  E3DCSET_FROM_HOME="$(find_home_executable e3dcset)"
  E3DCSET_BIN="$(first_existing_executable \
    "$E3DCSET_FROM_PATH" \
    "$HOME/projects/e3dcset/e3dcset" \
    "$HOME/projects/e3dcset-fork/e3dcset" \
    "$HOME/e3dcset/e3dcset" \
    "$E3DCSET_FROM_HOME" \
    /opt/keba-wallbox/e3dcset \
    /usr/local/bin/e3dcset \
    /usr/bin/e3dcset \
    || true)"
  E3DCSET_CONFIG_FROM_HOME="$(find_home_file e3dcset.config)"
  E3DCSET_CONFIG="$(first_existing_file \
    "$HOME/projects/e3dcset/e3dcset.config" \
    "$HOME/projects/e3dcset-fork/e3dcset.config" \
    "$HOME/e3dcset/e3dcset.config" \
    "$E3DCSET_CONFIG_FROM_HOME" \
    /opt/keba-wallbox/e3dcset.config \
    /etc/e3dcset/e3dcset.config \
    /etc/e3dcset.config \
    || true)"
  E3DCSET_TAGS_FROM_HOME="$(find_home_file e3dcset.tags)"
  E3DCSET_TAGS="$(first_existing_file \
    "$HOME/projects/e3dcset/e3dcset.tags" \
    "$HOME/projects/e3dcset-fork/e3dcset.tags" \
    "$HOME/e3dcset/e3dcset.tags" \
    "$E3DCSET_TAGS_FROM_HOME" \
    /opt/keba-wallbox/e3dcset.tags \
    /etc/e3dcset/e3dcset.tags \
    /usr/local/share/e3dcset/e3dcset.tags \
    || true)"

  if [[ -z "$E3DCSET_BIN" ]]; then
    warn "e3dcset wurde nicht automatisch gefunden."
    if [[ "$ASSUME_YES" -eq 1 || ! -t 0 ]]; then
      E3DCSET_BIN="/usr/local/bin/e3dcset"
      warn "Verwende Default: $E3DCSET_BIN. Bitte bei Bedarf in $ENV_FILE korrigieren."
    else
      read -r -p "Pfad zu e3dcset eingeben [/usr/local/bin/e3dcset]: " E3DCSET_BIN
      E3DCSET_BIN="${E3DCSET_BIN:-/usr/local/bin/e3dcset}"
    fi
  fi

  if [[ -z "$E3DCSET_CONFIG" ]]; then
    warn "Keine e3dcset.config gefunden. Das ist ok, wenn e3dcset seine Config selbst findet; sonst E3DCSET_CONFIG in $ENV_FILE setzen."
  fi
  if [[ -z "$E3DCSET_TAGS" ]]; then
    warn "Keine e3dcset.tags gefunden. Das ist ok, wenn e3dcset ohne explizite Tag-Datei funktioniert; sonst E3DCSET_ARGS in $ENV_FILE setzen."
  fi

  write_env_file "$E3DCSET_BIN" "$E3DCSET_CONFIG" "$E3DCSET_TAGS"
  ok "Konfiguration erstellt: $ENV_FILE"
  warn "Bitte prüfe diese Datei, falls e3dcset andere Pfade oder Argumente braucht."
fi

if [[ "$SKIP_MEASURE" -eq 0 ]]; then
  if ask_yes_no "Jetzt eine erste E3DC-SOH-Testmessung ausführen?" "y"; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    if "$APP_DIR/.venv/bin/python" "$APP_DIR/measure.py" --source manual; then
      ok "Testmessung erfolgreich"
    else
      warn "Testmessung fehlgeschlagen. Die Installation ist trotzdem fertig; prüfe $ENV_FILE und e3dcset."
    fi
  fi
fi

if [[ "$SKIP_SYSTEMD" -eq 0 ]]; then
  if command_exists systemctl; then
    if ! systemctl --user show-environment >/dev/null 2>&1; then
      warn "systemd --user ist in dieser Session nicht verfügbar; Autostart wird übersprungen."
    elif ask_yes_no "Web-App und tägliche Messung als systemd-User-Service einrichten?" "y"; then
      warn_if_port_is_busy
      install_systemd_units
      ok "systemd-User-Services aktiviert"
      if command_exists loginctl && ask_yes_no "Messungen auch ohne aktive Login-Session ermöglichen?" "n"; then
        loginctl enable-linger "$USER"
        ok "Linger für $USER aktiviert"
      else
        warn "Ohne Linger laufen systemd-User-Timer nur zuverlässig bei aktiver Benutzer-Session."
      fi
    fi
  else
    warn "systemctl nicht gefunden; Autostart wird übersprungen."
  fi
fi

ok "$APP_NAME ist eingerichtet."
printf '\nManuell starten:\n'
printf '  cd %s\n' "$APP_DIR"
printf '  . .venv/bin/activate\n'
printf '  python app.py\n\n'
printf 'Browser:\n'
printf '  http://127.0.0.1:8321\n\n'
printf 'Status bei systemd-Installation:\n'
printf '  systemctl --user status e3dc-soh-web.service\n'
printf '  systemctl --user list-timers e3dc-soh-measure.timer\n'
