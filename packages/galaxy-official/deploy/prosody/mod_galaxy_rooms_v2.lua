-- Product metadata is owned by Galaxy PostgreSQL. This private component uses
-- the unchanged Prosody MUC delivery and MAM storage APIs, with stable IDs and
-- fixed per-message expiry. No public c2s/s2s or independent room admin bypass.
local st = require "prosody.util.stanza";
local jid = require "prosody.util.jid";
local json = require "prosody.util.json";
local array = require "prosody.util.array";
local datetime = require "prosody.util.datetime";
local sha256 = require "prosody.util.hashes".sha256;
local muc = module:depends("muc");
module:depends("muc_mam");
local ns = "urn:galaxy:rooms:2";
local gateway = assert(module:get_option_string("galaxy_gateway_host"));
-- Independent source readers have their own XEP-0114 connection identity.
-- They retain the original read-time projection, not send/edit/erase authority.
local reader_gateways = module:get_option_set("galaxy_reader_gateway_hosts", {});

local archive = module:open_store("muc_log", "archive");
local tombstones = module:open_store("galaxy_erased");
assert(archive.get and archive.set and archive.delete, "Archive get/set/delete required");

local function deny(event)
 event.origin.send(st.error_reply(event.stanza, "cancel", "not-allowed")); return true;
end
module:hook("muc-room-pre-create", deny, 1000);
module:hook("iq-set/bare/http://jabber.org/protocol/muc#admin:query", deny, 1000);
module:hook("iq-set/bare/http://jabber.org/protocol/muc#owner:query", deny, 1000);
module:hook("muc-occupant-groupchat", deny, 1000);

local function metadata(item)
 local raw = item and item:get_child_text("metadata", ns);
 return raw and json.decode(raw);
end
local function authorized(room, subject, revision)
 return room and room._data.galaxy_v2 and room._data.galaxy_v2.revision == revision
  and room._data.galaxy_v2.members[subject] == true;
end
local function participant_node(ref)
 if type(ref) ~= "string" then return nil; end
 -- Preserve every old identity JID. Accounts have their own explicit namespace;
 -- no account is enrolled as, or converted into, a Galaxy identity.
 if #ref == 32 and ref:match("^GUID[A-Z0-9]+$") then return string.lower(ref); end
 local account = ref:match("^account:([0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+)$");
 if account and #account == 36 and account:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$") then return "account-" .. account; end
 return nil;
end
local function erased(room_id, message_id)
 local records = tombstones:get(room_id) or {};
 return records[message_id] and records[message_id] > os.time();
end
local function erase(room_id, message_id)
 -- A body-free tombstone covers the maximum legal message lifetime. After
 -- that period an old send's immutable expiry is itself sufficient to deny it.
 local records = tombstones:get(room_id) or {};
 for id, until_time in pairs(records) do if until_time <= os.time() then records[id] = nil; end end
 records[message_id] = os.time() + 90 * 86400;
 if not tombstones:set(room_id, records) then return nil; end
 return archive:delete(room_id, { key = message_id });
end
local function expire(room_id)
 local iterator = archive:find(room_id, {}); if not iterator then return nil; end
 local ids = {};
 for id, item in iterator do
  local m = metadata(item);
  if m and m.expires_at <= os.time() then table.insert(ids, id); end
 end
 for _, id in ipairs(ids) do if not erase(room_id, id) then return nil; end end
 local records = tombstones:get(room_id) or {};
 for id, until_time in pairs(records) do if until_time <= os.time() then records[id] = nil; end end
 if not tombstones:set(room_id, records) then return nil; end
 return true;
end

-- Raw MAM requests are not public entry points. All body reads pass current
-- Galaxy ACLs through the private component; the underlying store is MAM's.
module:hook("iq-set/bare/urn:xmpp:mam:2:query", deny, 1000);
module:hook("iq-get/bare/urn:xmpp:mam:2:query", deny, 1000);

module:hook("iq-set/host/" .. ns .. ":command", function(event)
 local origin, stanza = event.origin, event.stanza;
 local function reply(value)
  origin.send(st.reply(stanza):tag("result", { xmlns = ns }):text(json.encode(value))); return true;
 end
 local function fail(code) return reply({ error = code }); end
 local sender = jid.bare(stanza.attr.from);
 local reader = sender ~= gateway and reader_gateways:contains(sender);
 if sender ~= gateway and not reader then return fail("chat_access_denied"); end
 local raw = stanza:get_child_text("command", ns);
 if not raw or #raw > 100000 then return fail("invalid_chat_request"); end
 local x = json.decode(raw);
 if type(x) ~= "table" or type(x.roomId) ~= "string" or #x.roomId ~= 36 or not x.roomId:match("^[0-9a-f%-]+$") then return fail("invalid_chat_request"); end
 -- PostgreSQL/device/room checks stay in the owning Go source reader.
 -- project is the existing current-snapshot prerequisite for read; keep its
 -- primary-gateway member JIDs and original monotonic revision check below.
 if reader and x.action ~= "project" and x.action ~= "read" then return fail("chat_access_denied"); end
 local room_jid = x.roomId .. "@" .. module.host;
 local room = muc.get_room_from_jid(room_jid);
 if x.action == "project" then
  if type(x.revision) ~= "number" or type(x.members) ~= "table" or type(x.title) ~= "string" then return fail("invalid_chat_request"); end
  if room and room._data.galaxy_v2 and room._data.galaxy_v2.revision > x.revision then return fail("chat_projection_stale"); end
  if not room then
   room = muc.create_room(room_jid); if not room then return fail("chat_room_unavailable"); end
   room:set_hidden(true); room:set_members_only(true); room:set_persistent(true);
   room:set_allow_member_invites(false); room:set_whois("anyone");
   room._data.archiving = true;
  end
   local members, addresses = {}, {};
  for _, subject in ipairs(x.members) do
    local node = participant_node(subject); if not node then return fail("invalid_chat_request"); end
   members[subject] = true;
    addresses[node .. "@" .. gateway] = true;
  end
  local old = {};
  for address in room:each_affiliation() do table.insert(old, address); end
  for _, address in ipairs(old) do
    if not addresses[address] then room:set_affiliation(true, address, "none"); end
  end
   for address in pairs(addresses) do room:set_affiliation(true, address, "member"); end
  room:set_name(x.title);
  room._data.galaxy_v2 = { revision = x.revision; members = members; state = x.state };
  room:save(true); return reply({ revision = x.revision });
 end
 if x.action == "erase" then
  if type(x.messageId) ~= "string" or #x.messageId ~= 36 then return fail("invalid_chat_request"); end
  if not erase(x.roomId, x.messageId) then return fail("chat_archive_delete_failed"); end
  return reply({ archiveDeleted = true });
 end
 if x.action ~= "export-own" and not authorized(room, x.subjectId, x.roomRevision) then return fail("chat_access_denied"); end
 if x.action == "read" or x.action == "export-own" then
  if type(x.ids) ~= "table" or #x.ids > 100 then return fail("invalid_chat_request"); end
  local messages = array();
  for _, id in ipairs(x.ids) do
   local item = archive:get(x.roomId, id); local m = metadata(item);
   if m and m.expires_at > os.time() and not erased(x.roomId, id) and (x.action ~= "export-own" or m.subject == x.subjectId) then
    local current = { archiveId = id; revision = m.revision };
    if x.action ~= "read" or x.metadataOnly ~= true then current.text = item:get_child_text("body"); end
    table.insert(messages, current);
   elseif m and m.expires_at <= os.time() then erase(x.roomId, id); end
  end
  return reply({ messages = messages });
 end
 if room._data.galaxy_v2.state == "archived" or room._data.galaxy_v2.state == "owner-succession" then return fail("chat_room_read_only"); end
 if type(x.messageId) ~= "string" or #x.messageId ~= 36 or type(x.text) ~= "string" or #x.text > 64000 then return fail("invalid_chat_request"); end
 if erased(x.roomId, x.messageId) then return fail("chat_message_erased"); end
 local previous = archive:get(x.roomId, x.messageId); local m = metadata(previous);
 if x.action == "send" then
  if previous then
   if not m or m.payload_hash ~= x.payloadHash or m.subject ~= x.subjectId then return fail("chat_message_conflict"); end
   return reply({ archiveId = x.messageId });
  end
  local sent = datetime.parse(x.sentAt); local expiry = datetime.parse(x.expiresAt);
  if not sent or not expiry or sent > os.time() + 30 or expiry <= os.time() or expiry - sent > 90 * 86400 then return fail("chat_expiry_invalid"); end
  m = { subject = x.subjectId; expires_at = expiry; sent_at = sent; revision = 1; payload_hash = x.payloadHash };
   local item = st.message({type = "groupchat"; from = room_jid .. "/" .. participant_node(x.subjectId); id = x.messageId})
   :tag("body"):text(x.text):up():tag("origin-id", { xmlns = "urn:xmpp:sid:0"; id = x.messageId }):up()
   :tag("stanza-id", { xmlns = "urn:xmpp:sid:0"; by = room_jid; id = x.messageId }):up()
   :tag("metadata", { xmlns = ns }):text(json.encode(m)):up();
  local id = archive:append(x.roomId, x.messageId, item, sent, "message<groupchat");
  if not id then return fail("chat_archive_write_failed"); end
  room:broadcast(item); return reply({ archiveId = id });
 elseif x.action == "edit" then
  if not m or m.subject ~= x.subjectId or m.expires_at <= os.time() then return fail("chat_message_unavailable"); end
  local edit_hash = sha256(x.text, true);
  if m.edit_operation == x.operationId then
   if m.edit_hash ~= edit_hash then return fail("chat_operation_conflict"); end
   return reply({ revision = m.revision });
  end
  if m.revision ~= x.expectedRevision or os.time() - m.sent_at > 86400 then return fail("chat_revision_conflict"); end
  m.revision = m.revision + 1; m.edit_operation = x.operationId; m.edit_hash = edit_hash;
  previous:remove_children("body"); previous:remove_children("metadata", ns);
  previous:tag("body"):text(x.text):up():tag("metadata", { xmlns = ns }):text(json.encode(m)):up();
  if not archive:set(x.roomId, x.messageId, previous) then return fail("chat_archive_write_failed"); end
  local correction = st.clone(previous); correction.attr.id = x.operationId;
  correction:tag("replace", { xmlns = "urn:xmpp:message-correct:0"; id = x.messageId }):up();
  room:broadcast(correction); return reply({ revision = m.revision });
 end
 return fail("invalid_chat_request");
end);

module:hourly(function()
 for room in muc.all_rooms() do
  if room._data.galaxy_v2 then expire(jid.node(room.jid)); end
 end
end);
