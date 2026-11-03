package native

import (
 "context"
 "database/sql"
 "encoding/json"

 "github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type hostSourceCursorInput struct { GalaxyID string `json:"galaxyId"`; Host string `json:"host"`; SessionID string `json:"sessionId"`; Seq int64 `json:"seq"` }
func (s *Store) hostSourceCursor(ctx context.Context, method string, raw json.RawMessage)(any,error){
 x,e:=hostDecode[hostSourceCursorInput](raw);if e!=nil{return nil,e}
 if !validID(x.GalaxyID)||!validID(x.Host)||!validID(x.SessionID)||x.Seq<0{return nil,fault.New("local_work_input_invalid",400)}
 var out any
 e=s.historyWrite(ctx,x.GalaxyID,nil,func(db *sql.DB,owner string)error{
  if _,err:=db.ExecContext(ctx,`CREATE TABLE IF NOT EXISTS host_source_cursors(owner_id TEXT NOT NULL,host TEXT NOT NULL,session_id TEXT NOT NULL,next_seq INTEGER NOT NULL,PRIMARY KEY(owner_id,host,session_id))`);err!=nil{return err}
  row,err:=oneMap(ctx,db,"SELECT next_seq FROM host_source_cursors WHERE owner_id=? AND host=? AND session_id=?",owner,x.Host,x.SessionID);if err!=nil{return err}
  if row==nil {
   if method!="history.sourceCursor"{return fault.New("local_work_source_cursor_missing",409)}
   if _,err=db.ExecContext(ctx,"INSERT INTO host_source_cursors(owner_id,host,session_id,next_seq) VALUES(?,?,?,?)",owner,x.Host,x.SessionID,x.Seq);err!=nil{return err}
   out=map[string]any{"nextSeq":x.Seq};return nil
  }
  next:=integer(row["next_seq"])
  if method=="history.advanceSourceCursor" {
   if x.Seq!=next{return fault.New("local_work_source_cursor_conflict",409)}
   next++
   if _,err=db.ExecContext(ctx,"UPDATE host_source_cursors SET next_seq=? WHERE owner_id=? AND host=? AND session_id=?",next,owner,x.Host,x.SessionID);err!=nil{return err}
  }
  out=map[string]any{"nextSeq":next};return nil
 });return out,e
}
