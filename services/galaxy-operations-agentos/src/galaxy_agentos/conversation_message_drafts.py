"""Closed human-reviewed messaging drafts; no identity or automation input."""
from typing import Annotated, Literal, Union
import re
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, field_validator


class Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


def text(maximum):
    return Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=maximum)]


def readable(value):
    if any(ord(char) < 32 and char not in "\n\t\r" for char in value):
        raise ValueError("agentos_messaging_text_invalid")
    return value


def unique(values):
    if len(set(values)) != len(values):
        raise ValueError("agentos_messaging_duplicate_selection")
    return values


class DraftContent(Closed):
    purpose: Literal["maintenance", "service-update", "community-update"]
    title: text(160)
    body: text(8000)
    href: Annotated[str, Field(max_length=2048)] | None = None
    expiresAt: AwareDatetime

    @field_validator("title", "body")
    @classmethod
    def content_text(cls, value):
        return readable(value)

    @field_validator("href")
    @classmethod
    def internal_link(cls, value):
        if value is not None and (not value.startswith("/") or value.startswith("//")
                or re.search(r"[\s\\\x00-\x1f\x7f-\x9f]", value) or re.match(r"^/(?:api|v1|v2|admin)(?:/|$)", value)):
            raise ValueError("agentos_messaging_link_invalid")
        return value


class AllAccounts(Closed):
    kind: Literal["all-accounts"]


class SelectedAccounts(Closed):
    kind: Literal["accounts"]
    accountIds: Annotated[list[UUID], Field(min_length=1, max_length=500)]

    @field_validator("accountIds")
    @classmethod
    def selected_unique(cls, value):
        return unique(value)


class SubjectTypes(Closed):
    kind: Literal["attributes"]
    subjectTypes: Annotated[list[Literal["person", "agent", "organization"]], Field(min_length=1, max_length=3)]

    @field_validator("subjectTypes")
    @classmethod
    def selected_unique(cls, value):
        return unique(value)


class Immediate(Closed):
    kind: Literal["immediate"]


class Once(Closed):
    kind: Literal["once"]
    at: AwareDatetime


class Recurring(Closed):
    kind: Literal["recurring"]
    cron: text(160)
    timezone: Annotated[str, Field(min_length=1, max_length=100, description="A current valid IANA time zone; Node validates the real schedule.")]

    @field_validator("cron")
    @classmethod
    def cron_text(cls, value):
        return readable(value)


class MessageDraftConfig(Closed):
    channels: Annotated[list[Literal["announcement", "inapp", "email"]], Field(min_length=1, max_length=3)]
    content: DraftContent
    audience: Annotated[Union[AllAccounts, SelectedAccounts, SubjectTypes], Field(discriminator="kind")]
    senderKey: Literal["account", "notice", "community", "updates", "team"] = "notice"
    schedule: Annotated[Union[Immediate, Once, Recurring], Field(discriminator="kind")]

    @field_validator("channels")
    @classmethod
    def channels_unique(cls, value):
        return unique(value)


class MessageDraftCreate(Closed):
    kind: Literal["message-draft-create"]
    config: MessageDraftConfig


class MessageDraftSave(Closed):
    kind: Literal["message-draft-save"]
    targetId: UUID
    config: MessageDraftConfig
