"""Atomic tools for an explicitly granted, existing ordinary strategy.

The server supplies the configuration and numeric authorization bounds. A
model can propose only existing parameter values, an allowed mode or daily
enable/disable. Goals, bounds and important decisions have no tool here.
"""
import json
from uuid import UUID, NAMESPACE_URL, uuid5

from agno.run.base import RunContext

from .gateway import AuthorityDenied


def strategy_tools(gateway):
    def send(context, name, values):
        strategy = str(UUID(values["strategyId"]))
        values = {**values, "strategyId": strategy}
        if name != "read-selected-strategy":
            # A repeated identical tool intent in this native run retains its
            # operation ID. The Node transaction remains the result authority.
            intent = json.dumps(values, sort_keys=True, separators=(",", ":"))
            values["operationId"] = str(uuid5(NAMESPACE_URL,
                "galaxy:p13:" + str(context.run_id) + ":" + name + ":" + intent))
        return json.dumps(gateway.tool(context.user_id, name, values,
            run_id=context.run_id, call_id=name + ":" + strategy), ensure_ascii=False)

    def read_selected_strategy(run_context: RunContext, strategy_id: str) -> str:
        """Read one strategy explicitly selected in the current task.

        Returns its real version/revision, goals and human-set ordinary bounds.
        It does not authorize changing those goals or bounds.
        """
        return send(run_context, "read-selected-strategy", {"strategyId": strategy_id})

    def save_selected_strategy_draft(run_context: RunContext, strategy_id: str,
            expected_revision: int, parameter_edits: list[dict],
            mode: str | None = None, enabled: bool | None = None) -> str:
        """Save permitted ordinary changes of the selected current strategy.

        parameter_edits contains {path:[rule indexes],value:integer}; use only
        exact paths and inclusive bounds returned by read_selected_strategy.
        mode must be in its human-declared modes; daily enabled may change only
        when canEnable/canDisable is true. No arbitrary configuration or prose.
        """
        values = {"strategyId": strategy_id, "expectedRevision": expected_revision,
            "parameterEdits": parameter_edits}
        if mode is not None:
            values["mode"] = mode
        if enabled is not None:
            values["enabled"] = enabled
        if not parameter_edits and mode is None and enabled is None:
            raise AuthorityDenied("p13_ordinary_change_required")
        return send(run_context, "save-selected-strategy-draft", values)

    def publish_selected_strategy(run_context: RunContext, strategy_id: str,
            expected_revision: int, version_id: str) -> str:
        """Publish this task's saved ordinary draft after current program rehearsal.

        Only the original task's draft and human-selected qualification samples
        are accepted. New matters use it; already pinned matters keep their plan.
        """
        return send(run_context, "publish-selected-strategy", {"strategyId": strategy_id,
            "expectedRevision": expected_revision, "versionId": str(UUID(version_id))})

    return [read_selected_strategy, save_selected_strategy_draft, publish_selected_strategy]
