from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "1"


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(db_path: Path) -> None:
    with connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
              key TEXT PRIMARY KEY,
              value TEXT
            );

            CREATE TABLE IF NOT EXISTS measurement (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TEXT NOT NULL,
              source TEXT NOT NULL,
              module_index INTEGER NOT NULL DEFAULT 0,
              soh REAL,
              rsoc REAL,
              charge_cycles INTEGER,
              raw_json TEXT NOT NULL,
              ok INTEGER NOT NULL DEFAULT 1,
              error TEXT
            );

            CREATE TABLE IF NOT EXISTS dcb_measurement (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              measurement_id INTEGER NOT NULL REFERENCES measurement(id) ON DELETE CASCADE,
              dcb_index INTEGER NOT NULL,
              soh REAL,
              cycle_count INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_measurement_ts ON measurement(ts);
            CREATE INDEX IF NOT EXISTS idx_dcb_mid ON dcb_measurement(measurement_id);
            """
        )
        conn.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', ?)",
            (SCHEMA_VERSION,),
        )


def insert_measurement(
    db_path: Path,
    *,
    ts: str,
    source: str,
    module_index: int,
    soh: float | None,
    rsoc: float | None,
    charge_cycles: int | None,
    raw_json: str,
    ok: bool,
    error: str | None,
    dcbs: list[dict[str, Any]],
) -> int:
    init_db(db_path)
    with connect(db_path) as conn:
        cur = conn.execute(
            """
            INSERT INTO measurement(
              ts, source, module_index, soh, rsoc, charge_cycles, raw_json, ok, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                ts,
                source,
                module_index,
                soh,
                rsoc,
                charge_cycles,
                raw_json,
                1 if ok else 0,
                error,
            ),
        )
        measurement_id = int(cur.lastrowid)
        for dcb in dcbs:
            conn.execute(
                """
                INSERT INTO dcb_measurement(measurement_id, dcb_index, soh, cycle_count)
                VALUES (?, ?, ?, ?)
                """,
                (
                    measurement_id,
                    dcb.get("dcb_index"),
                    dcb.get("soh"),
                    dcb.get("cycle_count"),
                ),
            )
        return measurement_id


def _dcbs_for(conn: sqlite3.Connection, measurement_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT dcb_index, soh, cycle_count
        FROM dcb_measurement
        WHERE measurement_id = ?
        ORDER BY dcb_index
        """,
        (measurement_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def latest_success(db_path: Path) -> dict[str, Any] | None:
    init_db(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT id, ts, source, module_index, soh, rsoc, charge_cycles
            FROM measurement
            WHERE ok = 1
            ORDER BY ts DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["dcbs"] = _dcbs_for(conn, row["id"])
        return result


def latest_error_after_success(db_path: Path) -> dict[str, Any] | None:
    init_db(db_path)
    with connect(db_path) as conn:
        latest_ok = conn.execute(
            "SELECT ts FROM measurement WHERE ok = 1 ORDER BY ts DESC, id DESC LIMIT 1"
        ).fetchone()
        params: tuple[Any, ...] = ()
        where = "ok = 0"
        if latest_ok is not None:
            where += " AND ts > ?"
            params = (latest_ok["ts"],)
        row = conn.execute(
            f"""
            SELECT ts, source, error
            FROM measurement
            WHERE {where}
            ORDER BY ts DESC, id DESC
            LIMIT 1
            """,
            params,
        ).fetchone()
        return dict(row) if row else None


def history(
    db_path: Path,
    *,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    init_db(db_path)
    clauses = ["ok = 1"]
    params: list[Any] = []
    if date_from:
        clauses.append("date(ts) >= date(?)")
        params.append(date_from)
    if date_to:
        clauses.append("date(ts) <= date(?)")
        params.append(date_to)

    with connect(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT id, ts, soh
            FROM measurement
            WHERE {' AND '.join(clauses)}
            ORDER BY ts ASC, id ASC
            """,
            params,
        ).fetchall()
        points = []
        dcb_count = 0
        for row in rows:
            dcbs = _dcbs_for(conn, row["id"])
            dcb_values = [item["soh"] for item in dcbs]
            dcb_count = max(dcb_count, len(dcb_values))
            points.append({"ts": row["ts"], "soh": row["soh"], "dcbs": dcb_values})
        return {"points": points, "dcb_count": dcb_count}


def recent_measurements(db_path: Path, limit: int = 30) -> list[dict[str, Any]]:
    init_db(db_path)
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, ts, source, module_index, soh, rsoc, charge_cycles, ok, error
            FROM measurement
            ORDER BY ts DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        results = []
        for row in rows:
            item = dict(row)
            item["dcbs"] = _dcbs_for(conn, row["id"])
            results.append(item)
        return results


def health(db_path: Path) -> dict[str, Any]:
    init_db(db_path)
    with connect(db_path) as conn:
        schema = conn.execute(
            "SELECT value FROM meta WHERE key = 'schema_version'"
        ).fetchone()
        count = conn.execute("SELECT COUNT(*) AS c FROM measurement").fetchone()["c"]
        last = conn.execute(
            "SELECT ts, ok FROM measurement ORDER BY ts DESC, id DESC LIMIT 1"
        ).fetchone()
        return {
            "db_path": str(db_path),
            "db_ok": True,
            "schema_version": schema["value"] if schema else None,
            "measurement_count": count,
            "last_measurement": dict(last) if last else None,
        }
