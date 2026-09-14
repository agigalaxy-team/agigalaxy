"""Galaxy-authored deterministic SDK fixture, NOT the upstream HelloWorld."""
from a2a.helpers import get_message_text, new_task_from_user_message, new_text_message
from a2a.server.agent_execution import AgentExecutor
from a2a.server.tasks import TaskUpdater
from a2a.types import TaskState


class LifecycleExecutor(AgentExecutor):
    async def execute(self, context, event_queue):
        task = context.current_task
        if not task:
            task = new_task_from_user_message(context.message)
            await event_queue.enqueue_event(task)
        updater = TaskUpdater(event_queue=event_queue, task_id=task.id, context_id=task.context_id)
        command = get_message_text(context.message)
        state = {
            "input": TaskState.TASK_STATE_INPUT_REQUIRED,
            "auth": TaskState.TASK_STATE_AUTH_REQUIRED,
            "work": TaskState.TASK_STATE_WORKING,
            "fail": TaskState.TASK_STATE_FAILED,
            "reject": TaskState.TASK_STATE_REJECTED,
        }.get(command, TaskState.TASK_STATE_COMPLETED)
        await updater.update_status(state=state, message=new_text_message("Synthetic lifecycle: " + command))

    async def cancel(self, context, event_queue):
        task = context.current_task
        updater = TaskUpdater(event_queue=event_queue, task_id=task.id, context_id=task.context_id)
        await updater.update_status(state=TaskState.TASK_STATE_CANCELED, message=new_text_message("Synthetic explicit cancel acknowledged"))
