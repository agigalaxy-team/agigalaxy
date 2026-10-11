// A poll, filter change and pagination may overlap. Only the latest selected
// query may change the visible inbox; obsolete failures must not clear it.
export function createNotificationLoader(client) {
  let generation = 0;
  return {
    invalidate() { generation++; },
    async load(query, { apply, failed, pages = 1 }) {
      const selected = ++generation;
      try {
        const [first, preferences] = await Promise.all([client.query(query), client.options()]);
        let page = first;
        const seen = new Set();
        for (let index=1; index<pages && page.nextAfter && !seen.has(page.nextAfter); index++) {
          if (selected !== generation) return false;
          seen.add(page.nextAfter);
          const next = await client.query({...query,after:page.nextAfter});
          const items = new Map(page.items.map(item=>[item.id,item]));
          for (const item of next.items) items.set(item.id,item);
          page={...next,items:[...items.values()]};
        }
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
