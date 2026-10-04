// The latest conversation author determines whether an open ticket still needs
// an admin reply. Reply rows are indexed by ticket_uuid and ordered by id.
export const OPEN_TICKET_NEEDS_ADMIN_REPLY = `NOT EXISTS (
  SELECT 1 FROM support_ticket_replies r
  WHERE r.ticket_uuid=t.uuid AND r.replied_by_type='admin'
    AND NOT EXISTS (
      SELECT 1 FROM support_ticket_replies newer
      WHERE newer.ticket_uuid=t.uuid AND newer.id > r.id
    )
)`;
