"""Schema-bound repair and closed recovery on Agno's native Function surface.

Only representation mistakes are repaired. Business choices, permissions, CAS,
deadlines and operation identities remain owned by the existing services.
"""
import json
import re
import time
from copy import deepcopy
from uuid import NAMESPACE_URL, uuid5

from agno.run.base import RunContext
from agno.tools.function import Function, FunctionCall
from pydantic import ValidationError

from .gateway import AuthorityDenied, AuthorityUnavailable, failure_diagnostic, is_internal_diagnostic, closed_failure_fact, SAFE_ARGUMENT_ERROR_CODES
from .conversation_tool_feedback import _preparation_feedback
from .tool_schema_feedback import operation_schema_feedback, repair_operation_alias

PREPARED_CARD_MESSAGE = "请确认操作。"
PREPARED_CARD_IDS = "_galaxyPreparedCardIds"

EFFECT_TOOLS = frozenset({"run_authorized_work", "execute_operation", "manage_ai_role", "manage_ai_prompt"})

READ_TOOLS = frozenset({"current_summary", "query_operations", "read_operation_object", "list_authorized_work", "inspect_operations", "read_task_operation"})


def _closed_failure(name, error):
    diagnostic = failure_diagnostic(error)
    fact = closed_failure_fact(status=diagnostic.get("status"), code=diagnostic.get("code"),
        state="denied" if isinstance(error, AuthorityDenied) else "unavailable")
    uncertain = name in EFFECT_TOOLS
    return {**fact, "dataRead": False, "valuesCurrent": False,
        "effectExecuted": None if uncertain else False, "cardPrepared": False, "retryable": False,
        **({"nextStep": "read-original-operation"} if uncertain else {})}


def _model_feedback(value):
    """Project only known failure fields; never traverse arbitrary user data."""
    if not isinstance(value, dict):
        return value, {}
    # Only the exact closed envelope from the authenticated gateway survives.
    if (set(value).difference({"state", "reason", "httpStatus", "scope", "retryable", "action", "preparationFeedback", "analysisConstraints"}) == set()
            and value.get("state") == "invalid-request"
            and isinstance(value.get("reason"), str) and value["reason"] in SAFE_ARGUMENT_ERROR_CODES
            and type(value.get("httpStatus")) is int and value["httpStatus"] in {400, 422}
            and value.get("scope") == "backend-request-validation"
            and value.get("retryable") is True and value.get("action") == "correct-arguments"):
        return {key: value[key] for key in ("state", "reason", "httpStatus", "scope", "retryable", "action")}, {"code": value["reason"]}
    if value.get("scope") == "backend-request-validation":
        # Reject the entire malformed envelope; never copy unknown fields.
        return {**closed_failure_fact(state="unavailable"), "dataRead": False,
            "valuesCurrent": False, "retryable": False}, {}
    result, diagnostic = dict(value), {}
    state = result.get("state")
    state = state if isinstance(state, str) else None
    availability = result.get("availability")
    if state is None and isinstance(availability, str) and availability in {"unavailable", "not-configured", "not-connected", "invalid-request", "denied", "changed"}:
        state = "unavailable" if availability in {"not-configured", "not-connected"} else availability
    if state in {"denied", "unavailable", "invalid-request", "changed"}:
        code = result.get("code") or result.get("reason")
        for key in ("reason", "code"):
            if is_internal_diagnostic(result.get(key)):
                diagnostic["code"] = result.pop(key)
        if isinstance(result.get("reason"), str) and result["reason"] in {"summary-not-connected", "summary-unavailable"}:
            result.pop("reason", None)
        result.update(closed_failure_fact(state=state, code=code))
        result["dataRead"], result["valuesCurrent"] = False, False
    for key in ("priorReadReceipts", "currentReadOutcomes"):
        section = result.get(key)
        if not isinstance(section, dict) or not isinstance(section.get("items"), list):
            continue
        items, codes = [], set()
        for value in section["items"]:
            item = dict(value) if isinstance(value, dict) else value
            if isinstance(item, dict):
                code = item.pop("code", None)
                if is_internal_diagnostic(code): codes.add(code)
                state = item.get("resultState") or item.get("state")
                state = state if isinstance(state, str) else None
                if state in {"denied", "unavailable", "invalid-request", "changed"} or is_internal_diagnostic(code):
                    fact = closed_failure_fact(state=state, code=code)
                    item["state"] = fact["state"]
                    item["resultState"] = fact["state"]
                    item["outcome"] = {k: fact[k] for k in ("state", "failureCategory", "causeKnown", "message")}
            items.append(item)
        if codes: diagnostic[key + "Codes"] = sorted(codes)[:8]
        result[key] = {**section, "items": items}
    return result, diagnostic


def _event(name, context, state, **metadata):
    # Explicit metadata only. No inputs, tool result bodies or provider IDs.
    print(json.dumps({"event": "conversation-tool", "tool": name, "runId": context.run_id,
        "state": state, **metadata}, ensure_ascii=True), flush=True)


def tool_call_key(value):
    """Keep the provider ID in Agno; send a stable bounded locator to Galaxy only."""
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value):
        return value
    if isinstance(value, str) and len(value) <= 65536 and "__thought__" in value:
        base, signature = value.split("__thought__", 1)
        if re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", base) and re.fullmatch(r"[A-Za-z0-9+/=_-]+", signature):
            return "provider-" + str(uuid5(NAMESPACE_URL, "galaxy-tool-call:" + value))
    raise AuthorityDenied("agentos_native_tool_call_id_invalid")


def _resolve(schema, root):
    ref = schema.get("$ref") if isinstance(schema, dict) else None
    if isinstance(ref, str) and ref.startswith("#/$defs/"):
        return root.get("$defs", {}).get(ref[8:], schema)
    return schema


def repair(value, schema, root=None, depth=0):
    """Use the same frozen schema for repair and native validation.

    Inspired by OpenCode's schema-directed input repair. Unlike its generic
    coding-tool policy, never discard unknown fields or invent array members.
    """
    root = root or schema
    if depth > 8 or not isinstance(schema, dict):
        return value
    schema = _resolve(schema, root)
    branches = schema.get("anyOf", schema.get("oneOf"))
    if isinstance(branches, list):
        if value is None:
            return value
        candidates = [_resolve(x, root) for x in branches if isinstance(x, dict) and x.get("type") != "null"]
        if isinstance(value, dict):
            matches = [x for x in candidates if x.get("properties", {}).get("kind", {}).get("const") == value.get("kind")]
            if len(matches) == 1:
                return repair(value, matches[0], root, depth + 1)
        if len(candidates) == 1:
            return repair(value, candidates[0], root, depth + 1)
        # A literal such as days="all" wins unchanged. Numeric-string repair
        # is valid only when exactly one branch offers that representation.
        if any(value == x.get("const") or value in x.get("enum", []) for x in candidates):
            return value
        converted = [repair(value, x, root, depth + 1) for x in candidates]
        changed = [x for x in converted if type(x) is not type(value) or x != value]
        return changed[0] if len(changed) == 1 else value
    kind = schema.get("type")
    if kind in ("object", "array") and isinstance(value, str) and len(value) <= 131072:
        try:
            decoded = json.loads(value)
            if isinstance(decoded, dict if kind == "object" else list):
                value = decoded
        except (ValueError, RecursionError):
            pass
    if kind == "integer" and isinstance(value, str) and re.fullmatch(r"-?[0-9]{1,15}", value):
        return int(value)
    if kind == "boolean" and value in ("true", "false"):
        return value == "true"
    if kind == "object" and isinstance(value, dict):
        properties = schema.get("properties", {})
        return {key: repair(item, properties[key], root, depth + 1) if key in properties else item for key, item in value.items()}
    if kind == "array" and isinstance(value, list) and isinstance(schema.get("items"), dict):
        return [repair(item, schema["items"], root, depth + 1) for item in value]
    return value


def _normalize(name, arguments, schema):
    values = deepcopy(arguments)
    properties = schema.get("properties", {})
    # Move known query filter fields only; conflicting values are never guessed.
    if name in {"query_operations", "read_operation_object"}:
        field = _resolve(properties.get("filters", {}), schema)
        branches = field.get("anyOf", [field])
        filter_fields = set().union(*[set(_resolve(x, schema).get("properties", {})) for x in branches if isinstance(x, dict)])
        misplaced = set(values).intersection(filter_fields) - set(properties)
        if misplaced:
            filters = values.get("filters")
            if filters is None:
                filters = {}
            if isinstance(filters, dict) and not any(key in filters and filters[key] != values[key] for key in misplaced):
                values["filters"] = {**filters, **{key: values.pop(key) for key in sorted(misplaced)}}
    if name in {"prepare_operation", "execute_operation"}:
        values = repair_operation_alias(values, schema)
    return repair(values, schema)


def reliable_function(fn, *, on_read_validation_failure=None):
    native = Function.from_callable(fn)
    native.process_entrypoint()
    schema = deepcopy(native.parameters)
    validated = native.entrypoint
    known_fields = set()
    def collect_fields(value):
        if isinstance(value, dict):
            known_fields.update(value.get('properties', {}))
            if isinstance(value.get('title'), str):known_fields.add(value['title'])
            for child in value.values():collect_fields(child)
        elif isinstance(value, list):
            for child in value:collect_fields(child)
    collect_fields(schema)

    def record_local_failure(run_context, fc, values):
        if on_read_validation_failure is None or native.name not in {"query_operations", "read_operation_object", "read_ai_delegation"}:
            return
        try:
            on_read_validation_failure(run_context, fc, native.name, values, schema)
        except Exception:
            if run_context.metadata is None:
                run_context.metadata = {}
            run_context.metadata["_galaxyDutyValidationLedgerFailed"] = True
            function = fc.function.model_copy()
            function.stop_after_tool_call = True
            fc.function = function
            raise RuntimeError("agentos_autonomy_validation_ledger_unavailable") from None

    def invoke(run_context: RunContext, fc: FunctionCall, **arguments):
        if set(fc.arguments or {}).intersection({"run_context", "fc", "agent", "team"}):
            raise AuthorityDenied("agentos_injected_arguments_forbidden")
        values = _normalize(native.name, arguments, schema)
        _event(native.name, run_context, "started", repaired=values != arguments)
        try:
            for attempt in range(2):
                try:
                    result = validated(run_context=run_context, fc=fc, **values)
                    try:
                        value = json.loads(result)
                    except (ValueError, TypeError):
                        value = {}
                    state = value.get("state", value.get("availability", "returned")) if isinstance(value, dict) else "returned"
                    if isinstance(value, dict) and value.get("state") == "invalid-request":
                        record_local_failure(run_context, fc, values)
                    if native.name == "prepare_operation" and isinstance(value, dict):
                        prepared = _preparation_feedback(value)
                        if prepared["preparationFeedback"]["cardPrepared"] is True:
                            card_id = value["card"]["cardId"]
                            if run_context.metadata is None:
                                run_context.metadata = {}
                            ids = run_context.metadata.setdefault(PREPARED_CARD_IDS, [])
                            if card_id not in ids:
                                ids.append(card_id)
                            # Only this provider call gets stop/show flags. Other
                            # calls and other runs keep their original Function.
                            function = fc.function.model_copy()
                            function.stop_after_tool_call = True
                            function.show_result = True
                            fc.function = function
                            _event(native.name, run_context, "prepared")
                            return PREPARED_CARD_MESSAGE
                    feedback, diagnostic = _model_feedback(value)
                    _event(native.name, run_context, state if isinstance(state, str) and state in {"available", "prepared", "completed", "invalid-request", "changed", "unknown", "unavailable", "processing", "denied"} else "returned", diagnostic=diagnostic)
                    if diagnostic or feedback != value:
                        return json.dumps(feedback, ensure_ascii=False)
                    return result
                except AuthorityUnavailable as error:
                    if native.name not in READ_TOOLS or attempt or getattr(error, "retry_read", True) is False:
                        uncertain = native.name in EFFECT_TOOLS
                        _event(native.name, run_context, "unavailable", outcome="unknown" if uncertain else "not-started", diagnostic=failure_diagnostic(error))
                        return json.dumps(_closed_failure(native.name, error), ensure_ascii=False)
                    _event(native.name, run_context, "retry-read", attempt=2)
                    time.sleep(0.2)
        except AuthorityDenied as error:
            feedback = _closed_failure(native.name, error)
            _event(native.name, run_context, feedback["state"], diagnostic=failure_diagnostic(error))
            return json.dumps(feedback, ensure_ascii=False)
        except ValidationError as error:
            record_local_failure(run_context, fc, values)
            # Unknown dictionary keys and field names can themselves contain
            # private input. Log only schema-owned names and bounded indices.
            errors = [{"field": ".".join(str(x) if isinstance(x,int) and 0<=x<=1024 or isinstance(x,str) and x in known_fields else '<field>' for x in item['loc'][:8]),
                "type": item['type'] if re.fullmatch(r'[a-z_]{1,80}',item['type']) else 'validation_error'} for item in error.errors(include_input=False, include_url=False)][:8]
            counters = run_context.metadata.setdefault("toolRecovery", {}) if isinstance(run_context.metadata, dict) else {}
            key = native.name + ":" + ",".join(x["field"] + ":" + x["type"] for x in errors)
            counters[key] = counters.get(key, 0) + 1
            exhausted = counters[key] > 2
            _event(native.name, run_context, "invalid-request", errors=errors, exhausted=exhausted)
            return json.dumps({"state": "invalid-request", "message": "工具调用参数不符。", "dataRead": False, "valuesCurrent": False, "errors": errors,
                "allowedFields": sorted(schema.get('properties',{})),
                **(operation_schema_feedback(schema, values) if native.name in {"prepare_operation", "execute_operation"} else {}),
                "effectExecuted": False, "cardPrepared": False, "retryable": True,
                "nextStep": "correct-arguments", "repeatedValidationFailure": exhausted,
                "instruction": "No card exists from this failed call. Correct the fields against this tool's schema without changing the requested operation; never report success."}, ensure_ascii=False)

    return Function(name=native.name, description=native.description, parameters=schema,
        entrypoint=invoke, skip_entrypoint_processing=True)
