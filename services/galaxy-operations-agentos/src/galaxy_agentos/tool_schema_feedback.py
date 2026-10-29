"""Safe operation-discriminator facts derived from a native Function schema.

The schema is program-owned; model input is never included in feedback.
"""
from copy import deepcopy
import json


def _pointer(root, ref):
    if not isinstance(ref, str) or not ref.startswith("#/"):
        return None
    value = root
    for part in ref[2:].split("/"):
        if not isinstance(value, dict):
            return None
        value = value.get(part.replace("~1", "/").replace("~0", "~"))
    return value if isinstance(value, dict) else None


def _tagged_variants(schema, entry):
    """Read discriminated branches from the actual inline/ref schema."""
    if not isinstance(schema, dict) or not isinstance(entry, dict):
        return []
    variants, seen = [], set()

    def visit(node, ref_name=None):
        if not isinstance(node, dict):
            return
        ref = node.get("$ref")
        if isinstance(ref, str):
            if ref in seen:
                return
            seen.add(ref)
            visit(_pointer(schema, ref), ref.rsplit("/", 1)[-1].replace("~1", "/").replace("~0", "~"))
            return
        properties = node.get("properties")
        if isinstance(properties, dict):
            kind_schema = properties.get("kind")
            if isinstance(kind_schema, dict) and "$ref" in kind_schema:
                kind_schema = _pointer(schema, kind_schema["$ref"])
            kind = kind_schema.get("const") if isinstance(kind_schema, dict) else None
            if isinstance(kind, str) and kind:
                required = node.get("required", [])
                if not isinstance(required, list):
                    required = []
                variants.append((kind, tuple(sorted(k for k in required if isinstance(k, str) and k in properties)),
                    tuple(sorted(k for k in properties if isinstance(k, str))),
                    tuple(k for k in (node.get("title"), ref_name) if isinstance(k, str) and k), node))
        for branch in ("oneOf", "anyOf", "allOf"):
            values = node.get(branch)
            if isinstance(values, list):
                for value in values:
                    visit(value)
        discriminator = node.get("discriminator")
        mapping = discriminator.get("mapping") if isinstance(discriminator, dict) else None
        if isinstance(mapping, dict):
            for ref in mapping.values():
                visit({"$ref": ref})

    visit(entry)
    return variants


def _operation_variants(schema):
    if not isinstance(schema, dict):
        return []
    operation = schema.get("properties", {}).get("operation")
    return [row[:4] for row in _tagged_variants(schema, operation)]


def _field_schema(schema, node, depth=0, seen=frozenset()):
    """Bounded, schema-owned constraints; never inspect model values."""
    if not isinstance(node, dict) or depth > 5:
        return {}, False
    if "$ref" in node:
        ref = node["$ref"]
        if not isinstance(ref, str) or ref in seen:
            return {}, False
        result, complete = _field_schema(schema, _pointer(schema, ref), depth + 1, seen | {ref})
        return result, complete and not any(key not in {"$ref", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"} for key in node)
    result, complete = {}, True
    supported = {"type", "format", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "enum", "items", "properties", "required", "additionalProperties", "oneOf", "anyOf", "allOf"}
    annotations = {"title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "discriminator", "$defs", "definitions"}
    if any(key not in supported | annotations for key in node):
        complete = False
    for key in ("type", "format", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems"):
        if key not in node:
            continue
        value = node[key]
        if value is None or isinstance(value, (bool, int, float)) or isinstance(value, str) and len(value) <= 256:
            result[key] = value
        else:
            complete = False
    if "enum" in node:
        values = node["enum"]
        if isinstance(values, list) and len(values) <= 64 and all(v is None or isinstance(v, (bool, int, float)) or isinstance(v, str) and len(v) <= 256 for v in values):
            result["enum"] = values
        else:
            complete = False
    for key in ("items",):
        if key in node:
            child, ok = _field_schema(schema, node[key], depth + 1, seen)
            result[key] = child
            complete = complete and ok
    if "properties" in node:
        properties = node["properties"]
        if not isinstance(properties, dict) or len(properties) > 24:
            complete = False
        else:
            result["properties"] = {}
            for name, prop in properties.items():
                if not isinstance(name, str) or len(name) > 128:
                    complete = False
                    continue
                result["properties"][name], ok = _field_schema(schema, prop, depth + 1, seen)
                complete = complete and ok
            required = node.get("required", [])
            if isinstance(required, list) and all(isinstance(v, str) and v in properties for v in required):
                result["required"] = required
            else:
                complete = False
    if "additionalProperties" in node:
        if isinstance(node["additionalProperties"], bool):
            result["additionalProperties"] = node["additionalProperties"]
        else:
            complete = False
    for key in ("oneOf", "anyOf", "allOf"):
        if key in node:
            branches = node[key]
            if not isinstance(branches, list) or len(branches) > 24:
                complete = False
                continue
            result[key] = []
            for branch in branches:
                child, ok = _field_schema(schema, branch, depth + 1, seen)
                result[key].append(child)
                complete = complete and ok
    return result, complete


def _variant_details(schema, variants):
    grouped = {}
    for kind, required, allowed, _, node in variants:
        grouped.setdefault(kind, []).append((required, allowed, node))
    details = {}
    for kind, choices in grouped.items():
        shapes = {(required, allowed) for required, allowed, _ in choices}
        if len(shapes) == 1:
            required, allowed = next(iter(shapes))
            projections = []
            for _, _, node in choices:
                fields, complete = {}, len(allowed) <= 64
                for name in allowed[:64]:
                    fields[name], ok = _field_schema(schema, node["properties"][name])
                    complete = complete and ok
                projections.append((fields, complete))
            same = all(projection == projections[0] for projection in projections)
            details[kind] = {"requiredFields": list(required), "allowedFields": list(allowed),
                "fieldSchemas": projections[0][0] if same else {}, "schemaComplete": same and projections[0][1]}
        else:
            # A duplicate tag with conflicting contracts cannot safely pick a
            # branch. Preserve the tag and expose the ambiguity explicitly.
            details[kind] = {"requiredFields": [], "allowedFields": [], "fieldSchemas": {}, "schemaComplete": False}
    return sorted(grouped), details


def operation_schema_feedback(schema, arguments=None):
    """Project only schema facts, with nested facts for a selected outer kind."""
    operation = schema.get("properties", {}).get("operation") if isinstance(schema, dict) else None
    variants = _tagged_variants(schema, operation)
    kinds, details = _variant_details(schema, variants)
    selected = arguments.get("operation") if isinstance(arguments, dict) else None
    selected_kind = selected.get("kind") if isinstance(selected, dict) else None
    # Keep every variant and its field names; bound optional constraint detail.
    # Smaller branches are served first so an unknown tag still receives useful
    # complete alternatives. A selected branch has first claim on the budget.
    budget = 12000
    for kind in sorted(details, key=lambda k: (k != selected_kind, len(json.dumps(details[k]["fieldSchemas"], ensure_ascii=False)), k)):
        detail = details[kind]
        size = len(json.dumps(detail["fieldSchemas"], ensure_ascii=False))
        if size > budget:
            detail["fieldSchemas"] = {}
            detail["schemaComplete"] = False
        else:
            budget -= size
    result = {"allowedOperationKinds": kinds, "operationSchemas": details}
    branches = [node for kind, _, _, _, node in variants if kind == selected_kind]
    if branches:
        # Duplicate inline/ref representations are harmless only if every
        # selected branch describes exactly the same nested contract.
        contracts = []
        for branch in branches:
            command = branch.get("properties", {}).get("command")
            nested = _tagged_variants(schema, command)
            if not nested:
                contracts = []
                break
            contracts.append(_variant_details(schema, nested))
        if contracts and all(contract == contracts[0] for contract in contracts):
            command_kinds, command_details = contracts[0]
            result.update({"allowedCommandKinds": command_kinds, "commandSchemas": command_details})
    return result


def repair_operation_alias(arguments, schema):
    """Replace only an unambiguous schema title/class name with its tag."""
    if not isinstance(arguments, dict) or not isinstance(arguments.get("operation"), dict):
        return arguments
    kind = arguments["operation"].get("kind")
    if not isinstance(kind, str):
        return arguments
    variants = _operation_variants(schema)
    if kind in {row[0] for row in variants}:
        return arguments
    aliases = {}
    for tag, _, _, names in variants:
        for name in names:
            aliases.setdefault(name, set()).add(tag)
    matches = aliases.get(kind, set())
    if len(matches) != 1:
        return arguments
    result = deepcopy(arguments)
    result["operation"]["kind"] = next(iter(matches))
    return result
