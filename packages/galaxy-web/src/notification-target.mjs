const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// A notification is a pointer, never a source authorization. Destination pages
// read their current object using the connected identity. Legacy Case/incident
// IDs must not be recast as Task v2 governance report IDs.
export function notificationTarget(item) {
  const object = item?.object;
  if (!object || !uuid(object.id)) return null;
  switch (object.type) {
    case 'capsule':
      if (object.versionId != null && !uuid(object.versionId)) return null;
      return `/app/capsules/${object.id}${object.versionId ? `/versions/${object.versionId}` : ''}`;
    case 'qualification-request': return `/app/qualification-permissions/${object.id}`;
    case 'room': return `/app/rooms/${object.id}`;
    case 'task': return `/app/tasks/${object.id}`;
    case 'information-watch': return `/app/information/${object.id}`;
    case 'project': return `/app/projects/${object.id}`;
    case 'target-governance': return `/app/governance/${object.id}`;
    case 'moderation': return `/app/reviews/${object.id}`;
    // These current pages have no exact object deep-link contract yet. The
    // directory rechecks its visible records; invitations still require consent.
    case 'room-invitation': return '/app/rooms';
    case 'builder': case 'worker-pack': return '/app/builders';
    case 'hub': return '/app/hubs';
    default: return null;
  }
}
