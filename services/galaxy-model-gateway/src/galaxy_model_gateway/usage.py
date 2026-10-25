"""Small durable call/token ledger from the native LiteLLM callback.

No message, response, credential, provider URL, price or budget is persisted.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
import sqlite3

from .policy import ALIAS, CONFIG_VERSION, SCENARIOS

TOKEN_KEYS = ("inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens")
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")


def utc():
    return datetime.now(timezone.utc)


class UsageStore:
    def __init__(self, path, *, now=utc):
        self.path, self.now = Path(path), now
        if self.path.is_symlink() or not self.path.parent.is_dir():
            raise ValueError("model_gateway_usage_store_invalid")
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS coverage (id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL)")
            db.execute("INSERT OR IGNORE INTO coverage VALUES (1, ?)", (self.now().isoformat(),))
            db.execute("""CREATE TABLE IF NOT EXISTS calls (
                call_id TEXT PRIMARY KEY, scenario TEXT NOT NULL, model_alias TEXT NOT NULL,
                config_version TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
                state TEXT NOT NULL, duration_ms INTEGER, input_tokens INTEGER,
                output_tokens INTEGER, total_tokens INTEGER, cached_input_tokens INTEGER,
                reasoning_tokens INTEGER)""")
            db.execute("CREATE INDEX IF NOT EXISTS calls_window ON calls(started_at, scenario, model_alias)")
        self.path.chmod(0o600)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=3)
        db.row_factory = sqlite3.Row
        return db

    def start(self, metadata):
        call_id, scenario = metadata.get("galaxy_call_id"), metadata.get("galaxy_scenario")
        alias, version = metadata.get("galaxy_model_alias"), metadata.get("galaxy_config_version")
        if (not isinstance(call_id, str) or not UUID.fullmatch(call_id) or scenario not in SCENARIOS
                or not isinstance(alias, str) or not ALIAS.fullmatch(alias)
                or not isinstance(version, str) or not CONFIG_VERSION.fullmatch(version)):
            raise ValueError("model_gateway_usage_record_invalid")
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO calls(call_id,scenario,model_alias,config_version,started_at,state) VALUES(?,?,?,?,?,'unknown')",
                (call_id, scenario, alias, version, self.now().isoformat()))

    def finish(self, row):
        if not isinstance(row, dict) or row.get("state") not in {"completed", "failed"}:
            return
        values = [row.get(key) if type(row.get(key)) is int and row[key] >= 0 else None for key in TOKEN_KEYS]
        duration = row.get("durationMs")
        if type(duration) is not int or duration < 0:
            duration = None
        with self.connect() as db:
            # Native sync/async callbacks can report the same completion. Keep
            # the one original terminal receipt rather than double-counting it.
            db.execute("""UPDATE calls SET finished_at=?,state=?,duration_ms=?,input_tokens=?,output_tokens=?,
                total_tokens=?,cached_input_tokens=?,reasoning_tokens=? WHERE call_id=? AND state='unknown'""",
                (self.now().isoformat(), row["state"], duration, *values, row.get("callId")))

    def reject_response(self, call_id):
        # Output validation can happen after the SDK success callback. Preserve
        # any reported tokens, but never retain an invalid reply as completed.
        if not isinstance(call_id, str) or not UUID.fullmatch(call_id):
            raise ValueError("model_gateway_usage_record_invalid")
        with self.connect() as db:
            db.execute("UPDATE calls SET state='failed',finished_at=COALESCE(finished_at,?) WHERE call_id=?",
                (self.now().isoformat(), call_id))

    def summary(self, days):
        if days not in {7, 30} or type(days) is not int:
            raise ValueError("model_gateway_usage_window_invalid")
        until = self.now()
        requested = until - timedelta(days=days)
        with self.connect() as db:
            coverage = datetime.fromisoformat(db.execute("SELECT started_at FROM coverage WHERE id=1").fetchone()[0])
            start = max(requested, coverage)
            rows = [dict(row) for row in db.execute("SELECT * FROM calls WHERE started_at>=? AND started_at<? ORDER BY started_at,call_id",
                (start.isoformat(), until.isoformat()))]
        def aggregate(items):
            total = len(items)
            result = {"calls": {"total": total, **{key: sum(row["state"] == key for row in items)
                for key in ("completed", "failed", "unknown")}}, "tokens": {},
                "unknownUsageCalls": sum(any(row[key] is None for key in ("input_tokens", "output_tokens", "total_tokens")) for row in items)}
            for name, column in zip(("input", "output", "total", "cachedInput", "reasoning"),
                    ("input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "reasoning_tokens")):
                reported = [row[column] for row in items if row[column] is not None]
                result["tokens"][name] = sum(reported) if reported else 0 if total == 0 else None
            return result
        return {"availability": {"state": "available"}, "days": days,
            "from": start.isoformat(), "to": until.isoformat(), "coverageFrom": coverage.isoformat(),
            "coversWholeWindow": coverage <= requested, **aggregate(rows),
            "byScenario": [{"scenario": name, **aggregate([row for row in rows if row["scenario"] == name])}
                for name in sorted({row["scenario"] for row in rows})],
            "byModel": [{"modelAlias": name, **aggregate([row for row in rows if row["model_alias"] == name])}
                for name in sorted({row["model_alias"] for row in rows})]}


def unavailable_usage(days):
    return {"availability": {"state": "unavailable"}, "days": days, "from": None, "to": None,
        "coverageFrom": None, "coversWholeWindow": False,
        "calls": {"total": None, "completed": None, "failed": None, "unknown": None},
        "tokens": {"input": None, "output": None, "total": None, "cachedInput": None, "reasoning": None},
        "unknownUsageCalls": None, "byScenario": [], "byModel": []}
