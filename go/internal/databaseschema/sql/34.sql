
ALTER TABLE builder_events DROP CONSTRAINT builder_events_kind_check;
ALTER TABLE builder_events ADD CONSTRAINT builder_events_kind_check
  CHECK(kind IN ('declare','maintenance','heartbeat','compatibility','node-control','node-control-revoke','work-evidence','work-evidence-revoke'));
