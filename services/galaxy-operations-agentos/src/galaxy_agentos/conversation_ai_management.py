"""Closed AI-only management input; Node binds authority, versions and results."""
from typing import Annotated, Literal
from uuid import UUID

from agno.run.base import RunContext
from agno.tools.function import FunctionCall
from pydantic import BaseModel, ConfigDict, Field

from .duty_role_tools import RoleCommand


class AiWorkPromptSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["ai-work-prompt-save"]
    aiAccountId: UUID
    prompt: Annotated[str, Field(max_length=16000)]


class AiRoleCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["ai-role-command"]
    command: RoleCommand


class AiPromptCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    aiAccountId: UUID
    expectedRevision: Annotated[int, Field(ge=1, strict=True)]
    expectedPromptVersion: Annotated[int, Field(ge=1, strict=True)]
    prompt: Annotated[str, Field(max_length=16000)]


def manage_ai_prompt(gateway):
    def manage_ai_prompt(run_context: RunContext, fc: FunctionCall, command: AiPromptCommand) -> str:
        """Update one other AI's ordinary role prompt under explicit delegation.

        First use current_summary and read_ai_delegation(ai_account_id=...)
        to read actual capability, selected target, config revision and prompt
        version. Node rechecks current role, prompt-update delegation, approved
        target list, plan/grant and CAS. This cannot change model/provider,
        fixed boundaries, goals, scheduling or other settings. Node supplies
        the stable operation ID. Waiting/unknown is not a completed change.
        """
        from .duties import _call
        return _call(gateway, run_context, fc, "manage-ai-prompt", command.model_dump(mode="json"))
    return manage_ai_prompt
