package workerconfig

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/communitygrowth"
)

func (r *Runtime) adoptCommunityGrowth() {
	s := &communitygrowth.Service{Pool: r.Pool, Endpoint: r.configuration.Endpoint, Forum: r.Forum, WorkerPublicRead: true}
	assessment := &communitygrowth.AssessmentService{Service: s, ReadSourceWithin: s.AssessmentSourceWithin}
	s.OnSourceWithin = assessment.SourceChangedWithin
	r.Growth = &communitygrowth.Worker{Service: s, Forum: r.Forum, BatchSize: 100}
	r.Assessment = &communitygrowth.AssessmentWorker{Service: assessment}
	if r.Autonomy != nil {
		r.Autonomy.Service.ConnectCommunityAssessments(assessment)
	}
}

// Pending source changes are bounded pages on the existing worker loop. A
// completed historical pass waits between scans; dirty objects still progress
// immediately. These are background projections, not page refresh schedules.
func (r *Runtime) communityGrowthMaintenance(ctx context.Context) {
	if r.Growth == nil {
		return
	}
	var dirty bool
	if time.Now().Before(r.nextGrowthReconcile) {
		if e := r.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_growth_dirty_objects_v1 WHERE endpoint=$1)`, r.configuration.Endpoint).Scan(&dirty); e != nil {
			maintenanceFailure(r.configuration, "community-growth-pending", e)
			return
		}
	}
	if dirty || !time.Now().Before(r.nextGrowthReconcile) {
		result, e := r.Growth.Step(ctx)
		if e != nil {
			maintenanceFailure(r.configuration, "community-growth-source", e)
		} else if result["cycleComplete"] == true {
			r.nextGrowthReconcile = time.Now().Add(time.Minute)
		}
	}
	if ctx.Err() == nil && r.Assessment != nil {
		if _, e := r.Assessment.Step(ctx); e != nil {
			maintenanceFailure(r.configuration, "community-assessment", e)
		}
	}
}
