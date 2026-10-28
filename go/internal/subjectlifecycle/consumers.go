package subjectlifecycle

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountsocial"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/jackc/pgx/v5"
)

type OwnerReader func(context.Context, pgx.Tx, Actor, string, string, time.Time, int) ([]Object, error)

// ReadingBookmarks reuses the migrated owner reader. The lifecycle ticket
// applies its original upper bound in addition to that reader's cutoff.
func ReadingBookmarks(dataset string) OwnerReader {
	return func(ctx context.Context, tx pgx.Tx, a Actor, after, through string, cutoff time.Time, limit int) ([]Object, error) {
		rows, e := accountsocial.SubjectExportWithin(ctx, tx, a.SubjectID, dataset, after, cutoff, limit)
		if e != nil {
			return nil, e
		}
		out := []Object{}
		field := "id"
		if dataset == "reading-bookmark-operations" {
			field = "operation_id"
		}
		for _, row := range rows {
			key := text(row[field])
			if key <= through {
				row["export_cursor"] = key
				out = append(out, row)
			}
		}
		return out, nil
	}
}

// MigratedDeletionConsumers exposes the existing two-table consumer only for
// composition under the complete maintenance inventory/approval transaction.
// Execute never invokes this independently or marks a request complete.
func MigratedReadingDeletion(ctx context.Context, tx pgx.Tx, subject string, limit int) (Object, error) {
	return accountsocial.DeleteSubjectWithin(ctx, tx, subject, limit)
}

func ProfileStatements(ctx context.Context, tx pgx.Tx, a Actor, after, through string, cutoff time.Time, limit int) ([]Object, error) {
	rows, e := profiles.ExportSubjectWithin(ctx, tx, a.SubjectID, after, cutoff, limit)
	if e != nil {
		return nil, e
	}
	out := []Object{}
	for _, row := range rows {
		key := text(row["id"])
		if key <= through {
			row["export_cursor"] = key
			out = append(out, row)
		}
	}
	return out, nil
}
func MigratedProfileDeletion(ctx context.Context, tx pgx.Tx, subject string, limit int) (Object, error) {
	return profiles.DeleteSubjectWithin(ctx, tx, subject, limit)
}
