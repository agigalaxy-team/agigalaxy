package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/subjectlifecycle"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The maintenance agent already owns the restore and its lock. This bridge
// only connects to a private clone socket; it never accepts a network URL.
type recoveryInput struct {
	Mode            string                         `json:"mode"`
	SocketDirectory string                         `json:"socketDirectory"`
	Database        string                         `json:"database"`
	User            string                         `json:"user"`
	Endpoint        string                         `json:"endpoint"`
	RecoveryID      string                         `json:"recoveryId"`
	ForumPolicyFile string                         `json:"forumPolicyFile"`
	SourceMetadata  *discovery.SourceMetadata      `json:"sourceMetadata"`
	Ledger          json.RawMessage                `json:"ledger"`
	Command         subjectlifecycle.ReplayCommand `json:"command"`
	Reference       discovery.Reference            `json:"reference"`
	Projection      recoveryProjection             `json:"projection"`
	Receipts        []recoveryReceipt              `json:"receipts"`
	At              int64                          `json:"at"`
}

type recoveryReceipt struct {
	RoomID         string `json:"roomId"`
	MessageID      string `json:"messageId"`
	ArchiveDeleted bool   `json:"archiveDeleted"`
}
type recoveryProjection struct {
	Messages []struct {
		RoomID    string `json:"roomId"`
		MessageID string `json:"messageId"`
		Erase     bool   `json:"erase"`
	} `json:"messages"`
	DeletedSubjects []struct {
		SubjectID string `json:"subjectId"`
		RequestID string `json:"requestId"`
	} `json:"deletedSubjects"`
}
type acknowledgedArchive map[string]bool

func (a acknowledgedArchive) Available() bool { return true }
func (a acknowledgedArchive) Command(_ context.Context, action string, input chat.Object) (chat.Object, error) {
	if action != "erase" || !a[fmt.Sprint(input["roomId"])+":"+fmt.Sprint(input["messageId"])] {
		return nil, errors.New("unconfirmed archive receipt")
	}
	return chat.Object{"archiveDeleted": true}, nil
}
func reconcileRecoveryChat(ctx context.Context, pool *pgxpool.Pool, in recoveryInput) (any, error) {
	if in.At < 0 || in.At > time.Now().Unix()+60 || len(in.Receipts) > 100000 || len(in.Projection.Messages) > 100000 || len(in.Projection.DeletedSubjects) > 100000 {
		return nil, errors.New("invalid recovery projection")
	}
	accepted := acknowledgedArchive{}
	for _, row := range in.Receipts {
		key := row.RoomID + ":" + row.MessageID
		if _, e := uuid.Parse(row.RoomID); e != nil {
			return nil, e
		}
		if _, e := uuid.Parse(row.MessageID); e != nil || !row.ArchiveDeleted || accepted[key] {
			return nil, errors.New("invalid archive receipt")
		}
		accepted[key] = true
	}
	for _, row := range in.Projection.Messages {
		if row.Erase && !accepted[row.RoomID+":"+row.MessageID] {
			return nil, errors.New("archive receipt missing")
		}
	}
	service := chat.Service{Pool: pool, Transport: accepted, Now: func() time.Time { return time.Unix(in.At, 0) }}
	for _, target := range in.Projection.DeletedSubjects {
		if _, e := uuid.Parse(target.RequestID); e != nil {
			return nil, e
		}
		complete := false
		for i := 0; i <= 100; i++ {
			result, e := service.EraseSubject(ctx, target.SubjectID, 1000)
			if e != nil {
				return nil, e
			}
			if result["complete"] == true {
				complete = true
				break
			}
		}
		if !complete {
			return nil, errors.New("chat erasure incomplete")
		}
	}
	for _, row := range in.Projection.Messages {
		if row.Erase {
			_, e := pool.Exec(ctx, "UPDATE chat_message_refs SET state=CASE WHEN state IN ('pending','accepted') AND expires_at<=$2 THEN 'expired' ELSE state END,purge_pending=true WHERE message_id=$1 AND room_id=$3 AND (state IN ('retracted','expired') OR expires_at<=$2)", row.MessageID, time.Unix(in.At, 0), row.RoomID)
			if e != nil {
				return nil, e
			}
			if e = service.PurgeOne(ctx, row.MessageID); e != nil {
				return nil, e
			}
		}
	}
	return map[string]any{"currentRoomTransitionsApplied": true, "actualNativeReceipts": len(accepted), "serviceWideDeletionComplete": false}, nil
}

var recoveryName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$`)

func privateSocket(dir, recoveryID string) error {
	if _, e := uuid.Parse(recoveryID); e != nil {
		return errors.New("invalid recovery id")
	}
	if !filepath.IsAbs(dir) || filepath.Clean(dir) != dir || !strings.HasSuffix(filepath.ToSlash(dir), "/maintenance-"+recoveryID+"/sockets/business") {
		return errors.New("invalid recovery socket")
	}
	for p := dir; ; p = filepath.Dir(p) {
		info, e := os.Lstat(p)
		if e != nil || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("invalid recovery socket")
		}
		if p == filepath.Dir(p) {
			break
		}
	}
	info, e := os.Lstat(filepath.Join(dir, ".s.PGSQL.5432"))
	if e != nil || info.Mode()&os.ModeSocket == 0 {
		return errors.New("invalid recovery socket")
	}
	marker := filepath.Join(filepath.Dir(filepath.Dir(dir)), "restore.json")
	info, e = os.Lstat(marker)
	if e != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 1048576 {
		return errors.New("invalid recovery marker")
	}
	raw, e := os.ReadFile(marker)
	if e != nil {
		return errors.New("invalid recovery marker")
	}
	var restore struct {
		State            string `json:"state"`
		PublicActivation bool   `json:"publicActivation"`
		Databases        []struct {
			Stanza          string `json:"stanza"`
			SocketDirectory string `json:"socketDirectory"`
			Network         string `json:"network"`
			Ports           []int  `json:"ports"`
		} `json:"databases"`
	}
	if json.Unmarshal(raw, &restore) != nil || restore.State != "isolated" || restore.PublicActivation {
		return errors.New("invalid recovery marker")
	}
	matched := 0
	for _, db := range restore.Databases {
		if db.Stanza == "business" && db.SocketDirectory == dir && db.Network == "none" && db.Ports != nil && len(db.Ports) == 0 {
			matched++
		}
	}
	if matched != 1 {
		return errors.New("invalid recovery marker")
	}
	return nil
}
func recoveryPool(ctx context.Context, in recoveryInput) (*pgxpool.Pool, error) {
	if privateSocket(in.SocketDirectory, in.RecoveryID) != nil || !recoveryName.MatchString(in.Database) || !recoveryName.MatchString(in.User) {
		return nil, errors.New("invalid recovery target")
	}
	cfg, e := pgxpool.ParseConfig("postgres://localhost/postgres?sslmode=disable")
	if e != nil {
		return nil, e
	}
	cfg.ConnConfig.Host = in.SocketDirectory
	cfg.ConnConfig.Port = 5432
	cfg.ConnConfig.Database = in.Database
	cfg.ConnConfig.User = in.User
	cfg.ConnConfig.Password = ""
	cfg.ConnConfig.Fallbacks = nil
	cfg.MaxConns = 1
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		return nil, e
	}
	var db, listen, archive string
	e = pool.QueryRow(ctx, "SELECT current_database(),current_setting('listen_addresses'),current_setting('archive_mode')").Scan(&db, &listen, &archive)
	if e != nil || db != in.Database || listen != "" || archive != "off" {
		pool.Close()
		return nil, errors.New("recovery clone isolation unconfirmed")
	}
	return pool, nil
}
func recoveryQuarantine(ctx context.Context, pool *pgxpool.Pool, id string) error {
	var count int
	e := pool.QueryRow(ctx, "SELECT count(*) FROM recovery_state WHERE singleton=true AND recovery_id=$1::uuid AND status='quarantined'", id).Scan(&count)
	if e != nil || count != 1 {
		return errors.New("recovery quarantine mismatch")
	}
	return nil
}
func recoveryBridge(ctx context.Context, stdin io.Reader, stdout io.Writer) error {
	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 4096), 24*1024*1024)
	enc := json.NewEncoder(stdout)
	var sourcePool *pgxpool.Pool
	var sourceTarget string
	defer func() {
		if sourcePool != nil {
			sourcePool.Close()
		}
	}()
	for scanner.Scan() {
		var in recoveryInput
		if e := protocol.Decode(scanner.Bytes(), &in); e != nil {
			return e
		}
		if in.Mode == "ledger-columns" {
			if e := enc.Encode(map[string]any{"result": subjectlifecycle.DeletionLedgerColumns()}); e != nil {
				return e
			}
			continue
		}
		if in.Mode == "ledger-validate" {
			ledger, e := subjectlifecycle.ValidateDeletionLedger(in.Ledger, nil)
			if e != nil {
				return e
			}
			if e = enc.Encode(map[string]any{"result": map[string]any{"capturedAt": ledger.CapturedAt, "requests": len(ledger.Tables["deletion_requests"])}}); e != nil {
				return e
			}
			continue
		}
		target := in.SocketDirectory + "\x00" + in.Database + "\x00" + in.User
		var pool *pgxpool.Pool
		var e error
		if in.Mode == "source" && sourcePool != nil {
			if target != sourceTarget {
				return errors.New("recovery source target changed")
			}
			pool = sourcePool
		} else {
			pool, e = recoveryPool(ctx, in)
			if e == nil && in.Mode == "source" {
				sourcePool = pool
				sourceTarget = target
			}
		}
		if e != nil {
			return e
		}
		var result any
		switch in.Mode {
		case "migrate":
			result, e = databaseschema.Migrate(ctx, pool, []string{"api", "worker", "deletion-review", "content-publisher"})
		case "replay":
			if e = recoveryQuarantine(ctx, pool, in.RecoveryID); e == nil {
				var raw []byte
				raw, e = protocol.EncodeJS(in.Command)
				if e == nil {
					var productDeletion *subjectlifecycle.ProductDeletion
					productDeletion, e = product(pool, in.Endpoint, func(name string) string {
						if name == "GALAXY_FORUM_POLICY_FILE" {
							return in.ForumPolicyFile
						}
						return ""
					})
					if e == nil {
						result, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (map[string]any, error) {
							return subjectlifecycle.ReplayDeletionLedgerWithin(ctx, tx, in.Ledger, raw, timeNow(), productDeletion, nil)
						})
					}
				}
			}
		case "source":
			if in.SourceMetadata == nil || in.SourceMetadata.ModeratorIDs == nil || in.SourceMetadata.IdentityProviders == nil {
				e = errors.New("discovery source metadata required")
			} else if e = recoveryQuarantine(ctx, pool, in.RecoveryID); e == nil {
				var policy community.Object
				policy, e = community.LoadForumPolicy(in.ForumPolicyFile)
				if e == nil {
					forum := &community.Service{Pool: pool, Endpoint: in.Endpoint, Policy: policy, ModeratorIDs: append([]string(nil), in.SourceMetadata.ModeratorIDs...)}
					for _, provider := range in.SourceMetadata.IdentityProviders {
						forum.IdentityProviders = append(forum.IdentityProviders, community.IdentityProvider{Issuer: provider.Issuer, ClientID: provider.ClientID})
					}
					source := discovery.CommunitySource{Pool: pool, Forum: forum, Endpoint: in.Endpoint, Worker: true}
					result, e = source.Load(ctx, in.Reference)
				}
			}
		case "chat-reconcile":
			if e = recoveryQuarantine(ctx, pool, in.RecoveryID); e == nil {
				result, e = reconcileRecoveryChat(ctx, pool, in)
			}
		default:
			e = errors.New("unknown recovery action")
		}
		if pool != sourcePool {
			pool.Close()
		}
		if e != nil {
			return e
		}
		if e = enc.Encode(map[string]any{"result": result}); e != nil {
			return e
		}
	}
	if e := scanner.Err(); e != nil {
		return e
	}
	return nil
}
func timeNow() int64 { return time.Now().Unix() }
