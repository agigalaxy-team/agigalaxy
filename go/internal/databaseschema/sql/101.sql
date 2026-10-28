
CREATE INDEX business_admin_action_audit_v1 ON business_admin_audit_v1(endpoint,action,sequence DESC);
CREATE INDEX business_admin_date_audit_v1 ON business_admin_audit_v1(endpoint,created_at,sequence DESC);
