-- Runtime projections follow real committed work, independently of routine enablement.
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR DELETE ON operations_autonomy_tasks_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('autonomy');
CREATE TRIGGER web_event_runtime_update_v1 AFTER UPDATE ON operations_autonomy_tasks_v1 FOR EACH ROW
WHEN ((OLD.state,OLD.model_state,OLD.business_state,OLD.summary,OLD.effective_check,OLD.model_usage,OLD.completed_at,OLD.code,OLD.control_state)
 IS DISTINCT FROM (NEW.state,NEW.model_state,NEW.business_state,NEW.summary,NEW.effective_check,NEW.model_usage,NEW.completed_at,NEW.code,NEW.control_state))
EXECUTE FUNCTION galaxy_web_event_capture_v1('autonomy');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_autonomy_dispatches_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('autonomy');
CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON operations_autonomy_configs_v1 FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('autonomy');
