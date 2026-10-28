package operationspermissions

import "context"

// QueryRead keeps human query proofs on their owning permissions service. A
// genuine Duty query uses the same current Duty authority through a closed
// read facade; no HTTP authorizer or command is exposed by this port.
func (s *Service) QueryRead(ctx context.Context, a Actor, view, id string) (Object, error) {
	reader := s
	if s.Duty != nil && s.Duty.AcceptsDuty(a) {
		reader = &Service{Pool: s.Pool, Endpoint: s.Endpoint, Authority: &BusinessAuthority{Duty: s.Duty}, StoredAuthority: s.StoredAuthority, Now: s.Now, AIWork: s.AIWork, RuntimeStatus: s.RuntimeStatus, Duty: s.Duty}
	}
	switch view {
	case "roles":
		return reader.Roles(ctx, a)
	case "personnel":
		return reader.Personnel(ctx, a)
	case "automation":
		return reader.Automation(ctx, a)
	case "role":
		return reader.Role(ctx, a, id)
	}
	return nil, invalid()
}
