// A poll, filter change and pagination may overlap. Only the latest selected
// query may change the visible inbox; obsolete failures must not clear it.
export function createNotificationLoader(client) {
  let generation = 0;
  return {
    invalidate() { generation++; },
    async load(query, { apply, failed }) {
      const selected = ++generation;
      try {
        const [page, preferences] = await Promise.all([client.query(query), client.options()]);
        if (selected !== generation) return false;
        apply(page, preferences);
        return true;
      } catch (error) {
        if (selected !== generation) return false;
        failed();
        throw error;
      }
    },
  };
}
