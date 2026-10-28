package feedback

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/jackc/pgx/v5"
)

// RiverTaskProducer is optional startup wiring. Its methods enqueue in the
// actual upload/delete transaction; neither construction nor production starts
// workers or changes the administrative cutover gate.
type RiverTaskProducer struct{ Queue *jobs.Queue }

func (p *RiverTaskProducer) enqueue(ctx context.Context, tx pgx.Tx, t jobs.Task) error {
	if p == nil || p.Queue == nil {
		return fault.New("operations_job_consumer_unavailable", 503)
	}
	_, e := p.Queue.EnqueueWithin(ctx, tx, t, time.Time{})
	return e
}
func (p *RiverTaskProducer) AttachmentScanWithin(ctx context.Context, tx pgx.Tx, endpoint, attachment, submission string) error {
	return p.enqueue(ctx, tx, sourceTask(endpoint, jobs.FeedbackScan, attachment, submission))
}
func (p *RiverTaskProducer) OwnerDeletionWithin(ctx context.Context, tx pgx.Tx, endpoint, operation, attachment string) error {
	return p.enqueue(ctx, tx, sourceTask(endpoint, jobs.FeedbackOwnerDeletion, attachment, operation))
}
