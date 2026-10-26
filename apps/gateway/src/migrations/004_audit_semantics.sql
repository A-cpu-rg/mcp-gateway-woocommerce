-- The audit guarantees, recorded where operators look at the data (see broker.ts).
COMMENT ON TABLE audit_log IS
  'Every tool call that reaches an upstream is recorded before it is made (outcome "pending", then its final '
  'outcome); a call that cannot be recorded is refused. Rejected attempts (denied, not_found, auth_rejected) '
  'are recorded best effort: they never reach an upstream, and a failed write is reported in the gateway log. '
  'Arguments and results are never stored.';
COMMENT ON COLUMN audit_log.outcome IS
  'pending = in flight, or the gateway stopped before the outcome was written (the upstream may have acted)';
