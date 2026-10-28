package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/jackc/pgx/v5"
)

// OperationsAttachmentWithin retains the original current anonymous source and
// storage-integrity checks on both sides of the external read. The operator
// callback owns current management permission, never file-author authority.
func (f *AttachmentService) OperationsAttachmentWithin(ctx context.Context, tx pgx.Tx, source Object, id string, authorize func() error) (AttachmentContent, error) {
	var out AttachmentContent
	if e := f.configured(); e != nil {
		return out, e
	}
	check := func() (Object, error) {
		if e := authorize(); e != nil {
			return nil, e
		}
		r, e := f.row(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		current := *f.Forum
		current.actor = nil
		current.Authority = nil
		if e = f.readable(ctx, tx, &current, "", r, source); e != nil {
			return nil, e
		}
		return r, nil
	}
	r, e := check()
	if e != nil {
		return out, e
	}
	b, e := f.Store.Get(ctx, str(r, "storage_key"), str(r, "encryption_key_id"), num(r, "byte_size"))
	if e != nil {
		return out, e
	}
	if b == nil || attachments.Digest(b) != str(r, "sha256") {
		return out, fail("attachment_storage_integrity_failed", 502)
	}
	r, e = check()
	if e != nil {
		return out, e
	}
	return AttachmentContent{Bytes: b, Name: str(r, "name"), MediaType: str(r, "media_type"), SHA256: str(r, "sha256"), AttachmentID: id}, nil
}
