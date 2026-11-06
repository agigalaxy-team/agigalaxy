package accountsocial

import (
 "context"
 "encoding/base64"
 "github.com/agigalaxy-team/agigalaxy/go/internal/fault"
 "github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
 "github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
 "github.com/jackc/pgx/v5"
)
func (s *Service) PublicFollows(ctx context.Context,raw []byte)(Object,error){
 p,e:=shape(raw,[]string{"accountId","direction"},[]string{"after","limit"},"invalid_account_follow_request");if e!=nil{return nil,e}
 owner:=str(p,"accountId"); direction:=str(p,"direction");if !validID(owner)||!one(direction,"following","followers"){return nil,fault.New("invalid_account_follow_request",400)}
 limit:=int64(20);if v,ok:=p["limit"];ok {var valid bool;limit,valid=number(v);if !valid||limit<1||limit>50{return nil,fault.New("invalid_account_follow_request",400)}}
 var at,id any
 if v,ok:=p["after"];ok { token,ok:=v.(string);if !ok||len(token)<5||len(token)>512||token[:4]!="ap1." {return nil,fault.New("account_follow_cursor_unavailable",409)}; b,err:=base64.RawURLEncoding.DecodeString(token[4:]);var c struct{AccountID,Direction,At,ID string};if err!=nil||protocol.Decode(b,&c)!=nil||c.AccountID!=owner||c.Direction!=direction||!validID(c.ID){return nil,fault.New("account_follow_cursor_unavailable",409)}; t,err:=parseDate(c.At);if err!=nil{return nil,fault.New("account_follow_cursor_unavailable",409)};at=t;id=c.ID }
 if s.Pool==nil{return nil,fault.New("account_follow_unavailable",503)}
 return postgres.InTx(ctx,s.Pool,func(tx pgx.Tx)(Object,error){
  profile,e:=s.target(ctx,tx,owner,false);if e!=nil{return nil,e};if profile==nil{return nil,fault.New("not_found",404)}
  column,other:="account_id","target_account_id";if direction=="followers"{column,other=other,column}
  rr,e:=rows(ctx,tx,`SELECT id,`+other+` AS other_id,followed_at FROM account_follows_v1 f WHERE f.`+column+`=$1 AND following=true AND visibility='public' AND EXISTS (SELECT 1 FROM official_account_profiles_v1 op WHERE op.account_id=f.`+other+` AND op.query_enabled=true) AND ($2::timestamptz IS NULL OR (followed_at,id)<($2::timestamptz,$3::uuid)) ORDER BY followed_at DESC,id DESC LIMIT $4`,owner,at,id,limit+1);if e!=nil{return nil,e}
  items:=[]Object{};var next any;for i,r:=range rr {if int64(i)==limit {last:=rr[i-1];next="ap1."+base64.RawURLEncoding.EncodeToString(encode(Object{"accountId":owner,"direction":direction,"at":date(last["followed_at"]),"id":str(last,"id")}));break};profile,e:=s.target(ctx,tx,str(r,"other_id"),false);if e!=nil{return nil,e};if profile!=nil{items=append(items,Object{"profile":profile,"followedAt":date(r["followed_at"])})}}
  var count int64;if e=tx.QueryRow(ctx,`SELECT count(*) FROM account_follows_v1 f WHERE f.`+column+`=$1 AND following=true AND visibility='public' AND EXISTS (SELECT 1 FROM official_account_profiles_v1 op WHERE op.account_id=f.`+other+` AND op.query_enabled=true)`,owner).Scan(&count);e!=nil{return nil,e};return Object{"accountId":owner,"direction":direction,"items":items,"count":count,"nextAfter":next,"checkedAt":s.now().Unix()},nil
 })
}
