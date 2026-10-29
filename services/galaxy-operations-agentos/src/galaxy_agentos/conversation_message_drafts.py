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
    """Create a message-plan draft with inapp, email or announcement channels and a schedule.

    The inapp channel belongs to the plan; it does not create a standalone notice draft.
    Creating the draft does not activate or deliver it; a prepared card requires human confirmation.
    """
    kind: Literal["message-draft-create"]
    config: MessageDraftConfig


class MessageDraftSave(Closed):
    """Save the selected message plan's draft configuration; this does not activate or deliver it.

    A message plan may use inapp, email or announcement channels and a schedule; inapp does not make it a standalone notice.
    Read the selected message-plan lifecycle for current preparation options.
    A prepared card requires human confirmation; an unknown result is checked by its original operation.
    """
    kind: Literal["message-draft-save"]
    targetId: UUID = Field(description="The selected existing message plan ID.")
    config: MessageDraftConfig


class NoticeContent(DraftContent):
    # Notice content intentionally retains whitespace, unlike plan drafts.
    title: Annotated[str, Field(min_length=1, max_length=160)]
    body: Annotated[str, Field(min_length=1, max_length=8000)]
    audience: Annotated[Union[AllAccounts, SelectedAccounts], Field(discriminator="kind")]


class NoticeDraftCreate(Closed):
    """Create a standalone inapp notice draft, not a multi-channel or scheduled message plan.

    Publishing requires review and human confirmation through the notice-state operation.
    """
    kind: Literal["notice-draft-create"]
    content: NoticeContent


class NoticeDraftSave(Closed):
    """Save a specific standalone inapp notice draft and its expected version.

    This neither publishes the notice nor creates a multi-channel or scheduled message plan.
    """
    kind: Literal["notice-draft-save"]
    targetId: UUID
    expectedVersion: Annotated[int, Field(strict=True, ge=1, le=2147483646)]
    content: NoticeContent


class NoticeState(Closed):
    """Prepare publish or withdraw for a specific inapp notice version.

    The card requires human confirmation. The notice action does not activate or stop
    a multi-channel message plan, nor does it change the notice's parent plan.
    """
    kind: Literal["notice-state"]
    targetId: UUID
    expectedVersion: Annotated[int, Field(strict=True, ge=1, le=2147483646)]
    action: Literal["publish", "withdraw"]
