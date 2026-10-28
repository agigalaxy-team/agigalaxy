package evidence

import "github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"

// budgetPolicy captures one immutable policy for the original claim transaction.
func (s *Service) budgetPolicy() *resourcebudget.Policy {
	p := s.ResourceBudgetPolicy
	if s.BudgetPolicyNow != nil {
		p = s.BudgetPolicyNow()
	}
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
