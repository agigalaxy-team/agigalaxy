
CREATE UNIQUE INDEX audit_http_failure_request ON audit_events(http_request_id,action)
  WHERE action IN ('http.rejected','http.failed');
