from __future__ import annotations

import os
import shlex
from dataclasses import dataclass
from pathlib import Path


APP_NAME = "e3dc-soh-monitor"


def _xdg_data_home() -> Path:
    configured = os.environ.get("XDG_DATA_HOME")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".local" / "share"


@dataclass(frozen=True)
class Settings:
    e3dcset_bin: str
    e3dcset_config: str | None
    e3dcset_args: tuple[str, ...]
    module_index: int
    db_path: Path
    host: str
    port: int
    log_level: str


def load_settings() -> Settings:
    db_path = Path(
        os.environ.get(
            "E3DC_SOH_DB",
            str(_xdg_data_home() / APP_NAME / "soh.db"),
        )
    ).expanduser()

    args = tuple(shlex.split(os.environ.get("E3DCSET_ARGS", "")))

    return Settings(
        e3dcset_bin=os.environ.get("E3DCSET_BIN", "/usr/local/bin/e3dcset"),
        e3dcset_config=os.environ.get("E3DCSET_CONFIG") or None,
        e3dcset_args=args,
        module_index=int(os.environ.get("E3DC_BATTERY_MODULE", "0")),
        db_path=db_path,
        host=os.environ.get("E3DC_SOH_HOST", "127.0.0.1"),
        port=int(os.environ.get("E3DC_SOH_PORT", "8321")),
        log_level=os.environ.get("E3DC_SOH_LOG_LEVEL", "INFO").upper(),
    )
