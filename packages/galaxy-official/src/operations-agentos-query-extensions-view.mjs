// Compatibility boundary: keep existing consumers on the same explicit safe DTO exports.
export {registeredDirectoryItem,registeredDirectoryPage} from './operations/agentos/query/registered-directory.mjs';
export {systemMailQuery,systemConnectionsQuery,systemAdvancedQuery,systemGeneralQuery} from './operations/agentos/query/system-settings.mjs';
export {combinedQueryLease} from './operations/agentos/query/safe-values.mjs';
