"""A single per-run state object shared across Agno's metadata copies."""

TURN_STATE = "_galaxyConversationTurnState"
PLAN = "_galaxyTurnPlan"
ASSESSMENT = "_galaxyTurnAssessment"
ACTIVITY = "_galaxyTurnActivity"
PREPARED_CARD_IDS = "_galaxyPreparedCardIds"
PREPARED_FINGERPRINTS = "_galaxyPreparedFingerprints"
PREPARE_UNKNOWN = "_galaxyPrepareUnknown"
RECEIPT_FEEDBACK = "_galaxyReceiptFeedback"

def turn_state(value):
    if value is None: return {}
    metadata = getattr(value, "metadata", None)
    if not isinstance(metadata, dict):
        metadata = {}
        value.metadata = metadata
    operation_id = metadata.get("operationId")
    run_id = getattr(value, "run_id", None)
    state = metadata.get(TURN_STATE)
    if not isinstance(state, dict) or state.get("operationId") != operation_id or state.get("runId") != run_id:
        state = {"operationId": operation_id, "runId": run_id}
        metadata[TURN_STATE] = state
    return state

def bind_turn_state(run, context):
    if (run.run_id != context.run_id or run.session_id != context.session_id or run.user_id != context.user_id
            or (run.metadata or {}).get("operationId") != (context.metadata or {}).get("operationId")):
        raise ValueError("agentos_conversation_turn_state_mismatch")
    state = turn_state(context)
    if run.metadata is None: run.metadata = {}
    run.metadata[TURN_STATE] = state
    return state
