import { createHash } from 'node:crypto';

// Hash exact bytes; callers must not normalize signed or consented payload text.
export const digest = value => createHash('sha256').update(value).digest('hex');
