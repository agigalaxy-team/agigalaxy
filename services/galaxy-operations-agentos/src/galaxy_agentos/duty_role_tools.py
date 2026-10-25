"""Closed model input for the human-bounded AI-only role delegation."""
from typing import Annotated, Literal, Union
from uuid import UUID

from agno.run.base import RunContext
from agno.tools.function import FunctionCall
from pydantic import BaseModel, ConfigDict, Field, field_validator


class RoleFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedVersion: Annotated[int, Field(ge=0, strict=True)]
    name: Annotated[str, Field(min_length=1, max_length=120)]
    description: Annotated[str, Field(max_length=1000)]
    enabled: bool
    permissions: Annotated[list[Annotated[str, Field(pattern=r"^[a-z][a-z0-9.-]{0,100}$")]], Field(max_length=300)]
    targetAiAccountIds: Annotated[list[UUID], Field(min_length=1, max_length=4)]

    @field_validator("targetAiAccountIds", "permissions")
    @classmethod
    def unique(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("agentos_delegation_duplicates")
        return value


class RoleCreate(RoleFields):
    kind: Literal["role-create"]


class RoleUpdate(RoleFields):
    kind: Literal["role-update"]
    id: UUID


class AssignmentSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["assignment-save"]
    expectedVersion: Annotated[int, Field(ge=0, strict=True)]
    id: UUID | None = None
    aiAccountId: UUID
    roleId: UUID
    enabled: bool


RoleCommand = Annotated[Union[RoleCreate, RoleUpdate, AssignmentSave], Field(discriminator="kind")]


def manage_ai_role(gateway):
    def manage_ai_role(run_context: RunContext, fc: FunctionCall, command: RoleCommand) -> str:
        """Maintain an AI-only role inside the current human-approved delegation.

        First read_ai_delegation for the real target AI IDs, allowed actions,
        grantable permission ceiling and current version. Node refuses shared
        roles, personnel grants, the controlling AI itself and escalation. A
        role name never confers administrator authority. operationId and actor
        are supplied by the original Node ledger, never by the model.
        """
        from .duties import _call
        return _call(gateway, run_context, fc, "manage-ai-role",
            command.model_dump(mode="json", exclude_none=True))
    return manage_ai_role
