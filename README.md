# E3DC SOH-Monitor

Lokale Web-App zur Langzeit-Überwachung der Batterie-Gesundheit eines E3DC S10. Die App ruft `e3dcset -m 0 -j` auf, speichert jede Messung in SQLite und zeigt den Verlauf im Browser.

## Funktionen

- Manuelle Messung per Button
- Tägliche Messung per systemd-User-Timer
- Verlauf für Gesamt-SOH und DCB-Zellblöcke
- Lokale SQLite-Datenbank mit Roh-JSON jeder Messung
- Bind nur an `127.0.0.1`

## Installation

```bash
cd /opt
sudo git clone <repo-url> e3dc-soh-monitor
sudo chown -R "$USER:$USER" /opt/e3dc-soh-monitor
cd /opt/e3dc-soh-monitor

python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Falls du nicht nach `/opt` installieren willst, passe die systemd-Units entsprechend an.

## Konfiguration

Die App liest Umgebungsvariablen. Für systemd liegt die optionale Datei hier:

```bash
mkdir -p ~/.config/e3dc-soh-monitor
nano ~/.config/e3dc-soh-monitor/env
```

Beispiel:

```ini
E3DCSET_BIN=/usr/local/bin/e3dcset
E3DCSET_CONFIG=/etc/e3dcset/e3dcset.config
E3DCSET_ARGS=
E3DC_BATTERY_MODULE=0
E3DC_SOH_PORT=8321
```

`E3DCSET_CONFIG` ist optional. Wenn `e3dcset` seine Config selbst findet, kann die Variable leer bleiben.

## Erste Messung testen

```bash
cd /opt/e3dc-soh-monitor
. .venv/bin/activate
python measure.py --source manual
```

Bei Erfolg entsteht die Datenbank unter `~/.local/share/e3dc-soh-monitor/soh.db`. Bei Fehlern wird trotzdem eine Messung mit `ok=0` und Fehlertext gespeichert.

## Web-App starten

```bash
cd /opt/e3dc-soh-monitor
. .venv/bin/activate
uvicorn app:app --host 127.0.0.1 --port 8321
```

Browser: <http://127.0.0.1:8321>

## systemd-User-Services

```bash
mkdir -p ~/.config/systemd/user
cp systemd/e3dc-soh-measure.service ~/.config/systemd/user/
cp systemd/e3dc-soh-measure.timer ~/.config/systemd/user/
cp systemd/e3dc-soh-web.service ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now e3dc-soh-measure.timer
systemctl --user enable --now e3dc-soh-web.service
```

Timer prüfen:

```bash
systemctl --user list-timers e3dc-soh-measure.timer
journalctl --user -u e3dc-soh-measure.service -n 100 --no-pager
```

Wenn die Messung auch ohne aktive Desktop-Session laufen soll:

```bash
loginctl enable-linger "$USER"
```

## API

- `GET /api/health`
- `GET /api/latest`
- `GET /api/history?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/recent`
- `POST /api/measure`

Die App ist für localhost gedacht. Keine Authentifizierung, kein LAN-Expose.
