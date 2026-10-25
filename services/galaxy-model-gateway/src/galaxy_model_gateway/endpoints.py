"""Derive protocol paths in memory; never change saved input, host or key."""
import re
from urllib.parse import urlsplit, urlunsplit


def protocol_base(address, api_format):
    url = urlsplit(address)
    path = url.path.rstrip("/")
    if api_format == "gemini":
        path = re.sub(r"/models/[^/]+:(?:streamGenerateContent|generateContent)$", "", path)
    else:
        path = re.sub(r"/(?:chat/completions|responses|messages)$", "", path)
    if not path:
        path = "/v1beta" if api_format == "gemini" else "/v1" if api_format.startswith("openai-") else ""
    return urlunsplit((url.scheme, url.netloc, path, url.query, url.fragment))


def normalize_routes(models, profiles):
    # Existing applied versions receive the same derivation as newly compiled
    # versions. This does not rewrite metadata or change scenario assignments.
    for row in models:
        profile = profiles.get(row["model_name"])
        if profile:
            params = row["litellm_params"]
            params["api_base"] = protocol_base(params["api_base"], profile["apiFormat"])
