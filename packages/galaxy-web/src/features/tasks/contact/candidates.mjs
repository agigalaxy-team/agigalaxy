const guid = (value) => /^GUID[A-Z0-9]{28}$/.test(value ?? '');
export const contactSourceRef = (item) =>
  `galaxy:${item.type}:${item.ref.id}@${item.ref.version}`;
// Only explicit authors of currently readable facts, or the author of an
// expressed opportunity, become candidates. Request ownership is not expertise.
export function contactCandidates(pages, self) {
  const candidates = new Map();
  for (const page of pages)
    for (const item of page.items ?? []) {
      const record = item.record,
        authors =
          item.type === 'opportunity'
            ? [
                {
                  id: record.subjectId,
                  role: record.participant?.kind ?? 'unknown',
                },
              ]
            : [
                ...(record.attempts ?? []).map((a) => ({
                  id: a.actorId,
                  role: a.role ?? 'attempt',
                })),
                ...(record.interventions ?? []).map((a) => ({
                  id: a.actorId,
                  role: (a.types ?? []).join('、') || 'intervention',
                })),
                ...(record.verificationRecords ?? []).map((a) => ({
                  id: a.reportedBy,
                  role: 'verification-reporter',
                })),
                ...(record.participation ?? []).map((a) => ({
                  id: a.subjectId,
                  role: a.role,
                })),
              ];
      for (const author of authors) {
        if (!guid(author.id) || author.id === self) continue;
        const entry = candidates.get(author.id) ?? {
          subjectId: author.id,
          sources: [],
          roles: [],
          help: '',
          basis: '',
          conditions: '实际可投入时间、意愿与工作范围需要本人回应确认。',
        };
        if (
          !entry.sources.some(
            (s) => contactSourceRef(s.item) === contactSourceRef(item),
          )
        )
          entry.sources.push({ item, search: page.search });
        if (!entry.roles.includes(author.role)) entry.roles.push(author.role);
        if (item.type === 'opportunity') {
          entry.displayName = record.displayName;
          entry.willingness = '本人声明愿意就所列范围交流，仍需接受本次邀请。';
        }
        candidates.set(author.id, entry);
      }
    }
  return [...candidates.values()];
}
