-- Galaxy membership policy on Prosody MUC. Message routing/history remain XMPP.
local st = require "prosody.util.stanza";
local jid = require "prosody.util.jid";
local json = require "prosody.util.json";
local array = require "prosody.util.array";
local sha256 = require "prosody.util.hashes".sha256;
local muc = module:depends("muc");
module:depends("muc_mam");
local ns = "urn:galaxy:rooms:1";
local gateway = module:get_option_string("galaxy_gateway_host");
assert(gateway, "galaxy_gateway_host is required");

local function members(room)
    local result = array();
    for address, affiliation in room:each_affiliation() do
        if affiliation == "member" or affiliation == "owner" then
            table.insert(result, { subjectId = string.upper(jid.node(address)); affiliation = affiliation });
        end
    end
    table.sort(result, function(a, b) return a.subjectId < b.subjectId; end);
    return result;
end

local function state(room)
    local people = members(room);
    local owner;
    for _, person in ipairs(people) do
        if person.affiliation == "owner" then owner = person.subjectId; end
    end
    local data = room._data.galaxy;
    return { roomId = jid.node(room.jid); title = room:get_name(); description = room:get_description() or "";
        revision = data.revision; members = people; memberCount = #people;
        mode = owner and "owned" or "ownerless"; ownerSubjectId = owner or json.null;
        decisionRequired = not owner and #people == 1;
        choices = not owner and #people == 1 and { "dissolve", "become-owner" } or array();
        membershipBasis = "galaxy-subject-explicit-membership" };
end

local function member(room, address)
    local affiliation = room:get_affiliation(address);
    return affiliation == "member" or affiliation == "owner";
end

-- Presence cannot implicitly create a room or grant creator privileges.
module:hook("muc-room-pre-create", function(event)
    event.origin.send(st.error_reply(event.stanza, "cancel", "not-allowed"));
    return true;
end, 1000);

-- Direct XMPP administration must not bypass explicit membership/revision rules.
module:hook("iq-set/bare/http://jabber.org/protocol/muc#admin:query", function(event)
    local room = muc.get_room_from_jid(event.stanza.attr.to);
    if room and room._data.galaxy then
        event.origin.send(st.error_reply(event.stanza, "cancel", "not-allowed"));
        return true;
    end
end, 1000);

module:hook("iq-set/host/" .. ns .. ":command", function(event)
    local origin, stanza = event.origin, event.stanza;
    local address = jid.bare(stanza.attr.from);
    local node = jid.node(address);
    local function fail(code)
        origin.send(st.reply(stanza):tag("result", { xmlns = ns }):text(json.encode({ error = code })));
        return true;
    end
    local function reply(value)
        origin.send(st.reply(stanza):tag("result", { xmlns = ns }):text(json.encode(value)));
        return true;
    end
    if jid.host(address) ~= gateway or not node or #node ~= 32 or not node:match("^guid[0-9a-z]+$") then
        return fail("chat_access_denied");
    end
    local text = stanza:get_child_text("command", ns);
    if not text or #text > 12000 then return fail("invalid_chat_request"); end
    local input = json.decode(text);
    if type(input) ~= "table" then return fail("invalid_chat_request"); end
    if input.action == "list" then
        local rooms = array();
        for room in muc.all_rooms() do
            if room._data.galaxy and member(room, address) then table.insert(rooms, state(room)); end
        end
        table.sort(rooms, function(a, b) return a.roomId < b.roomId; end);
        return reply({ rooms = rooms });
    end
    if type(input.roomId) ~= "string" or #input.roomId ~= 36 or not input.roomId:match("^[0-9a-f%-]+$") then
        return fail("invalid_chat_request");
    end
    local room_jid = input.roomId .. "@" .. module.host;
    local room = muc.get_room_from_jid(room_jid);
    if input.action == "create" then
        if room then return fail("chat_room_conflict"); end
        if type(input.title) ~= "string" or #input.title == 0 or #input.title > 480
            or type(input.description) ~= "string" or #input.description > 8000
            or type(input.joinCode) ~= "string" or #input.joinCode ~= 43 then return fail("invalid_chat_request"); end
        local count = 0;
        for _ in muc.all_rooms() do count = count + 1; end
        if count >= module:get_option_integer("galaxy_max_rooms", 1000, 1) then return fail("chat_room_limit"); end
        -- Programmatic creation skips handle_first_presence and its owner grant.
        room = muc.create_room(room_jid);
        if not room then return fail("chat_room_unavailable"); end
        room:set_name(input.title);
        room:set_description(input.description);
        room:set_hidden(true);
        room:set_members_only(true);
        room:set_persistent(true); -- Offline is not leave or dissolve.
        room:set_moderated(false);
        room:set_allow_member_invites(false);
        room:set_whois("anyone"); -- Members are identified by their Galaxy IDs.
        room._data.archiving = true;
        room._data.galaxy = { revision = 1; join_hash = sha256(input.joinCode, true) };
        assert(room:set_affiliation(true, address, "member"));
        room:save(true);
        return reply(state(room));
    end
    if not room or not room._data.galaxy then return fail("chat_room_not_found"); end
    if input.action == "join" then
        if not member(room, address) then
            if type(input.joinCode) ~= "string" or #input.joinCode ~= 43
                or sha256(input.joinCode, true) ~= room._data.galaxy.join_hash then return fail("chat_access_denied"); end
            if #members(room) >= 100 then return fail("chat_member_limit"); end
            assert(room:set_affiliation(true, address, "member"));
            room._data.galaxy.revision = room._data.galaxy.revision + 1;
            room:save(true);
        end
        return reply(state(room));
    end
    if not member(room, address) then return fail("chat_access_denied"); end
    if input.action == "read" then return reply(state(room)); end
    if input.action == "leave" then
        assert(room:set_affiliation(true, address, "none")); -- Removes all subject sessions.
        room._data.galaxy.revision = room._data.galaxy.revision + 1;
        if #members(room) == 0 then room:destroy(nil, "Last member explicitly left");
        else room:save(true); end
        return reply({ left = true });
    end
    if input.action == "decide" then
        if input.expectedRevision ~= room._data.galaxy.revision then return fail("chat_revision_conflict"); end
        local current = state(room);
        if not current.decisionRequired then return fail("chat_decision_unavailable"); end
        if input.choice == "dissolve" then
            room:destroy(nil, "Sole member chose to dissolve");
            return reply({ dissolved = true });
        elseif input.choice == "become-owner" then
            assert(room:set_affiliation(true, address, "owner"));
            room._data.galaxy.revision = room._data.galaxy.revision + 1;
            room:save(true);
            return reply(state(room));
        end
    end
    return fail("invalid_chat_request");
end);
