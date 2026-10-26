-- Galaxy's bounded offline adapter for the unchanged Prosody 13.0.6 internal
-- storage driver. No socket, account login, new store, or daemon is created.
-- inspect/capture are read-only; reconcile is accepted only at the fixed,
-- separately mounted private candidate path. Bodies never leave this process.
return function(x)
 local version=assert(io.open('/usr/local/lib/prosody/prosody.version','r'));local native_version=version:read('*a'):gsub('%s+$','');version:close();
 if native_version~='13.0.6'then error('maintenance_prosody_native_version_not_supported',0);end
 local json = require "prosody.util.json";
 local array = require "prosody.util.array";
 local lfs = require "lfs";
 local dm = require "prosody.util.datamanager";
 local uuid_pattern = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$";
 local host = "rooms.galaxy.internal";
 local function fail(code) error(code, 0); end
 local function uuid(v) return type(v) == "string" and #v == 36 and v:match(uuid_pattern) and v == v:lower(); end
 local function ref(v)
  if type(v) ~= "string" then return nil; end
  if #v == 32 and v:match("^GUID[A-Z0-9]+$") then return v:lower(); end
  local id = v:match("^account:(.+)$"); if uuid(id) then return "account-" .. id; end
 end
 if type(x) ~= "table" or not ({inspect=true,capture=true,reconcile=true,verify=true})[x.action] then fail("maintenance_prosody_request_invalid"); end
 local writable = x.action == "reconcile";
 local candidate = writable or x.candidate == true;
 if candidate and (x.privateCandidate ~= true or not uuid(x.operationId)) then fail("maintenance_prosody_private_candidate_required"); end
 if writable and (x.now == nil or x.projection == nil or x.stage ~= "erase" and x.security == nil) then fail("maintenance_prosody_request_invalid"); end
 dm.set_data_path(candidate and "/galaxy-candidate" or "/var/lib/prosody");
 local root = candidate and "/galaxy-candidate" or "/var/lib/prosody";
 local hosts = { ["galaxy.internal"]=true,["gateway.galaxy.internal"]=true,[host]=true };
 local room_stores = { config=true,state=true,persistent=true,muc_log=true,galaxy_erased=true,cron=true };
 local auth_stores = { accounts=true,roles=true,cron=true };
 for entry in lfs.dir(root) do
  if entry ~= "." and entry ~= ".." then
   local path = root .. "/" .. entry;
   if lfs.symlinkattributes(path,"mode") ~= "directory" or not hosts[dm.path_decode(entry)] then fail("maintenance_prosody_store_inventory_unknown"); end
   for name in lfs.dir(path) do
    if name ~= "." and name ~= ".." then
     local mode = lfs.symlinkattributes(path .. "/" .. name,"mode");
     if mode ~= "directory" and mode ~= "file" then fail("maintenance_prosody_store_inventory_unknown"); end
     local store = dm.path_decode(mode == "directory" and name or name:match("^(.-)%.dat$") or "");
     if not (dm.path_decode(entry) == host and room_stores or auth_stores)[store] then fail("maintenance_prosody_store_inventory_unknown"); end
    end
   end
  end
 end
 -- Load precisely the native 13.0.6 driver, using only its documented module
 -- option/provides surface. The driver still owns stanza serialization,
 -- archive key lookup/deletion and .list/.lidx atomic rewriting.
 local saved = package.loaded["prosody.core.storagemanager"];
 package.loaded["prosody.core.storagemanager"] = { olddm=dm };
 local driver;
 local env = setmetatable({ module={host=host,
  get_option_integer=function(_,_,default) return default; end,
  get_option_boolean=function(_,_,default) return default; end,
  log=function() end,
  provides=function(_,kind,value) if kind ~= "storage" then fail("maintenance_prosody_native_driver_invalid"); end; driver=value; end,
 } }, {__index=_G});
 assert(loadfile("/usr/local/lib/prosody/modules/mod_storage_internal.lua","t",env))();
 package.loaded["prosody.core.storagemanager"] = saved;
 if not driver then fail("maintenance_prosody_native_driver_invalid"); end
 local archive = driver:open("muc_log","archive");
 if not archive or not archive.get or not archive.delete then fail("maintenance_prosody_native_driver_invalid"); end
 local function load(node,h,store)
  local value,err=dm.load(node,h,store);if err then fail("maintenance_prosody_store_unreadable"); end;return value;
 end
 local function set(node,h,store,value)
  if not writable then fail("maintenance_prosody_read_only"); end
  if not dm.store(node,h,store,value) then fail("maintenance_prosody_store_write_failed"); end
 end
 local function nodes(h,store,typ)
  local rows={};for node in dm.users(h,store,typ) do
   local path=dm.getpath(node,h,store,typ=="list"and"list"or"dat");
   if lfs.symlinkattributes(path,"mode")~="file"then fail("maintenance_prosody_store_inventory_unknown");end
   if typ=="list"then local mode=lfs.symlinkattributes(dm.getpath(node,h,store,"lidx"),"mode");if mode and mode~="file"then fail("maintenance_prosody_store_inventory_unknown");end end
   rows[#rows+1]=node;if #rows>100000 then fail("maintenance_prosody_inventory_limit"); end
  end;table.sort(rows);return rows;
 end
 local function security()
  local result={};
  for _,h in ipairs({"galaxy.internal","gateway.galaxy.internal"}) do
   result[h]={};for _,store in ipairs({"accounts","roles"}) do
    local rows=array();for _,node in ipairs(nodes(h,store)) do rows:push({node=node,value=load(node,h,store)});end
    result[h][store]={users=rows,global=load(nil,h,store)};
   end
  end
  return result;
 end
 local function rooms()
  local out=array();for _,id in ipairs(nodes(host,"config")) do
   if not uuid(id) then fail("maintenance_prosody_room_identity_unknown"); end
   local value=load(id,host,"config");local acl=value and value._data and value._data.galaxy_v2;
   if type(value) ~= "table" or value._jid ~= id .. "@" .. host or type(acl) ~= "table" or type(acl.members) ~= "table" then fail("maintenance_prosody_room_authority_unknown"); end
   local members=array();for member,enabled in pairs(acl.members) do if not ref(member) or enabled ~= true then fail("maintenance_prosody_room_authority_unknown");end;members:push(member);end;table.sort(members);
   local affiliations={};for k,v in pairs(value) do if type(k)=="string" and not k:match("^_") then
    if type(v)~="string" then fail("maintenance_prosody_room_authority_unknown");end;affiliations[k]=v;
   end end
   out:push({roomId=id,revision=acl.revision,state=acl.state,members=members,affiliations=affiliations});
  end;return out;
 end
 local function tombstones()
  local out=array();for _,id in ipairs(nodes(host,"galaxy_erased")) do
   if not uuid(id) then fail("maintenance_prosody_room_identity_unknown");end
   local records=load(id,host,"galaxy_erased");if type(records)~="table" then fail("maintenance_prosody_tombstones_invalid");end
   for mid,until_time in pairs(records) do if not uuid(mid) or type(until_time)~="number" then fail("maintenance_prosody_tombstones_invalid");end end
   out:push({roomId=id,records=records});
  end;return out;
 end
 local function messages()
  local out=array();for _,id in ipairs(nodes(host,"muc_log","list")) do
   if not uuid(id) then fail("maintenance_prosody_room_identity_unknown");end
   local iterator,err=archive:find(id,{});if not iterator or err then fail("maintenance_prosody_archive_unreadable");end
   for key,item in iterator do
    if not uuid(key) then fail("maintenance_prosody_message_identity_unknown");end
    local raw=item:get_child_text("metadata","urn:galaxy:rooms:2");local m=raw and json.decode(raw);
    if type(m)~="table" or not ref(m.subject) or type(m.expires_at)~="number" or type(m.revision)~="number" or type(m.payload_hash)~="string" then fail("maintenance_prosody_message_metadata_unknown");end
    out:push({roomId=id,messageId=key,subjectId=m.subject,revision=m.revision,expiresAt=m.expires_at,payloadHash=m.payload_hash});
    if #out>100000 then fail("maintenance_prosody_inventory_limit");end
   end
  end;return out;
 end
 local initial={security=security(),rooms=rooms(),tombstones=tombstones(),messages=messages()};
 if writable then
  -- The caller has verified the original deletion ledger and current source
  -- facts. Only these exact message keys, or this already executed all-owned
  -- identity scope, may be erased. Unknown orphan material blocks recovery.
  local targets={};local bykey={};for _,v in ipairs(x.projection.messages)do
   if not uuid(v.roomId)or not uuid(v.messageId)or not ref(v.subjectId)or type(v.erase)~="boolean"then fail("maintenance_prosody_projection_invalid");end
   local key=v.roomId..":"..v.messageId;if bykey[key]then fail("maintenance_prosody_projection_invalid");end;bykey[key]=v;
   if v.erase then targets[key]=v;end
  end
  local deleted={};for _,v in ipairs(x.projection.deletedSubjects)do if not ref(v.subjectId)or not v.subjectId:match("^GUID")or not uuid(v.requestId)then fail("maintenance_prosody_projection_invalid");end;deleted[v.subjectId]=true;end
  for _,m in ipairs(initial.messages)do
   local key=m.roomId..":"..m.messageId;local source=bykey[key];
   if source and source.subjectId~=m.subjectId then fail("maintenance_prosody_native_source_conflict");end
   if deleted[m.subjectId]or m.expiresAt<=x.now then targets[key]=source or {roomId=m.roomId,messageId=m.messageId,expiresAt=m.expiresAt,subjectId=m.subjectId};
   elseif not source then fail("maintenance_prosody_native_source_unknown");
   end
  end
  local receipt=array();for _,v in pairs(targets)do
   local removed,err=archive:delete(v.roomId,{key=v.messageId});if removed==nil or err then fail("maintenance_prosody_archive_delete_unconfirmed");end
   local item,get_err=archive:get(v.roomId,v.messageId);if item~=nil or get_err and get_err~="item-not-found"then fail("maintenance_prosody_archive_delete_unconfirmed");end
   -- The original immutable expiry already prevents resend after its lifetime.
   -- Do not invent or extend a new tombstone/retention period on restoration.
   local marks=load(v.roomId,host,"galaxy_erased")or{};
   if type(v.expiresAt)~="number"then fail("maintenance_prosody_projection_invalid");end
   if v.expiresAt>x.now then marks[v.messageId]=math.max(marks[v.messageId]or 0,v.expiresAt);end
   set(v.roomId,host,"galaxy_erased",marks);receipt:push({roomId=v.roomId,messageId=v.messageId,archiveDeleted=true});
  end
  if x.stage=="erase"then return{version=1,receipts=receipt};end
  -- Keep the current native login/role authority, not the point's accounts.
  for _,h in ipairs({"galaxy.internal","gateway.galaxy.internal"})do for _,store in ipairs({"accounts","roles"})do
   local wanted=x.security[h]and x.security[h][store];if type(wanted)~="table"or type(wanted.users)~="table"then fail("maintenance_prosody_security_invalid");end
   local selected={};for _,v in ipairs(wanted.users)do if type(v.node)~="string"or #v.node>1024 or selected[v.node]then fail("maintenance_prosody_security_invalid");end;selected[v.node]=true;end
   for _,node in ipairs(nodes(h,store))do if not selected[node]then set(node,h,store,nil);end end
   set(nil,h,store,wanted.global);for _,v in ipairs(wanted.users)do set(v.node,h,store,v.value);end
  end end
  local wanted={};for _,r in ipairs(x.projection.rooms)do
   if not uuid(r.roomId)or type(r.revision)~="number"or type(r.members)~="table"or type(r.title)~="string"or wanted[r.roomId]then fail("maintenance_prosody_projection_invalid");end;wanted[r.roomId]=r;
  end
  -- A native room no longer present in the authoritative database has no
  -- members or occupant sessions. It is not turned into another user's room.
  for _,old in ipairs(initial.rooms)do if not wanted[old.roomId]then wanted[old.roomId]={roomId=old.roomId,revision=old.revision,state="archived",members={},title=""};end end
  local persistent={};for id,r in pairs(wanted)do
   local members={};local data={_jid=id.."@"..host,_affiliation_data={},_data={name=r.title,hidden=true,members_only=true,persistent=true,allow_member_invites=false,whois="anyone",archiving=true,
    galaxy_v2={revision=r.revision,state=r.state,members=members}}};
   for _,member in ipairs(r.members)do local node=ref(member);if not node or deleted[member]then fail("maintenance_prosody_projection_invalid");end;members[member]=true;data[node.."@gateway.galaxy.internal"]="member";end
   set(id,host,"config",data);set(id,host,"state",nil);persistent[id.."@"..host]=true;
  end
  for _,id in ipairs(nodes(host,"state"))do set(id,host,"state",nil);end
  set(nil,host,"persistent",persistent);
  for _,v in ipairs(x.tombstones or{})do if not uuid(v.roomId)or type(v.records)~="table"then fail("maintenance_prosody_tombstones_invalid");end
   local marks=load(v.roomId,host,"galaxy_erased")or{};for id,until_time in pairs(v.records)do if not uuid(id)or type(until_time)~="number"then fail("maintenance_prosody_tombstones_invalid");end;marks[id]=math.max(marks[id]or 0,until_time);end;set(v.roomId,host,"galaxy_erased",marks);
  end
  return {version=1,rooms=rooms(),messages=messages(),security=security(),tombstones=tombstones(),receipts=receipt,occupantStates=0};
 end
 if x.action=="inspect"then
  local users=0;for _,h in pairs(initial.security)do users=users+#h.accounts.users;end
  return {version=1,nativeStorageReadable=true,nativeRooms=#initial.rooms,nativeMessages=#initial.messages,nativeLoginUsers=users,liveComponentRoundTrip=false,changed=false};
 end
 return {version=1,rooms=initial.rooms,messages=initial.messages,security=initial.security,tombstones=initial.tombstones,occupantStates=#nodes(host,"state")};
end
