"""SQLite persistence for saved scenarios and per-case diagram layouts."""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS scenarios (
    id TEXT PRIMARY KEY,
    name TEXT,
    base_case TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS layouts (
    case_id TEXT PRIMARY KEY,
    positions TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str | Path):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # FastAPI runs sync endpoints in a thread pool; serialize access to one connection.
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(SCHEMA)

    # ---------------------------------------------------------------- scenarios
    def create_scenario(self, scenario: dict) -> dict:
        sid, now = uuid.uuid4().hex, _now()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO scenarios VALUES (?, ?, ?, ?, ?, ?)",
                (sid, scenario.get("name"), scenario["base_case"], json.dumps(scenario), now, now),
            )
        return self.get_scenario(sid)

    def update_scenario(self, sid: str, scenario: dict) -> dict | None:
        with self._lock, self._conn:
            cur = self._conn.execute(
                "UPDATE scenarios SET name = ?, base_case = ?, body = ?, updated_at = ? WHERE id = ?",
                (scenario.get("name"), scenario["base_case"], json.dumps(scenario), _now(), sid),
            )
        return self.get_scenario(sid) if cur.rowcount else None

    def get_scenario(self, sid: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM scenarios WHERE id = ?", (sid,)).fetchone()
        return _scenario_row(row) if row else None

    def list_scenarios(self, base_case: str | None = None) -> list[dict]:
        sql, args = "SELECT * FROM scenarios", ()
        if base_case:
            sql, args = sql + " WHERE base_case = ?", (base_case,)
        with self._lock:
            rows = self._conn.execute(sql + " ORDER BY updated_at DESC", args).fetchall()
        return [_scenario_row(r) for r in rows]

    def delete_scenario(self, sid: str) -> bool:
        with self._lock, self._conn:
            return self._conn.execute("DELETE FROM scenarios WHERE id = ?", (sid,)).rowcount > 0

    # ---------------------------------------------------------------- layouts
    def get_layout(self, case_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT positions FROM layouts WHERE case_id = ?", (case_id,)).fetchone()
        return json.loads(row["positions"]) if row else None

    def put_layout(self, case_id: str, positions: dict) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO layouts VALUES (?, ?, ?) "
                "ON CONFLICT(case_id) DO UPDATE SET positions = excluded.positions, updated_at = excluded.updated_at",
                (case_id, json.dumps(positions), _now()),
            )


def _scenario_row(row) -> dict:
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "scenario": json.loads(row["body"]),
    }
