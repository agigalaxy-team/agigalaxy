"""Read only a task's original operation receipt using the bound conversation."""
from uuid import UUID

from agno.run.base import RunContext
from agno.tools.function import FunctionCall


def task_operation_tool(send):
    def read_task_operation(run_context: RunContext, fc: FunctionCall,
                            task_id: UUID, operation_id: UUID) -> str:
        """Read the original task operation's recorded, unknown or not-recorded receipt.

        Supports original feedback updates, public post/reply visibility, file access,
        short account restriction and public-case resolution operations.
        This returns historical receipt metadata, not current object details. Use
        identifiers from an existing task and operation. It never executes, retries
        or resumes the task; unknown does not establish business success.
        """
        return send(run_context, fc, "read-task-operation",
                    {"taskId": str(task_id), "operationId": str(operation_id)})

    return read_task_operation
