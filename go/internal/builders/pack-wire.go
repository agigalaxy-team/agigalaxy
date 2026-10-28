package builders

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// PackUseWire is the original normalized selected event, in Zod output order.
// Callers retain returned bytes for signing; this does not authorize or submit.
func PackUseWire(input any)(json.RawMessage,error){raw,e:=protocol.Encode(input);if e!=nil{return nil,e};value,e:=parse("packUseEventSchema",raw);if e!=nil{return nil,e};var orders map[string][]string;_ = protocol.Decode([]byte(packUseFieldOrderJSON),&orders);wire:=protocol.NewOrderedObject();for _,key:=range orders[txt(value,"kind")]{v,ok:=value[key];if !ok{continue};switch key{case "pack":v=orderKeys(obj(v),"builderId","manifestId","manifestHash");case "attempt","configuration","result":if v!=nil{v=orderKeys(obj(v),"id","version")};case "follows":if v!=nil{v=orderKeys(obj(v),"id","kind")};case "evidenceRefs","verificationRefs":items:=[]any{};for _,raw:=range arr(v){items=append(items,orderKeys(obj(raw),"id","version"))};v=items};wire.Set(key,v)};out,e:=protocol.EncodeJS(wire);return json.RawMessage(out),e}
