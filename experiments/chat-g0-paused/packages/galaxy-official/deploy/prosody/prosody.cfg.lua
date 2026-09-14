-- Private G0 integration profile; bind only through the loopback Docker mapping.
admins = {};
pidfile = "/tmp/prosody.pid";
data_path = "/var/lib/prosody";
plugin_paths = { "/etc/prosody/modules" };
log = { { levels = { min = "warn" }; to = "console" } };
modules_enabled = { "disco"; "ping"; };
modules_disabled = { "s2s"; "c2s"; "http"; "https"; "bosh"; "websocket"; "admin_shell"; };
c2s_ports = {}; c2s_direct_tls_ports = {}; s2s_ports = {}; s2s_direct_tls_ports = {};
http_ports = {}; https_ports = {}; component_ports = { 5347 };
component_interfaces = { "0.0.0.0" };
storage = "internal";
component_admins_as_room_owners = false;

VirtualHost "galaxy.test"
    authentication = "internal_hashed";
    allow_registration = false;

Component "gateway.galaxy.test"
    local key = Lua.assert(Lua.io.open("/etc/prosody/component.key", "r"));
    component_secret = key:read("*a"):gsub("%s+$", ""); key:close();

Component "rooms.galaxy.test" "muc"
    modules_enabled = { "galaxy_rooms"; "muc_mam"; };
    galaxy_gateway_host = "gateway.galaxy.test";
    galaxy_max_rooms = 1000;
    restrict_room_creation = true;
    component_admins_as_room_owners = false;
    muc_room_default_public = false;
    muc_room_default_members_only = true;
    muc_room_default_persistent = true;
    muc_room_default_allow_member_invites = false;
    muc_log_by_default = true;
    muc_log_expires_after = "1d"; -- Synthetic integration data only; not production retention.
    storage_archive_item_limit = 10000;
    max_archive_query_results = 100;
