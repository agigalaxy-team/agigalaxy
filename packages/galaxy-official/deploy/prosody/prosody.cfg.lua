-- Prosody 13.0.6 stable, private Galaxy component. Deploy behind the Galaxy
-- HTTPS API. This file deliberately creates no public XMPP login/federation.
admins = {};
pidfile = "/tmp/prosody.pid";
data_path = "/var/lib/prosody";
plugin_paths = { "/etc/prosody/modules" };
log = { { levels = { min = "warn" }; to = "console" } };
modules_enabled = { "disco"; "ping"; };
modules_disabled = { "s2s"; "c2s"; "http"; "https"; "bosh"; "websocket"; "admin_shell"; };
c2s_ports = {}; c2s_direct_tls_ports = {}; s2s_ports = {}; s2s_direct_tls_ports = {};
http_ports = {}; https_ports = {}; component_ports = { 5347 };
component_interfaces = { "127.0.0.1" };
storage = "internal";
component_admins_as_room_owners = false;

VirtualHost "galaxy.internal"
 authentication = "internal_hashed";
 allow_registration = false;

Component "gateway.galaxy.internal"
 local key = Lua.assert(Lua.io.open("/etc/prosody/component.key", "r"));
 component_secret = key:read("*a"):gsub("%s+$", ""); key:close();

Component "rooms.galaxy.internal" "muc"
 modules_enabled = { "galaxy_rooms_v2"; "muc_mam"; };
 galaxy_gateway_host = "gateway.galaxy.internal";
 -- Optional independent source readers. Each must also have its own external
 -- Component and distinct secret; never connect two processes as the gateway.
 galaxy_reader_gateway_hosts = {};

 restrict_room_creation = true;
 component_admins_as_room_owners = false;
 muc_room_default_public = false;
 muc_room_default_members_only = true;
 muc_room_default_persistent = true;
 muc_room_default_allow_member_invites = false;
 muc_log_by_default = true;
 muc_log_expires_after = "90d";
 max_archive_query_results = 100;
 -- Capacity exhaustion rejects new sends. Galaxy never truncates unexpired
 -- history to accommodate another message. Runtime capacity is separately sized.
 storage_archive_item_limit = 1000000;
