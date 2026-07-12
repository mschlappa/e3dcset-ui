from __future__ import annotations

import argparse
import json
import logging
import subprocess
from datetime import datetime, timezone
from typing import Any

from config import Settings, load_settings
from db import insert_measurement


LOGGER = logging.getLogger("e3dc_soh_monitor.measure")


def local_timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _integer(value: Any) -> int | None:
    number = _number(value)
    if number is None:
        return None
    return int(number)


def _json_from_stdout(stdout: str) -> dict[str, Any]:
    for line in stdout.splitlines():
        candidate = line.strip()
        if not candidate.startswith("{"):
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("Keine parsebare JSON-Zeile in stdout gefunden")


def build_command(settings: Settings) -> list[str]:
    cmd = [settings.e3dcset_bin]
    if settings.e3dcset_config:
        cmd.extend(["-p", settings.e3dcset_config])
    cmd.extend(settings.e3dcset_args)
    cmd.extend(["-m", str(settings.module_index), "-j"])
    return cmd


def run_e3dcset(settings: Settings) -> dict[str, Any]:
    cmd = build_command(settings)
    LOGGER.info("Starte Messung: %s", " ".join(cmd))
    completed = subprocess.run(
        cmd,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(stderr or f"e3dcset exit code {completed.returncode}")
    try:
        return _json_from_stdout(completed.stdout)
    except ValueError as exc:
        output = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(output or str(exc)) from exc


def extract_values(raw: dict[str, Any]) -> dict[str, Any]:
    data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    dcbs_raw = data.get("dcbs") if isinstance(data.get("dcbs"), list) else []

    dcbs = []
    for index, dcb in enumerate(dcbs_raw):
        if not isinstance(dcb, dict):
            continue
        dcbs.append(
            {
                "dcb_index": index,
                "soh": _number(dcb.get("BAT_DCB_SOH")),
                "cycle_count": _integer(dcb.get("BAT_DCB_CYCLE_COUNT")),
            }
        )

    return {
        "soh": _number(data.get("BAT_ASOC")),
        "rsoc": _number(data.get("BAT_RSOC")),
        "charge_cycles": _integer(data.get("BAT_CHARGE_CYCLES")),
        "dcbs": dcbs,
    }


def record_measurement(source: str, settings: Settings | None = None) -> dict[str, Any]:
    settings = settings or load_settings()
    ts = local_timestamp()
    try:
        raw = run_e3dcset(settings)
        values = extract_values(raw)
        raw_json = json.dumps(raw, ensure_ascii=False, sort_keys=True)
        measurement_id = insert_measurement(
            settings.db_path,
            ts=ts,
            source=source,
            module_index=settings.module_index,
            soh=values["soh"],
            rsoc=values["rsoc"],
            charge_cycles=values["charge_cycles"],
            raw_json=raw_json,
            ok=True,
            error=None,
            dcbs=values["dcbs"],
        )
        return {
            "id": measurement_id,
            "ok": True,
            "ts": ts,
            "source": source,
            "module_index": settings.module_index,
            **values,
        }
    except Exception as exc:
        error = str(exc)
        LOGGER.error("Messung fehlgeschlagen: %s", error)
        measurement_id = insert_measurement(
            settings.db_path,
            ts=ts,
            source=source,
            module_index=settings.module_index,
            soh=None,
            rsoc=None,
            charge_cycles=None,
            raw_json="{}",
            ok=False,
            error=error,
            dcbs=[],
        )
        return {
            "id": measurement_id,
            "ok": False,
            "ts": ts,
            "source": source,
            "module_index": settings.module_index,
            "error": error,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="E3DC SOH-Messung ausführen")
    parser.add_argument("--source", choices=["manual", "timer"], default="manual")
    args = parser.parse_args()

    settings = load_settings()
    logging.basicConfig(level=settings.log_level, format="%(levelname)s %(message)s")
    result = record_measurement(args.source, settings)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
