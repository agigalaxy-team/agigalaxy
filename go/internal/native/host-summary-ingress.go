package native

import (
 "context"
 "crypto/sha256"
 "encoding/hex"
 "database/sql"
 "encoding/json"

 "github.com/agigalaxy-team/agigalaxy/go/internal/fault"
 "github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
)

type hostIngressExclusionsKey struct{}
type hostIngressDeliveryKey struct{}

type HostIngressInput struct {
 DeliveryID string `json:"deliveryId"`
 Observation WorkObservationInput `json:"observation"`
}
const hostIngressDDL=`CREATE TABLE IF NOT EXISTS host_observation_ingress(owner_id TEXT NOT NULL,delivery_id TEXT NOT NULL,payload_json TEXT NOT NULL,exclusions_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner_id,delivery_id));
CREATE TABLE IF NOT EXISTS host_observation_receipts(owner_id TEXT NOT NULL,delivery_id TEXT NOT NULL,payload_digest TEXT NOT NULL,observation_id TEXT NOT NULL,delivered_at TEXT NOT NULL,PRIMARY KEY(owner_id,delivery_id));`

// RecordHostIngress is called by the local one-shot ingress command before any
// shared-service delivery. Sensitive fields are removed before SQLite writes.
func RecordHostIngress(ctx context.Context,s *Store,x HostIngressInput)(map[string]any,error){
 if !validID(x.DeliveryID)||!validID(x.Observation.Host)||!validID(x.Observation.SessionID)||!validID(x.Observation.SourceID){return nil,fault.New("local_work_input_invalid",400)}
 if e:=normalizeWorkObservation(&x.Observation);e!=nil{return nil,e}
 safe,e:=localdata.Redact(x.Observation);if e!=nil{return nil,e}
 payload,e:=localdata.Encode(safe.Value);if e!=nil{return nil,e}
 exclusions,e:=localdata.Encode(safe.Exclusions);if e!=nil{return nil,e}
 digest:=sha256.Sum256(payload);digestText:=hex.EncodeToString(digest[:])
 e=s.historyWrite(ctx,x.Observation.GalaxyID,nil,func(db *sql.DB,owner string)error{
  if _,err:=db.ExecContext(ctx,hostIngressDDL);err!=nil{return err}
  receipt,err:=oneMap(ctx,db,"SELECT payload_digest FROM host_observation_receipts WHERE owner_id=? AND delivery_id=?",owner,x.DeliveryID);if err!=nil{return err}
  if receipt!=nil {if digest:=text(receipt["payload_digest"]);digest!=""&&digest!=digestText{return fault.New("local_work_ingress_conflict",409)};return nil}
  old,err:=oneMap(ctx,db,"SELECT payload_json FROM host_observation_ingress WHERE owner_id=? AND delivery_id=?",owner,x.DeliveryID);if err!=nil{return err}
  if old!=nil {if text(old["payload_json"])!=string(payload){return fault.New("local_work_ingress_conflict",409)};return nil}
  _,err=db.ExecContext(ctx,"INSERT INTO host_observation_ingress(owner_id,delivery_id,payload_json,exclusions_json,created_at) VALUES(?,?,?,?,?)",owner,x.DeliveryID,string(payload),string(exclusions),localNow());return err
 })
 if e!=nil{return nil,e};return map[string]any{"queued":true,"deliveryId":x.DeliveryID},nil
}

// DrainHostIngress never advances past a failed item. ObserveWork's source
// identity makes a crash between observation and acknowledgement safe to replay.
func (s *Store) DrainHostIngress(ctx context.Context,owner string)(map[string]any,error){
 delivered:=0;var last any
 for {
  var row map[string]any
  e:=s.historyWrite(ctx,owner,nil,func(db *sql.DB,id string)error{
   if _,err:=db.ExecContext(ctx,hostIngressDDL);err!=nil{return err}
   var err error;row,err=oneMap(ctx,db,"SELECT owner_id,delivery_id,payload_json,exclusions_json FROM host_observation_ingress WHERE owner_id=? ORDER BY rowid LIMIT 1",id);return err
  });if e!=nil{return nil,e};if row==nil{return map[string]any{"delivered":delivered,"last":last},nil}
  var input WorkObservationInput
  if json.Unmarshal([]byte(text(row["payload_json"])),&input)!=nil{return nil,fault.New("local_work_ingress_invalid",409)}
  input.GalaxyID=text(row["owner_id"])
  var incoming []localdata.Exclusion
  if json.Unmarshal([]byte(text(row["exclusions_json"])),&incoming)!=nil{return nil,fault.New("local_work_ingress_invalid",409)}
  deliveryCtx:=context.WithValue(context.WithValue(ctx,hostIngressExclusionsKey{},incoming),hostIngressDeliveryKey{},text(row["delivery_id"]))
  result,e:=s.ObserveWork(deliveryCtx,input);if e!=nil{if fault.Code(e)=="local_work_ingress_cancelled"{continue};return nil,e}
  output,_:=result.(map[string]any); observation,_:=output["observation"].(map[string]any); observationID,_:=observation["id"].(string)
  e=s.historyWrite(ctx,owner,nil,func(db *sql.DB,id string)error{
   current,err:=oneMap(ctx,db,"SELECT exclusions_json FROM work_observations WHERE id=?",observationID);if err!=nil{return err};if current==nil{return fault.New("local_work_ingress_invalid",409)}
   merged:=mergeWorkExclusions(workExclusions(current),incoming)
   if _,err=db.ExecContext(ctx,"UPDATE work_observations SET exclusions_json=? WHERE id=?",jsJSON(merged),observationID);err!=nil{return err}
   digest:=sha256.Sum256([]byte(text(row["payload_json"])))
   if _,err=db.ExecContext(ctx,"INSERT OR IGNORE INTO host_observation_receipts(owner_id,delivery_id,payload_digest,observation_id,delivered_at) VALUES(?,?,?,?,?)",id,text(row["delivery_id"]),hex.EncodeToString(digest[:]),observationID,localNow());err!=nil{return err}
   _,err=db.ExecContext(ctx,"DELETE FROM host_observation_ingress WHERE owner_id=? AND delivery_id=?",id,text(row["delivery_id"]));return err
  });if e!=nil{return nil,e};delivered++;last=result
 }
}


// HasPendingHostIngress observes the existing queue without creating a database
// or table; the service uses it to wake delivery after a producer exits.
func (s *Store) HasPendingHostIngress(ctx context.Context, owner string) (bool,error) {
 pending:=false
 e:=s.history(ctx,owner,func(db *sql.DB,id string)error{
  if db==nil||id==""{return nil}
  table,err:=oneMap(ctx,db,"SELECT name FROM sqlite_schema WHERE type='table' AND name='host_observation_ingress'");if err!=nil||table==nil{return err}
  row,err:=oneMap(ctx,db,"SELECT delivery_id FROM host_observation_ingress WHERE owner_id=? LIMIT 1",id);if err!=nil{return err};pending=row!=nil;return nil
 })
 return pending,e
}


// Removing work clears queued content and receipt digests, retaining only
// opaque delivery tombstones and the cursor to prevent deleted-data replay.
func deleteHostIngressWithin(ctx context.Context,db *sql.DB,owner,workID,host,session string) error {
 table,e:=oneMap(ctx,db,"SELECT name FROM sqlite_schema WHERE type='table' AND name='host_observation_ingress'");if e!=nil||table==nil{return e}
 if _,e=db.ExecContext(ctx,hostIngressDDL);e!=nil{return e}
 if _,e=db.ExecContext(ctx,"UPDATE host_observation_receipts SET payload_digest='',observation_id='' WHERE owner_id=? AND observation_id IN (SELECT id FROM work_observations WHERE work_id=?)",owner,workID);e!=nil{return e}
 if _,e=db.ExecContext(ctx,"INSERT OR IGNORE INTO host_observation_receipts(owner_id,delivery_id,payload_digest,observation_id,delivered_at) SELECT owner_id,delivery_id,'','',? FROM host_observation_ingress WHERE owner_id=? AND json_extract(payload_json,'$.host')=? AND json_extract(payload_json,'$.sessionId')=?",localNow(),owner,host,session);e!=nil{return e}
 _,e=db.ExecContext(ctx,"DELETE FROM host_observation_ingress WHERE owner_id=? AND json_extract(payload_json,'$.host')=? AND json_extract(payload_json,'$.sessionId')=?",owner,host,session)
 return e
}

