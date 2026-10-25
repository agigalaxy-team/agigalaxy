"""Finite original-task probe for the central authorized acceptance run.

Default is read only. --dispatch-once must be chosen explicitly to start the
already enabled Node task with its existing human model; unknown POST results
are polled by the original task only and are never dispatched a second time.
--continue-once consumes an already recorded original-operation decision; it
does not approve an action or override a human takeover/cancel.
Secrets are read in-process from the protected Node AgentOS config reference.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time
from uuid import UUID, uuid4

import httpx
import jwt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="Existing protected Node GALAXY_AGENTOS_CONFIG_FILE path")
    parser.add_argument("--task-id", required=True, type=UUID)
    parser.add_argument("--plan-id", required=True, type=UUID)
    parser.add_argument("--ai-account-id", required=True, type=UUID)
    parser.add_argument("--delegation-version", type=int)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--dispatch-once", action="store_true")
    actions.add_argument("--continue-once", action="store_true")
    parser.add_argument("--wait-seconds", type=int, default=0)
    args = parser.parse_args()
    if not 0 <= args.wait_seconds <= 660:
        parser.error("wait-seconds must be 0..660")
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    path = "/galaxy/autonomy/tasks/" + str(args.task_id)
    def request(client, suffix="", *, dispatch=False):
        at = int(time.time())
        token = jwt.encode({"sub": "autonomy:" + str(args.task_id), "iss": "galaxy-operations", "aud": "galaxy-agentos",
            "iat": at, "exp": at + 60, "jti": str(uuid4()), "scope": "task", "taskId": str(args.task_id),
            "planId": str(args.plan_id), "accountId": str(args.ai_account_id), "delegationVersion": args.delegation_version},
            config["signingKey"], algorithm="HS256")
        headers = {"Authorization": "Bearer " + token, "X-Galaxy-Service-Key": config["serviceKey"]}
        if dispatch:
            headers["Idempotency-Key"] = str(args.task_id)
        try:
            response = client.request("POST" if dispatch else "GET", path + suffix,
                headers=headers, **({"json": {}} if dispatch else {}))
            if response.status_code not in {200, 202}:
                return {"taskId": str(args.task_id), "status": "UNKNOWN", "httpStatus": response.status_code}
            source = response.json()
            return {key: source.get(key) for key in ("taskId", "operationId", "nativeRunId", "status", "modelState", "awaitingHuman")}
        except (httpx.HTTPError, ValueError):
            return {"taskId": str(args.task_id), "status": "UNKNOWN", "modelState": "unknown"}
    deadline = time.monotonic() + args.wait_seconds
    with httpx.Client(base_url=config["url"].rstrip("/"), timeout=20, follow_redirects=False, trust_env=False) as client:
        value = (request(client, "/runs", dispatch=True) if args.dispatch_once else
            request(client, "/continue", dispatch=True) if args.continue_once else request(client))
        while True:
            print(json.dumps({"checkedAt": datetime.now(timezone.utc).isoformat(), **value}), flush=True)
            if value.get("status") in {"COMPLETED", "ERROR", "CANCELLED", "PAUSED"} or time.monotonic() >= deadline:
                break
            time.sleep(min(3, max(0, deadline-time.monotonic())))
            value = request(client)
    return 0 if value.get("status") in {"COMPLETED", "PENDING", "RUNNING", "PAUSED", "NOT_RECORDED"} else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError):
        print(json.dumps({"error": "duty_probe_configuration_invalid"}), file=sys.stderr)
        raise SystemExit(2)
