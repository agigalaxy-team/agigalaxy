// Local observation children need host paths, locale and networking settings,
// not the model process's credentials or unrelated environment variables.
const allowed=new Set(`PATH PATHEXT SystemRoot WINDIR COMSPEC HOME USERPROFILE HOMEDRIVE HOMEPATH APPDATA LOCALAPPDATA PROGRAMDATA TMPDIR TMP TEMP XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME XDG_RUNTIME_DIR XDG_SESSION_ID XDG_SESSION_TYPE OPENCODE_CONFIG_DIR DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS LANG LC_ALL LC_CTYPE TZ HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GALAXY_NATIVE_CONFIG GALAXY_NATIVE_DATA_DIR GALAXY_DATA_DIR GALAXY_NATIVE_EXECUTABLE`.split(' ').map(name=>name.toUpperCase()));
export function nativeObservationEnvironment(source=process.env) {
 return Object.fromEntries(Object.entries(source).filter(([name])=>allowed.has(name.toUpperCase())));
}
