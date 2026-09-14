export async function assertRecoveryReady(db) {
  const rows = (await db.query('SELECT status FROM recovery_state')).rows;
  if (rows.some(row => row.status !== 'ready')) throw new Error('Restored database is quarantined.');
}
