package webevents

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"sync"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maximumReplay = 256

var integer = regexp.MustCompile(`^(0|[1-9][0-9]{0,18})$`)

type Principal struct {
	Kind                                              string
	Actor                                             any
	Identity, Endpoint, Surface, AccountID, SubjectID string
}

// Authority must recheck current sessions and permissions on every call without
// extending user activity or read expiry for an SSE heartbeat. Web
// sources require their domain's current read authority, never row existence.
// Admin source location checks are enforced by Service after module authority.
type Authority interface {
	AuthorizeConnection(context.Context, *http.Request, string) (Principal, error)
	AuthorizeModule(context.Context, Principal, string) (bool, error)
	AuthorizeSource(context.Context, Principal, Event) (SourceDecision, error)
}
type SourceDecision uint8

const (
	Denied SourceDecision = iota
	Allowed
	Reset
)

type Event struct {
	Cursor                        string
	Module, SourceTable, Endpoint string
	Ref                           map[string]any
	OperationID                   *string
}
type Frame struct {
	Type        string   `json:"type"`
	Cursor      string   `json:"cursor"`
	Modules     []string `json:"modules,omitempty"`
	Module      string   `json:"module,omitempty"`
	OperationID *string  `json:"operationId,omitempty"`
	ObjectID    string   `json:"objectId,omitempty"`
	ParentID    string   `json:"parentId,omitempty"`
	Version     any      `json:"version,omitempty"`
	Entity      string   `json:"entity,omitempty"`
	TurnID      string   `json:"turnId,omitempty"`
	Reason      string   `json:"reason,omitempty"`
}

// Empty modules are significant on reset/snapshot and always encode as [].
func (f Frame) MarshalJSON() ([]byte, error) {
	type alias Frame
	if f.Type == "change" {
		return json.Marshal(struct {
			alias
			OperationID *string `json:"operationId"`
		}{alias(f), f.OperationID})
	}
	return json.Marshal(struct {
		Type    string   `json:"type"`
		Cursor  string   `json:"cursor"`
		Modules []string `json:"modules"`
		Reason  string   `json:"reason,omitempty"`
	}{f.Type, f.Cursor, append([]string{}, f.Modules...), f.Reason})
}

type Connection struct {
	Principal Principal
	Modules   []string
	request   *http.Request
	topics    []string
}
type Service struct {
	Pool      *pgxpool.Pool
	Endpoint  string
	Authority Authority
}

func Modules(surface string) []string {
	if surface == "admin" {
		return slices.Clone(catalog.Admin)
	}
	return slices.Clone(catalog.Web)
}
func Permission(module string) string { return catalog.Permissions[module] }
func (s *Service) Connect(ctx context.Context, r *http.Request, surface string, topics []string) (*Connection, error) {
	if s.Pool == nil || s.Endpoint == "" || s.Authority == nil {
		return nil, fault.New("web_events_authority_unavailable", 503)
	}
	p, e := s.Authority.AuthorizeConnection(ctx, r, surface)
	if e != nil {
		return nil, e
	}
	if p.Identity == "" || p.Endpoint != s.Endpoint || p.Surface != surface {
		return nil, fault.New("web_events_access_denied", 403)
	}
	allowed := Modules(surface)
	if len(topics) == 0 {
		topics = allowed
	}
	seen := map[string]bool{}
	if len(topics) > 32 {
		return nil, fault.New("invalid_web_events_topics", 400)
	}
	modules := []string{}
	for _, topic := range topics {
		if seen[topic] || !slices.Contains(allowed, topic) {
			return nil, fault.New("invalid_web_events_topics", 400)
		}
		seen[topic] = true
		ok, e := s.Authority.AuthorizeModule(ctx, p, topic)
		if e != nil {
			return nil, e
		}
		if ok {
			modules = append(modules, topic)
		}
	}
	return &Connection{p, modules, r, slices.Clone(topics)}, nil
}
func authorizationFailure(e error) bool {
	return slices.Contains([]int{401, 403, 404, 409, 410}, fault.Status(e))
}
func (s *Service) Position(ctx context.Context) (string, error) {
	if e := sharedHub(s.Pool).drain(ctx); e != nil {
		return "", e
	}
	var c string
	e := s.Pool.QueryRow(ctx, "SELECT cursor::text FROM web_event_sequence_v1 WHERE singleton").Scan(&c)
	return c, e
}
func (s *Service) Read(ctx context.Context, c *Connection, cursor *string) ([]Frame, error) {
	if cursor != nil && !integer.MatchString(*cursor) {
		return nil, fault.New("invalid_web_events_cursor", 400)
	}
	if e := sharedHub(s.Pool).drain(ctx); e != nil {
		return nil, e
	}
	fresh, e := s.Connect(ctx, c.request, c.Principal.Surface, c.topics)
	if e != nil {
		return nil, e
	}
	if fresh.Principal.Identity != c.Principal.Identity || fresh.Principal.Endpoint != c.Principal.Endpoint {
		return nil, fault.New("web_events_identity_changed", 409)
	}
	tx, e := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	var high string
	var low *string
	if e = tx.QueryRow(ctx, "SELECT cursor::text,(SELECT min(cursor)::text FROM web_event_log_v1) FROM web_event_sequence_v1 WHERE singleton").Scan(&high, &low); e != nil {
		return nil, e
	}
	events := []Event{}
	if cursor != nil {
		rows, e := tx.Query(ctx, `SELECT cursor::text,module,source_table,source_ref,endpoint,operation_id FROM web_event_log_v1 WHERE cursor>$1 AND cursor<=$2 ORDER BY cursor LIMIT $3`, *cursor, high, maximumReplay+1)
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var v Event
			var eventEndpoint *string
			if e = rows.Scan(&v.Cursor, &v.Module, &v.SourceTable, &v.Ref, &eventEndpoint, &v.OperationID); e != nil {
				rows.Close()
				return nil, e
			}
			if eventEndpoint != nil {
				v.Endpoint = *eventEndpoint
			}
			events = append(events, v)
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			return nil, e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	frames := []Frame{}
	lost := []string{}
	for _, m := range c.Modules {
		if !slices.Contains(fresh.Modules, m) {
			lost = append(lost, m)
		}
	}
	if len(lost) > 0 {
		pos := high
		if cursor != nil {
			pos = *cursor
		}
		frames = append(frames, Frame{Type: "reset", Cursor: pos, Modules: lost, Reason: "access-changed"})
	}
	c.Modules = fresh.Modules
	c.Principal = fresh.Principal
	highN, _ := strconv.ParseUint(high, 10, 64)
	var curN uint64
	if cursor != nil {
		curN, _ = strconv.ParseUint(*cursor, 10, 64)
	}
	invalid := cursor == nil || curN > highN || low == nil && curN < highN
	if low != nil {
		lo, _ := strconv.ParseUint(*low, 10, 64)
		invalid = invalid || lo > 0 && curN < lo-1
	}
	if invalid || len(events) > maximumReplay {
		return append(frames, Frame{Type: "reset", Cursor: high, Modules: c.Modules, Reason: "replay-gap"}, Frame{Type: "snapshot", Cursor: high, Modules: c.Modules}), nil
	}
	locators := map[agentOSKey]agentOSLocation{}
	if c.Principal.Surface == "admin" && slices.Contains(c.Modules, "agentos") {
		locators, e = s.agentOSLocators(ctx, events)
		if e != nil {
			return nil, e
		}
	}
	resets := []string{}
	addReset := func(m string) {
		if slices.Contains(c.Modules, m) && !slices.Contains(resets, m) {
			resets = append(resets, m)
		}
	}
	for _, event := range events {
		if !validSource(event) {
			continue
		}
		if event.Module == "authorization" || c.Principal.Surface == "admin" && slices.Contains(catalog.Authority, event.SourceTable) {
			dependencies, known := catalog.Dependencies[event.SourceTable]
			relevant := false
			if c.Principal.Surface == "admin" {
				relevant = event.Module != "authorization"
			} else {
				relevant = known && (event.SourceTable != "contacts_v2" || c.Principal.SubjectID != "" && (str(event.Ref, "initiator_id") == c.Principal.SubjectID || str(event.Ref, "recipient_id") == c.Principal.SubjectID)) || c.Principal.AccountID != "" && str(event.Ref, "account_id") == c.Principal.AccountID || c.Principal.SubjectID != "" && str(event.Ref, "subject_id") == c.Principal.SubjectID
			}
			if relevant && (event.Endpoint == "" || event.Endpoint == c.Principal.Endpoint) {
				if !known {
					dependencies = c.Modules
				}
				for _, m := range dependencies {
					addReset(m)
				}
			}
		}
		if !slices.Contains(c.Modules, event.Module) {
			continue
		}
		decision, e := s.authorizeSource(ctx, c.Principal, event)
		if e != nil {
			return nil, e
		}
		if decision == Reset || decision == Allowed && str(event.Ref, "_operation") == "DELETE" {
			// A missing or deleted source row has no trustworthy current locator.
			// Request a snapshot without disclosing its former ID. Module and
			// session authority changes still take the separate reset path.
			if c.Principal.Surface == "admin" && event.Module == "agentos" && agentOSEntity(event.SourceTable) != "" {
				frames = append(frames, Frame{Type: "change", Cursor: event.Cursor, Module: event.Module})
				continue
			}
			addReset(event.Module)
			continue
		}
		if decision == Allowed {
			f := Frame{Type: "change", Cursor: event.Cursor, Module: event.Module, OperationID: event.OperationID, Version: event.Ref["_version"]}
			f.ObjectID = objectID(event)
			if c.Principal.Surface == "admin" && event.Module == "agentos" {
				entity := agentOSEntity(event.SourceTable)
				if entity == "" {
					f.Entity = "configuration"
				} else {
					location := locators[agentOSLocatorKey(event.SourceTable, str(event.Ref, "id"))]
					if location.owner != "" && location.owner != c.Principal.Identity {
						continue
					}
					f.Entity, f.ParentID, f.TurnID = location.entity, location.parent, location.turn
					if location.entity == "" {
						f.ObjectID, f.OperationID = "", nil
					}
				}
			}
			for _, key := range []string{"room_id", "task_id", "post_id"} {
				if p := str(event.Ref, key); p != "" && p != f.ObjectID {
					f.ParentID = p
					break
				}
			}
			frames = append(frames, f)
		}
	}
	if len(resets) > 0 {
		frames = append(frames, Frame{Type: "reset", Cursor: high, Modules: resets, Reason: "access-changed"})
	}
	return append(frames, Frame{Type: "snapshot", Cursor: high, Modules: c.Modules}), nil
}

// Only these four catalog tables contain the conversation identifiers needed
// by the workbench. Captured refs deliberately exclude conversation_id and
// turn_id, so read the live source rows instead of inferring from operation_id.
type agentOSKey struct{ table, id string }
type agentOSLocation struct{ entity, parent, turn, owner string }

func agentOSLocatorKey(table, id string) agentOSKey {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return agentOSKey{table, ""}
	}
	return agentOSKey{table, parsed.String()}
}

func agentOSEntity(table string) string {
	switch table {
	case "operations_agentos_conversation_commands_v1":
		return "conversation-operation"
	case "operations_agentos_conversation_cards_v1":
		return "conversation-card"
	case "operations_agentos_conversation_tool_calls_v1":
		return "conversation-tool"
	case "operations_agentos_conversations_v1":
		return "conversation-context"
	default:
		return ""
	}
}

func (s *Service) agentOSLocators(ctx context.Context, events []Event) (map[agentOSKey]agentOSLocation, error) {
	byTable := map[string][]pgtype.UUID{}
	seen := map[agentOSKey]bool{}
	for _, event := range events {
		id := str(event.Ref, "id")
		key := agentOSLocatorKey(event.SourceTable, id)
		if event.Module != "agentos" || agentOSEntity(event.SourceTable) == "" || key.id == "" || seen[key] || event.Endpoint != "" && event.Endpoint != s.Endpoint {
			continue
		}
		parsed, _ := uuid.Parse(key.id)
		seen[key] = true
		byTable[event.SourceTable] = append(byTable[event.SourceTable], pgtype.UUID{Bytes: parsed, Valid: true})
	}
	result := map[agentOSKey]agentOSLocation{}
	for table, ids := range byTable {
		// table comes exclusively from agentOSEntity's fixed table whitelist.
		query := `SELECT source.id::text,to_jsonb(source)->>'conversation_id',to_jsonb(source)->>'turn_id',
		 (SELECT c.operator_id FROM operations_agentos_conversations_v1 c WHERE c.id=COALESCE((to_jsonb(source)->>'conversation_id')::uuid,source.id) AND c.endpoint=$2)
		 FROM ` + pgx.Identifier{table}.Sanitize() + ` source WHERE source.id=ANY($1::uuid[]) AND source.endpoint=$2`
		rows, err := s.Pool.Query(ctx, query, ids, s.Endpoint)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			var conversation, turn, owner *string
			if err = rows.Scan(&id, &conversation, &turn, &owner); err != nil {
				rows.Close()
				return nil, err
			}
			if owner == nil {
				continue
			}
			location := agentOSLocation{entity: agentOSEntity(table), owner: *owner}
			if conversation != nil {
				location.parent = *conversation
			}
			if turn != nil {
				location.turn = *turn
			}
			if location.entity == "conversation-operation" {
				location.turn = id
			}
			if location.entity == "conversation-context" {
				location.parent = id
			}
			result[agentOSKey{table, id}] = location
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			return nil, err
		}
	}
	return result, nil
}
func validSource(e Event) bool {
	module, known := catalog.Sources[e.SourceTable]
	return known && (module == e.Module || slices.Contains(catalog.Aliases[e.SourceTable], e.Module))
}
func str(ref map[string]any, key string) string { v, _ := ref[key].(string); return v }
func objectID(e Event) string {
	keys := []string{"message_id", "id", "work_id", "room_id", "task_id", "project_id"}
	switch e.Module {
	case "builders":
		keys = []string{"builder_id"}
		if e.SourceTable == "builders" {
			keys = append(keys, "id")
		}
	case "choice-sync":
		keys = []string{"snapshot_id"}
	case "information":
		keys = []string{"watch_id", "id"}
	case "tasks":
		keys = []string{"task_id", "id"}
	case "capsules":
		keys = []string{"capsule_id", "id"}
	}
	for _, k := range keys {
		if v := str(e.Ref, k); v != "" {
			return v
		}
	}
	return ""
}
func (s *Service) authorizeSource(ctx context.Context, p Principal, event Event) (SourceDecision, error) {
	if !validSource(event) || event.Endpoint != "" && event.Endpoint != s.Endpoint {
		return Denied, nil
	}
	ok, e := s.Authority.AuthorizeModule(ctx, p, event.Module)
	if e != nil {
		return Denied, e
	}
	if !ok {
		return Denied, nil
	}
	if p.Surface != "admin" {
		decision, e := s.Authority.AuthorizeSource(ctx, p, event)
		if authorizationFailure(e) {
			if str(event.Ref, "_operation") == "DELETE" {
				return Reset, nil
			}
			return Denied, nil
		}
		return decision, e
	}
	if len(event.Ref) == 0 {
		return Denied, nil
	}
	locator := map[string]any{}
	for k, v := range event.Ref {
		if k != "_operation" && k != "_version" {
			locator[k] = v
		}
	}
	b, e := json.Marshal(locator)
	if e != nil {
		return Denied, e
	}
	var endpoint *string
	// Table identifiers come exclusively from the fixed producer catalog.
	e = s.Pool.QueryRow(ctx, `SELECT to_jsonb(source)->>'endpoint' FROM `+pgx.Identifier{event.SourceTable}.Sanitize()+` source WHERE to_jsonb(source) @> $1::jsonb LIMIT 1`, string(b)).Scan(&endpoint)
	if e == pgx.ErrNoRows {
		return Reset, nil
	}
	if e != nil {
		return Denied, e
	}
	if endpoint == nil || *endpoint == "" || *endpoint == s.Endpoint {
		return Allowed, nil
	}
	return Denied, nil
}

var hubs sync.Map
