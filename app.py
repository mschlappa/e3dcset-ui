from __future__ import annotations

import logging
import shutil
import stat
import threading
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

import db
from config import load_settings
from measure import record_measurement


settings = load_settings()
logging.basicConfig(level=settings.log_level, format="%(levelname)s %(message)s")

app = FastAPI(title="E3DC SOH-Monitor")
measure_lock = threading.Lock()
static_dir = Path(__file__).resolve().parent / "static"


@app.on_event("startup")
def startup() -> None:
    db.init_db(settings.db_path)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(static_dir / "index.html")


@app.get("/favicon.ico")
def favicon() -> Response:
    return Response(status_code=204)


app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.post("/api/measure")
def measure_now() -> dict:
    if not measure_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail={"error": "Messung läuft bereits"})
    try:
        result = record_measurement("manual", settings)
    finally:
        measure_lock.release()

    if not result["ok"]:
        raise HTTPException(
            status_code=502,
            detail={"ok": False, "error": result.get("error", "Messung fehlgeschlagen")},
        )
    return {"ok": True, "measurement": serialize_measurement(result)}


@app.get("/api/latest")
def latest() -> dict:
    measurement = db.latest_success(settings.db_path)
    last_error = db.latest_error_after_success(settings.db_path)
    return {
        "measurement": serialize_measurement(measurement) if measurement else None,
        "last_error": last_error,
    }


@app.get("/api/history")
def history(
    date_from: Optional[str] = Query(default=None, alias="from"),
    date_to: Optional[str] = Query(default=None, alias="to"),
) -> dict:
    return db.history(settings.db_path, date_from=date_from, date_to=date_to)


@app.get("/api/recent")
def recent() -> dict:
    return {"measurements": [serialize_measurement(row) for row in db.recent_measurements(settings.db_path)]}


@app.get("/api/health")
def health() -> dict:
    info = db.health(settings.db_path)
    binary_path = shutil.which(settings.e3dcset_bin) or settings.e3dcset_bin
    path = Path(binary_path)
    exists = path.exists()
    executable = exists and bool(path.stat().st_mode & stat.S_IXUSR)
    return {
        **info,
        "bind": f"{settings.host}:{settings.port}",
        "e3dcset_bin": settings.e3dcset_bin,
        "e3dcset_bin_resolved": str(path),
        "e3dcset_bin_exists": exists,
        "e3dcset_bin_executable": executable,
        "e3dcset_config": settings.e3dcset_config,
        "module_index": settings.module_index,
    }


def serialize_measurement(measurement: Optional[dict]) -> Optional[dict]:
    if measurement is None:
        return None
    return {
        "ts": measurement.get("ts"),
        "source": measurement.get("source"),
        "module_index": measurement.get("module_index"),
        "soh": measurement.get("soh"),
        "rsoc": measurement.get("rsoc"),
        "charge_cycles": measurement.get("charge_cycles"),
        "ok": measurement.get("ok", 1),
        "error": measurement.get("error"),
        "dcbs": measurement.get("dcbs", []),
    }


def main() -> None:
    uvicorn.run("app:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
