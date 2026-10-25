from sqlalchemy import and_, func, or_, select
from uuid import UUID
import math
import re

DOMAINS = {"overview", "governance", "messaging", "discovery", "maintenance"}
STATUSES = {"PENDING", "RUNNING", "COMPLETED", "PAUSED", "CANCELLED", "ERROR", "REGENERATED"}
P13_WORKFLOW = "galaxy-p13-selected-content-v1"


def number(value):
    return value if isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


def conversation_id(user_id, component_id, domain):
    if not isinstance(user_id, str) or not user_id.startswith("conversation:") or domain not in DOMAINS or component_id != "galaxy-conversation-" + domain:
        return None
    try:
        value = user_id.removeprefix("conversation:")
        return value if str(UUID(value)) == value else None
    except ValueError:
        return None


def metadata(row):
    data = row.get("run_data") or {}
    context = data.get("metadata") or {}
    user_id = row.get("user_id") or data.get("user_id") or ""
    component_id = row.get("agent_id") or row.get("workflow_id")
    domain = ("governance" if row.get("run_type") == "workflow" and component_id == P13_WORKFLOW
        else context.get("domain") if context.get("domain") in DOMAINS else None)
    task_id = None
    if component_id == "galaxy-duty" and user_id.startswith("autonomy:"):
        try:
            task_id = str(UUID(user_id[9:]))
        except ValueError:
            pass
    metrics = data.get("metrics") or {}
    calls = context.get("modelCalls")
    if type(calls) is not int or calls < 0:
        calls = None
    # Native metrics initialize counts to zero even when there was no model.
    # A token total is reported only with a recorded model metrics detail.
    has_model = bool(metrics.get("details")) and any(number(metrics.get(key)) for key in ("input_tokens", "output_tokens", "total_tokens"))
    error_code = "operations_agentos_run_failed" if row.get("status") == "ERROR" else None
    for event in data.get("events") or []:
        if error_code and event.get("error_type") == "AuthorityUnavailable":
            error_code = "operations_authorization_unavailable"
        elif error_code and event.get("error_type") == "AuthorityDenied":
            error_code = "operations_agentos_authority_changed"
    duty_prompt = context.get("promptVersion") if task_id else None
    if not (type(duty_prompt) is int and duty_prompt > 0 or isinstance(duty_prompt, str)
            and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", duty_prompt)):
        duty_prompt = None
    role_prompt = context.get("rolePromptVersion") if conversation_id(user_id, component_id, domain) else None
    if type(role_prompt) is not int or role_prompt < 1:
        role_prompt = None
    model_version = None
    model_versions = None
    if task_id or conversation_id(user_id, component_id, domain):
        def valid_version(value):
            return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value) is not None
        recorded_version = context.get("modelSettingsVersion")
        if valid_version(recorded_version):
            model_version = recorded_version
        recorded_versions = context.get("modelSettingsVersions")
        if isinstance(recorded_versions, list) and recorded_versions and all(valid_version(value) for value in recorded_versions):
            model_versions = list(recorded_versions)
    return {"runId": row["run_id"], "executionId": user_id[10:] if user_id.startswith("execution:") else None,
        "taskId": task_id, "aiAccountId": context.get("aiAccountId") if task_id else None,
        "planVersion": context.get("planVersion") if task_id else None,
        "modelSettingsVersion": model_version,
        "modelSettingsVersions": model_versions,
        "conversationId": conversation_id(user_id, component_id, domain),
        "rolePromptVersion": role_prompt,
        "boundaryVersion": context.get("boundaryVersion") if conversation_id(user_id, component_id, domain)
            and context.get("boundaryVersion") == "galaxy-conversation-boundary-v3" else None,
        "sessionId": row.get("session_id"), "componentId": component_id,
        "componentType": row.get("run_type"), "domain": domain,
        "state": row.get("status"), "errorCode": error_code, "createdAt": row.get("created_at"), "updatedAt": row.get("updated_at"),
        "promptVersion": duty_prompt if task_id else P13_WORKFLOW if row.get("run_type") == "workflow" and component_id == P13_WORKFLOW
            else context.get("promptVersion") if context.get("promptVersion") in {"galaxy-operations-v1", "galaxy-prepared-review-v1", "galaxy-conversation-v1", "galaxy-conversation-v2"} else None,
        "tokens": {"input": number(metrics.get("input_tokens")) if has_model else None,
            "output": number(metrics.get("output_tokens")) if has_model else None,
            "total": number(metrics.get("total_tokens")) if has_model else None},
        "calls": calls,
        "durationMs": (number(metrics.get("duration")) + (number(context.get("activeDurationBefore")) or 0)) * 1000 if number(metrics.get("duration")) is not None else None,
        "retryCount": None, "retryState": "not-recorded", "metadataOnly": True}


def list_runs(db, *, page=1, limit=30, domain=None, state=None):
    # Read the native normalized run table; no execution-list substitution,
    # current-page totals, prompt/body search or separate run persistence.
    table = db._get_table(table_type="runs")
    if table is None:
        return {"items": [], "total": 0, "page": page, "nextPage": None, "metadataOnly": True}
    query = select(table)
    if domain:
        component = or_(table.c.agent_id.in_(["galaxy-" + domain, "galaxy-conversation-" + domain]),
            and_(table.c.agent_id == "galaxy-duty", table.c.run_data["metadata"]["domain"].as_string() == domain))
        if domain == "governance":
            component = or_(component, table.c.workflow_id.in_(["galaxy-prepared-review", P13_WORKFLOW]))
        query = query.where(component)
    if state:
        query = query.where(table.c.status == state)
    with db.Session() as session:
        total = session.execute(select(func.count()).select_from(query.subquery())).scalar_one()
        rows = session.execute(query.order_by(table.c.created_at.desc(), table.c.run_id.desc()).limit(limit).offset((page - 1) * limit)).mappings().all()
    return {"items": [metadata(dict(row)) for row in rows], "total": total, "page": page,
        "nextPage": page + 1 if page * limit < total else None, "metadataOnly": True}


def run_detail(db, run_id):
    row = db.get_run(run_id=run_id, deserialize=False)
    if not row:
        return None
    data = row.get("run_data") or {}
    traces, count = db.get_traces(run_id=run_id, limit=100)
    spans = []
    for trace in traces:
        for span in db.get_spans(trace_id=trace.trace_id):
            attrs = span.attributes or {}
            kind = attrs.get("openinference.span.kind")
            spans.append({"spanId": span.span_id, "traceId": span.trace_id, "parentSpanId": span.parent_span_id,
                "name": span.name, "kind": kind if kind in {"AGENT", "CHAIN", "LLM", "TOOL", "RETRIEVER", "EMBEDDING", "RERANKER", "GUARDRAIL", "EVALUATOR"} else None,
                "state": span.status_code, "startTime": span.start_time.isoformat(),
                "endTime": span.end_time.isoformat(), "durationMs": span.duration_ms,
                "tokens": {"input": number(attrs.get("llm.token_count.prompt")), "output": number(attrs.get("llm.token_count.completion")), "total": number(attrs.get("llm.token_count.total"))},
                "input": {"state": "not-recorded", "value": None}, "output": {"state": "not-recorded", "value": None}})
    events = []
    for event in data.get("events") or []:
        name = event.get("event")
        if isinstance(name, str) and "Reasoning" not in name and name.isidentifier():
            events.append({"event": name, "eventIndex": event.get("event_index"), "createdAt": event.get("created_at")})
    strategy_workflow = None
    strategy_continuations = None
    if row.get("run_type") == "workflow" and row.get("workflow_id") == P13_WORKFLOW:
        # Reuse the same closed workflow summary as the active route. This
        # service-key read exposes no source text, model messages or step output.
        from agno.run.workflow import WorkflowRunOutput
        from .p13_strategy_surface import native_view
        from .p13_continuation import receipt_metadata
        strategy_continuations = receipt_metadata(db, native_run_id=row["run_id"], session_id=row.get("session_id"), user_id=row.get("user_id"))
        try:
            strategy_workflow = native_view(WorkflowRunOutput.from_dict(data))
        except (TypeError, ValueError, KeyError, AttributeError):
            strategy_workflow = None
    return {"run": metadata(row), "spans": spans, "events": events, "traceCount": count,
        "strategyWorkflow": strategy_workflow, "strategyContinuations": strategy_continuations,
        "input": {"state": "withheld", "value": None}, "output": {"state": "withheld", "value": None},
        "metadataOnly": True}
