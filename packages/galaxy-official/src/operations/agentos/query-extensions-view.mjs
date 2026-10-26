// Compatibility boundary: keep existing consumers on the same explicit safe DTO exports.
export {registeredDirectoryItem,registeredDirectoryPage} from "./query/registered-directory.mjs";
export {systemMailQuery,systemConnectionsQuery,systemAdvancedQuery,systemGeneralQuery} from "./query/system-settings.mjs";
export {combinedQueryLease} from "./query/safe-values.mjs";
