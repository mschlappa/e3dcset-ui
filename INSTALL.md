# Installation für Einsteiger

Diese Anleitung installiert `e3dcset-ui` auf einem Linux-Rechner, auf dem `e3dcset` bereits installiert und funktionsfähig ist.

Die App selbst steuert den E3DC nicht. Sie liest nur den Batterie-Modul-Dump aus, speichert Messungen in SQLite und zeigt den Verlauf im Browser.

## 1. Vorher prüfen: Funktioniert e3dcset?

Melde dich auf dem Zielrechner an und teste zuerst `e3dcset`.

Ein einfacher Test ist:

```bash
e3dcset -m 0 -j
```

Falls dein `e3dcset` eine Config-Datei und eine Tag-Datei braucht, sieht der Test eher so aus:

```bash
/opt/keba-wallbox/e3dcset \
  -p /opt/keba-wallbox/e3dcset.config \
  -t /opt/keba-wallbox/e3dcset.tags \
  -m 0 -j
```

Wichtig ist: Am Ende muss eine JSON-Ausgabe mit Batterie-Werten erscheinen. Wenn dieser Schritt nicht funktioniert, wird auch die Web-App noch keine echten Werte lesen können.

## 2. Benötigte Pakete installieren

Auf Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y git python3 python3-venv
```

## 3. App nach /opt installieren

```bash
cd /opt
sudo git clone https://github.com/mschlappa/e3dcset-ui.git
sudo chown -R "$USER:$USER" e3dcset-ui
cd e3dcset-ui
```

Python-Umgebung anlegen:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

## 4. Pfade konfigurieren

Die App liest ihre Konfiguration aus einer kleinen Environment-Datei:

```bash
mkdir -p ~/.config/e3dc-soh-monitor
nano ~/.config/e3dc-soh-monitor/env
```

Beispiel, wenn `e3dcset` direkt im Suchpfad liegt:

```ini
E3DCSET_BIN=/usr/local/bin/e3dcset
E3DC_BATTERY_MODULE=0
E3DC_SOH_PORT=8321
```

Beispiel mit expliziter Config- und Tag-Datei:

```ini
E3DCSET_BIN=/opt/keba-wallbox/e3dcset
E3DCSET_CONFIG=/opt/keba-wallbox/e3dcset.config
E3DCSET_ARGS="-t /opt/keba-wallbox/e3dcset.tags"
E3DC_BATTERY_MODULE=0
E3DC_SOH_PORT=8321
```

Optional kannst du den Datenbankpfad festlegen:

```ini
E3DC_SOH_DB=/srv/e3dcset-ui-data/soh.db
```

Wenn du `E3DC_SOH_DB` nicht setzt, nutzt die App automatisch:

```text
~/.local/share/e3dc-soh-monitor/soh.db
```

## 5. Erste Messung testen

```bash
cd /opt/e3dcset-ui
set -a
. ~/.config/e3dc-soh-monitor/env
set +a
. .venv/bin/activate
python measure.py --source manual
```

Bei Erfolg siehst du JSON mit `ok: true`, zum Beispiel:

```json
{"ok": true, "soh": 100.0, "rsoc": 100.0, "charge_cycles": 139}
```

Wenn `ok: false` erscheint, speichert die App den Fehler trotzdem in der Datenbank. Die Fehlermeldung zeigt meistens direkt, welcher Pfad oder welcher E3DC-Zugriff noch nicht stimmt.

## 6. Web-App manuell starten

Nur auf dem Rechner selbst verfügbar:

```bash
cd /opt/e3dcset-ui
set -a
. ~/.config/e3dc-soh-monitor/env
set +a
. .venv/bin/activate
uvicorn app:app --host 127.0.0.1 --port 8321
```

Dann im Browser öffnen:

```text
http://127.0.0.1:8321
```

Im Heimnetz verfügbar machen:

```bash
uvicorn app:app --host 0.0.0.0 --port 8321
```

Dann öffnest du im Browser eines anderen Geräts:

```text
http://<ip-des-linux-rechners>:8321
```

Nutze `0.0.0.0` nur in einem vertrauenswürdigen lokalen Netz. Die App hat bewusst keine Anmeldung.

## 7. Automatisch starten mit systemd

Die mitgelieferten Units gehen davon aus, dass die App unter `/opt/e3dcset-ui` installiert ist.

```bash
mkdir -p ~/.config/systemd/user
cp systemd/e3dc-soh-measure.service ~/.config/systemd/user/
cp systemd/e3dc-soh-measure.timer ~/.config/systemd/user/
cp systemd/e3dc-soh-web.service ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now e3dc-soh-web.service
systemctl --user enable --now e3dc-soh-measure.timer
```

Status prüfen:

```bash
systemctl --user status e3dc-soh-web.service
systemctl --user list-timers e3dc-soh-measure.timer
```

Logs ansehen:

```bash
journalctl --user -u e3dc-soh-web.service -n 100 --no-pager
journalctl --user -u e3dc-soh-measure.service -n 100 --no-pager
```

## 8. Tägliche Messung

Der Timer misst täglich gegen 06:00 Uhr:

```ini
OnCalendar=*-*-* 06:00:00
Persistent=true
RandomizedDelaySec=300
```

`Persistent=true` bedeutet: Wenn der Rechner um 06:00 Uhr aus war, wird die Messung beim nächsten Start nachgeholt.

## 9. Häufige Fehler

### e3dcset wird nicht gefunden

Setze `E3DCSET_BIN` auf den vollständigen Pfad:

```ini
E3DCSET_BIN=/opt/keba-wallbox/e3dcset
```

### Tag-Datei wird nicht gefunden

Setze `E3DCSET_ARGS` mit `-t`:

```ini
E3DCSET_ARGS="-t /opt/keba-wallbox/e3dcset.tags"
```

Die Anführungszeichen sind wichtig, weil der Wert ein Leerzeichen enthält.

### Config-Datei wird nicht gefunden

Setze:

```ini
E3DCSET_CONFIG=/pfad/zur/e3dcset.config
```

### Web-App ist von einem anderen Gerät nicht erreichbar

Prüfe, ob die App wirklich auf `0.0.0.0` läuft:

```bash
ss -ltnp | grep 8321
```

Prüfe außerdem Firewall und IP-Adresse:

```bash
ip -4 addr
```

### systemd-User-Service läuft nach Logout nicht weiter

Aktiviere Linger:

```bash
loginctl enable-linger "$USER"
```

Je nach Distribution kann dafür `sudo` nötig sein.
