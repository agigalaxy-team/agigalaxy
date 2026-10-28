package subjectlifecycle

import "context"

type ChatSubjectEraser interface {
	EraseSubject(context.Context, string, int) (map[string]any, error)
}
type AttachmentSubjectEraser interface {
	EraseSubject(context.Context, string) (map[string]any, error)
}

// OriginalDeletionTransports fills only the original two transport slots.
// Each owning adapter retains its persisted object/Prosody receipt semantics.
// Forum/outcome cleanup is not silently folded into this attachment receipt.
func OriginalDeletionTransports(chat ChatSubjectEraser, files AttachmentSubjectEraser) DeletionTransports {
	var out DeletionTransports
	if chat != nil {
		out.Chat = chat.EraseSubject
	}
	if files != nil {
		out.Attachments = func(ctx context.Context, subject string, _ int) (Object, error) {
			return files.EraseSubject(ctx, subject)
		}
	}
	return out
}
