// Additional fixed business queues join the existing migration transaction.
const options=JSON.stringify({policy:'exclusive',retryLimit:3,retryDelay:30,retryBackoff:true,retryDelayMax:900,
  expireInSeconds:900,heartbeatSeconds:30,retentionSeconds:604800,deleteAfterSeconds:604800});
export const operationsJobsExpansionV1MigrationSql=`
SELECT galaxy_jobs.create_queue('account-notice','${options}'::jsonb);
SELECT galaxy_jobs.create_queue('retention-cleanup','${options}'::jsonb);
`;
