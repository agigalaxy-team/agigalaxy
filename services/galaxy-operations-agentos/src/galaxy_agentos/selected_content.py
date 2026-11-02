"""Authorized selected-content tools and the original prepared-command review."""
import json
from uuid import UUID
from agno.run.base import RunContext
from agno.workflow import Workflow, Step
from agno.workflow.types import HumanReview, StepInput, StepOutput
from .gateway import AuthorityDenied


def selected_content_tools(gateway, current):
    def read_selected_content(run_context: RunContext, target_kind: str, target_id: str) -> str:
        """Read one explicitly selected, currently readable public post or reply."""
        if target_kind not in {"post", "reply"}:
            raise AuthorityDenied("agentos_tool_arguments_invalid")
        UUID(target_id)
        result = gateway.tool(run_context.user_id, "read-selected-content",
            {"kind": target_kind, "id": target_id}, run_id=run_context.run_id,
            call_id="read:" + target_kind + ":" + target_id)
        return json.dumps(result, ensure_ascii=False)

    def selected_objects(run_context: RunContext) -> str:
        """List the current task's explicitly authorized public object IDs."""
        row = current(run_context)["execution"]
        return json.dumps({"resourceIds": row["resourceIds"], "actions": row["actions"]})

    def search_selected_public_content(run_context: RunContext, target_kind: str,
            query: str, after: int = 0, limit: int = 20) -> str:
        """Locate current public posts/replies within this task's selected IDs.

        Returns identifiers, not snippets. Read a result through
        read_selected_content before using its current source text.
        """
        if target_kind not in {"post", "reply"}:
            raise AuthorityDenied("agentos_tool_arguments_invalid")
        result = gateway.tool(run_context.user_id, "search-selected-public-content",
            {"kind": target_kind, "query": query, "after": after, "limit": limit},
            run_id=run_context.run_id, call_id="selected-public-search")
        return json.dumps(result, ensure_ascii=False)

    return [selected_objects, search_selected_public_content, read_selected_content]


def create_prepared_review(db, gateway, current):
    def prepare(step_input: StepInput, run_context: RunContext) -> StepOutput:
        result = current(run_context)
        if not result.get("execution", {}).get("hasPreparedCommand"):
            raise AuthorityDenied("agentos_prepared_command_required")
        return StepOutput(content={"executionId": result["execution"]["id"], "state": "awaiting-human"})

    def execute(step_input: StepInput, run_context: RunContext) -> StepOutput:
        # No command/body/role is taken from the workflow input or approval JSON.
        # The server-frozen command still checks latest authority, source and CAS.
        current(run_context)
        result = gateway.tool(run_context.user_id, "execute-prepared-command", {},
            run_id=run_context.run_id, call_id="prepared-command")
        return StepOutput(content=result)

    review = Workflow(id="galaxy-prepared-review", name="核对并执行已准备操作", db=db, store_events=True,
        steps=[Step(name="核对当前任务", executor=prepare),
            Step(name="确认并执行", executor=execute,
                human_review=HumanReview(requires_confirmation=True))], telemetry=False)
    return review
