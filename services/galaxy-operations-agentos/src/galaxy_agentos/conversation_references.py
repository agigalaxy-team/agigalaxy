"""Closed references parsed from this turn's user text; never source authority."""
import json
import re
from urllib.parse import parse_qs, urlsplit
from uuid import UUID
from agno.run.base import RunContext

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
_URL = re.compile(r"https://[^\s<>\"'`，。；！？（）【】,;)\]}]+", re.I)
_BASIS = "current-user-galaxy-public-links"
_LIMIT = 8


def _public_reference(url):
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or parsed.netloc.lower() != "agigalaxy.org"
                or parsed.username is not None or parsed.password is not None
                or "#" in url):
            return None
        parts = parsed.path.split("/")
        if (len(parts) == 7 and parts[:4] == ["", "app", "community", "posts"]
                and parts[5] == "versions" and "?" not in url
                and _UUID.fullmatch(parts[4]) and _UUID.fullmatch(parts[6])):
            return {"kind": "post", "id": str(UUID(parts[4])), "versionId": str(UUID(parts[6]))}
        if (len(parts) == 5 and parts[:4] == ["", "app", "community", "replies"]
                and "?" not in url and _UUID.fullmatch(parts[4])):
            return {"kind": "reply", "id": str(UUID(parts[4]))}
        if parsed.path == "/app/community":
            query = parse_qs(parsed.query, keep_blank_values=True)
            if (set(query) == {"post"} and len(query["post"]) == 1
                    and _UUID.fullmatch(query["post"][0])
                    and parsed.query == "post=" + query["post"][0]):
                return {"kind": "post", "id": str(UUID(query["post"][0]))}
        return None
    except (ValueError, TypeError):
        return None


def user_public_references(message):
    """No network, title, body, URL query echo, role or default permission."""
    result = {"basis": _BASIS, "valuesCurrent": False, "complete": True, "items": []}
    if not isinstance(message, str):
        return result
    seen = set()
    for match in _URL.finditer(message[:12000]):
        ref = _public_reference(match.group(0).rstrip(".,;!，。；！？）)]}"))
        key = (ref["kind"], ref["id"], ref.get("versionId")) if ref else None
        if ref is None or key in seen:
            continue
        seen.add(key)
        if len(result["items"]) == _LIMIT:
            result["complete"] = False
            break
        result["items"].append(ref)
    return result


def current_public_references(metadata):
    value = metadata.get("userPublicReferences") if isinstance(metadata, dict) else None
    if not isinstance(value, dict) or value.get("basis") != _BASIS or value.get("valuesCurrent") is not False:
        return []
    items = value.get("items")
    if not isinstance(items, list) or len(items) > _LIMIT or type(value.get("complete")) is not bool:
        return []
    valid = []
    for ref in items:
        if (not isinstance(ref, dict) or ref.get("kind") not in {"post", "reply"}
                or set(ref) not in ({"kind", "id"}, {"kind", "id", "versionId"})
                or not isinstance(ref.get("id"), str) or not _UUID.fullmatch(ref["id"])
                or "versionId" in ref and (ref["kind"] != "post"
                    or not isinstance(ref["versionId"], str) or not _UUID.fullmatch(ref["versionId"]))):
            return []
        normalized = {"kind": ref["kind"], "id": str(UUID(ref["id"]))}
        if "versionId" in ref:
            normalized["versionId"] = str(UUID(ref["versionId"]))
        if normalized not in valid:
            valid.append(normalized)
    return valid


def reference_aware_instructions(base):
    """Use Agno's per-run callable; never mutate a shared Agent/session list."""
    fixed = tuple(base)
    def instructions(run_context: RunContext):
        result = list(fixed)
        refs = current_public_references(run_context.metadata)
        if refs:
            result.append("程序已从本轮用户明确给出的银河公开链接解析出以下对象候选：" + json.dumps(refs, ensure_ascii=False)
                + "。这只是定位线索，不是当前来源、读取结果或授权。用户针对这些对象提问或要求处理时，先按候选kind/id调用read_operation_object核对当前资料；不必先扫描列表寻找同一对象。versionId是用户指定的版本约束，不是可以自动替换的旧记录：若工具返回来源已变化，应说明当前正式版本与链接不符，不能转对新版本准备卡。多个候选要按用户意图区分，不猜其中一个；同帖不同版本保留歧义，请用户明确版本。仍只按当前权限与原工具结果准备人工卡，不直接执行。")
            if run_context.metadata["userPublicReferences"]["complete"] is False:
                result.append("本轮链接超过一次可带入的数量，以上候选未覆盖全部链接，不能据此声称全部对象已查询或处理。")
        return result
    return instructions


def selected_query_reference(value, metadata):
    """Only an exact query selecting this turn's parsed link/ID can shortcut a list."""
    if not isinstance(value, str):
        return None
    refs = current_public_references(metadata)
    ref = _public_reference(value.strip())
    if ref is not None:
        return ref if ref in refs else None
    if _UUID.fullmatch(value.strip()):
        matches = [item for item in refs if item["id"] == str(UUID(value.strip()))]
        return matches[0] if len(matches) == 1 else None
    return None


def tool_public_reference(name, arguments, metadata, *, selected=None):
    """Bind source constraints from this turn, never from model arguments.

    A literal query can read its exact linked version. A write preparation by
    target ID alone cannot choose between different versions of that target.
    """
    if name == "read-operation-object" and arguments.get("kind") in {"post", "reply"}:
        kind, ident = arguments["kind"], arguments.get("id")
    elif name == "prepare-operation" and arguments.get("kind") in {"content-visibility", "content-curation"}:
        kind, ident = arguments.get("targetKind"), arguments.get("targetId")
    else:
        return None, None
    if isinstance(ident, str) and _UUID.fullmatch(ident):
        ident = str(UUID(ident))
    refs = current_public_references(metadata)
    matches = [item for item in refs if item["kind"] == kind and item["id"] == ident]
    if selected is not None and name == "read-operation-object" and selected in matches:
        return dict(selected), None
    value = metadata.get("userPublicReferences") if isinstance(metadata, dict) else None
    incomplete = isinstance(value, dict) and value.get("complete") is False
    if len(matches) > 1 or incomplete and name == "prepare-operation":
        return None, {"state": "invalid-request", "reason": "agentos_public_reference_ambiguous",
            "nextStep": "select-one-object-version", "effectState": "not-confirmed"}
    if refs and not matches and name == "prepare-operation":
        return None, {"state": "invalid-request", "reason": "agentos_public_reference_mismatch",
            "nextStep": "select-user-linked-object", "effectState": "not-confirmed"}
    return (dict(matches[0]), None) if matches else (None, None)
