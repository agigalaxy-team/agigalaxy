"""AgentOS application composition and execution HTTP routes."""
import json

import httpx
from fastapi import Request, Query
from fastapi.responses import JSONResponse
from agno.run.workflow import WorkflowRunOutput

from .config import Settings
from .conversations import install_conversation_read
from .conversation_transport import install_conversation_transport_read
from .runtime import create_runtime
from .p13_strategy_surface import install_p13_routes
from .duty_surface import install_duty_routes
from .model_settings import model_settings_view
from .run_view import run_view, _completed_conversation_content
from .surface import PrivateSurface


def create_app(settings, **runtime_options):
    runtime = create_runtime(settings, **runtime_options)
    app = runtime["os"].get_app()
    runtime["p13Surface"] = install_p13_routes(app, settings, runtime)
    runtime["dutySurface"] = install_duty_routes(app, settings, runtime)
    install_conversation_read(app, runtime, run_view)
    install_conversation_transport_read(app, runtime, run_view)

    @app.get("/galaxy/model-settings")
    async def read_model_settings():
        return model_settings_view(settings)

    @app.get("/galaxy/runs")
    async def global_runs(page: int = Query(1, ge=1, le=100000), limit: int = Query(30, ge=1, le=100), domain: str | None = None, state: str | None = None):
        from .read_model import list_runs, DOMAINS, STATUSES
        if domain is not None and domain not in DOMAINS or state is not None and state not in STATUSES:
            return JSONResponse({"error": "agentos_query_invalid"}, status_code=400)
        return list_runs(runtime["db"], page=page, limit=limit, domain=domain, state=state)

    @app.get("/galaxy/runs/{run_id}")
    async def global_run_detail(run_id: str):
        from .read_model import run_detail
        value = run_detail(runtime["db"], run_id)
        return value if value else JSONResponse({"error": "agentos_run_not_found"}, status_code=404)

    @app.get("/galaxy/executions/{ident}")
    async def read_execution(ident: str, request: Request):
        row = request.state.galaxy_execution
        if row["id"] != ident:
            return JSONResponse({"error": "agentos_current_authority_denied"}, status_code=403)
        user_id = request.state.galaxy_user_id
        runs = []
        # get_session(runs_limit=...) is the native *model context* window and
        # intentionally drops PAUSED/error/cancelled runs. The workbench needs
        # the native run ledger, including the pause requiring human input.
        for sid, component in [(row["sessionId"], {"agent_id": "galaxy-" + row["domain"]}),
                (row["sessionId"] + ":review", {"workflow_id": "galaxy-prepared-review"})]:
            stored = runtime["db"].get_runs(session_id=sid, user_id=user_id, limit=50,
                page=1, sort_by="created_at", sort_order="desc", **component)
            runs.extend(run_view(run) for run in stored)
        traces, count = runtime["db"].get_traces(user_id=user_id, limit=50)
        # Recheck after all database work before releasing controlled history.
        current = runtime["gateway"].authorize(user_id, operation="read")
        return {"executionId": ident, "runs": sorted(runs, key=lambda run: run["createdAt"] or 0),
            "traces": [{"traceId": t.trace_id, "status": t.status, "durationMs": t.duration_ms, "runId": t.run_id} for t in traces],
            "traceCount": count, "modelState": "configured" if runtime["modelConfigured"] else "not-configured",
            "readExpiresAt": current.get("readExpiresAt")}

    @app.post("/galaxy/executions/{ident}/continue")
    async def continue_execution(ident: str, request: Request):
        row = request.state.galaxy_execution
        if row["id"] != ident:
            return JSONResponse({"error": "agentos_current_authority_denied"}, status_code=403)
        form = await request.form()
        run_id, confirmed = str(form.get("run_id", "")), str(form.get("confirmed", ""))
        if confirmed not in {"true", "false"}:
            return JSONResponse({"error": "agentos_confirmation_invalid"}, status_code=400)
        sid = row["sessionId"] + ":review"
        stored = runtime["db"].get_run(run_id=run_id, deserialize=False)
        if (not stored or stored.get("session_id") != sid
                or stored.get("user_id") != request.state.galaxy_user_id
                or stored.get("workflow_id") != "galaxy-prepared-review"
                or stored.get("run_type") != "workflow" or stored.get("status") != "PAUSED"):
            return JSONResponse({"error": "agentos_run_not_paused"}, status_code=409)
        run = WorkflowRunOutput.from_dict(stored["run_data"])
        requirements = run.step_requirements or []
        for requirement in requirements[-1:]:
            requirement.confirm() if confirmed == "true" else requirement.reject()
        runtime["gateway"].authorize(request.state.galaxy_user_id, operation="run")
        # Delegate the transition and durable-ticket CAS to the native route.
        # Only requirement IDs/statuses read from the owned native run are sent.
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agentos.internal") as client:
            response = await client.post("/workflows/galaxy-prepared-review/runs/" + run_id + "/continue",
                headers={"Authorization": request.headers["authorization"]},
                data={"session_id": sid, "stream": "false", "background": "true",
                    "step_requirements": json.dumps([r.to_dict() for r in requirements])})
        if response.status_code not in {200, 202}:
            return JSONResponse({"error": "agentos_continue_failed"}, status_code=response.status_code)
        return response.json()

    app.add_middleware(PrivateSurface, settings=settings, runtime=runtime)
    app.state.galaxy_runtime = runtime
    return app


def main():
    import uvicorn
    settings = Settings.from_env()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, access_log=False)


if __name__ == "__main__":
    main()
