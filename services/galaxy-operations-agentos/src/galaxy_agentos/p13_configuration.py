"""Model-facing shape generated from the shared P13 strategy contract.

The owning Go service validates all custom refinements and authorization.
"""
import json
from pathlib import Path
from typing import Annotated
from pydantic import WithJsonSchema

_SCHEMA = json.loads(Path(__file__).with_name("p13_configuration_schema.json").read_text(encoding="utf-8"))
P13Configuration = Annotated[dict, WithJsonSchema(_SCHEMA)]
