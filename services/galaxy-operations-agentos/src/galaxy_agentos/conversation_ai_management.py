"""Typed AI role-management input. Prompts are configured by managers."""
from typing import Literal
from pydantic import BaseModel, ConfigDict
from .duty_role_tools import RoleCommand

class AiRoleCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["ai-role-command"]
    command: RoleCommand
