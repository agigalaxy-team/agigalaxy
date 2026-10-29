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

from .gateway import AuthorityDenied, AuthorityUnavailable, failure_diagnostic

EFFECT_TOOLS = frozenset({"run_authorized_work", "execute_operation", "manage_ai_role", "manage_ai_prompt"})

READ_TOOLS = frozenset({"current_summary", "query_operations", "read_operation_object", "list_authorized_work"})


def _closed_failure(name, error):
    """Describe the actual failure category without handing the model raw codes."""
    diagnostic = failure_diagnostic(error)
    code, status = diagnostic.get("code"), diagnostic.get("status")
    state, message = "denied", "本次读取未获允许，旧记录不代表本次结果。"
    if isinstance(error, AuthorityUnavailable):
        state, message = "unavailable", "本次读取暂时失败，旧记录不代表本次结果。"
        if code in {"operations_agentos_conversation_not_ready", "operations_agentos_action_not_connected"}:
            message = "本次读取暂未就绪，旧记录不代表本次结果。"
        elif code == "agentos_authority_timeout":
            message = "本次读取超时，旧记录不代表本次结果。"
    elif status in {400, 422} or code in {"agentos_tool_arguments_invalid", "agentos_tool_call_id_invalid",
            "agentos_native_tool_call_id_invalid", "agentos_native_tool_call_required",
            "agentos_conversation_context_required", "agentos_injected_arguments_forbidden"}:
        state, message = "invalid-request", "工具调用参数不符。"
    elif status in {404, 410}:
        state, message = "unavailable", "本次对象不可读取，旧记录不代表本次结果。"
    elif status == 409 or code == "agentos_conversation_context_changed":
        state, message = "changed", "该项状态已变化。"
    elif status == 401:
        message = "本次会话认证未通过，旧记录不代表本次结果。"
    uncertain = name in EFFECT_TOOLS
    result = {"state": state, "message": message, "dataRead": False, "valuesCurrent": False, "effectExecuted": None if uncertain else False,
        "cardPrepared": False, "retryable": False}
    if uncertain:
        result["nextStep"] = "read-original-operation"
    return result


def _model_feedback(value):
    """Keep detailed schema feedback, but leave internal failure codes in logs."""
    if not isinstance(value, dict):
        return value, {}
    result = dict(value)
    diagnostic = {}
    internal_code = r"(?:agentos|operations_agentos|business_admin)_[a-z0-9_]{1,100}"
    if result.get("state") in {"denied", "unavailable", "invalid-request", "changed"}:
        for key in ("reason", "code"):
            raw = result.get(key)
            if isinstance(raw, str) and re.fullmatch(internal_code, raw):
                diagnostic["code"] = raw
                del result[key]
        if diagnostic:
            result.setdefault("message", {"denied": "该项读取未获允许。", "unavailable": "该项当前不可读取。",
                "invalid-request": "工具调用参数不符。", "changed": "该项状态已变化。"}[result["state"]])
            result["dataRead"], result["valuesCurrent"] = False, False
            if result["state"] in {"denied", "unavailable"}:
                result["message"] = "本次读取未成功，旧记录不代表本次结果。"
    # These are historical read outcomes, not a new denial in this turn. Keep
    # the recorded state and route; an old internal code must not become the
    # explanation for an ordinary current reply.
    prior = result.get("priorReadReceipts")
    if isinstance(prior, dict) and isinstance(prior.get("items"), list):
        items, codes = [], set()
        for item in prior["items"]:
            entry = dict(item) if isinstance(item, dict) else item
            code = entry.get("code") if isinstance(entry, dict) else None
            if isinstance(code, str) and re.fullmatch(internal_code, code):
                codes.add(code)
                del entry["code"]
                entry["message"] = "该次读取未成功。"
            items.append(entry)
        if codes:
            diagnostic["priorReadCodes"] = sorted(codes)[:8]
            result["priorReadReceipts"] = {**prior, "items": items}
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
    if name == "prepare_operation" and isinstance(values.get("operation"), dict):
        operation = values["operation"]
        aliases = {definition.get("title"): definition.get("properties", {}).get("kind", {}).get("const")
            for definition in schema.get("$defs", {}).values() if isinstance(definition, dict)}
        alias = aliases.get(operation.get("kind"))
        if alias:
            operation["kind"] = alias
    return repair(values, schema)


def reliable_function(fn):
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
                    feedback, diagnostic = _model_feedback(value)
                    _event(native.name, run_context, state if isinstance(state, str) and state in {"available", "prepared", "completed", "invalid-request", "changed", "unknown", "unavailable", "processing", "denied"} else "returned", diagnostic=diagnostic)
                    if diagnostic:
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
                "effectExecuted": False, "cardPrepared": False, "retryable": not exhausted,
                "nextStep": "report-blocked" if exhausted else "correct-arguments",
                "instruction": "No card exists from this failed call. Correct the fields against this tool's schema and call again; never report success."}, ensure_ascii=False)

    return Function(name=native.name, description=native.description, parameters=schema,
        entrypoint=invoke, skip_entrypoint_processing=True)
