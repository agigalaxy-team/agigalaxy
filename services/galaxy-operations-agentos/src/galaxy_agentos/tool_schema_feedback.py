"""Safe operation-discriminator facts derived from a native Function schema.

The schema is program-owned; model input is never included in feedback.
"""
from copy import deepcopy


def _pointer(root, ref):
    if not isinstance(ref, str) or not ref.startswith("#/"):
        return None
    value = root
    for part in ref[2:].split("/"):
        if not isinstance(value, dict):
            return None
        value = value.get(part.replace("~1", "/").replace("~0", "~"))
    return value if isinstance(value, dict) else None


def _operation_variants(schema):
    if not isinstance(schema, dict):
        return []
    operation = schema.get("properties", {}).get("operation")
    if not isinstance(operation, dict):
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
            target = _pointer(schema, ref)
            visit(target, ref.rsplit("/", 1)[-1].replace("~1", "/").replace("~0", "~"))
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
                    tuple(k for k in (node.get("title"), ref_name) if isinstance(k, str) and k)))
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

    visit(operation)
    return variants


def operation_schema_feedback(schema):
    """Return allowed tags and per-tag fields from the actual native schema."""
    variants = _operation_variants(schema)
    grouped = {}
    for kind, required, allowed, _ in variants:
        grouped.setdefault(kind, set()).add((required, allowed))
    details = {}
    for kind, choices in grouped.items():
        if len(choices) == 1:
            required, allowed = next(iter(choices))
            details[kind] = {"requiredFields": list(required), "allowedFields": list(allowed)}
    return {"allowedOperationKinds": sorted(grouped), "operationSchemas": details}


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
