"""Audit appends participate in the caller's transaction; this module never commits."""
from app.models import AuditLog

def append_audit(session, scope, action, resource_id, operator_id=None):
    actor = operator_id or scope.operator_id
    if actor is None:
        raise RuntimeError('An authenticated operator is required for an audited write')
    event = AuditLog(business_id=scope.business_id,operator_id=actor,action=action,resource_id=resource_id)
    session.add(event)
    session.flush()
    return event
