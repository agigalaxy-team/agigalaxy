import { z } from 'zod';

const room = { roomId: z.uuid() };
export const chatInputs = {
  create: z.strictObject({ title: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).default('') }),
  list: z.strictObject({}),
  join: z.strictObject({ ...room, joinCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() }),
  read: z.strictObject(room),
  leave: z.strictObject(room),
  decide: z.strictObject({ ...room, expectedRevision: z.number().int().positive(), choice: z.enum(['dissolve', 'become-owner']) }),
  send: z.strictObject({ ...room, text: z.string().trim().min(1).max(8000) }),
  messages: z.strictObject({ ...room, limit: z.number().int().min(1).max(100).default(30), after: z.string().min(1).max(200).optional() }),
};

const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const roomState = z.strictObject({ roomId: z.uuid(), title: z.string().max(120), description: z.string().max(2000),
  revision: z.number().int().positive(), members: z.array(z.strictObject({ subjectId: subject, affiliation: z.enum(['member', 'owner']) })).max(100),
  memberCount: z.number().int().min(1).max(100), mode: z.enum(['ownerless', 'owned']), ownerSubjectId: subject.nullable(),
  decisionRequired: z.boolean(), choices: z.array(z.enum(['dissolve', 'become-owner'])).max(2),
  membershipBasis: z.literal('galaxy-subject-explicit-membership') });
export const chatResults = {
  create: roomState.extend({ joinCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  list: z.strictObject({ rooms: z.array(roomState).max(1000) }),
  read: roomState, join: roomState,
  leave: z.strictObject({ left: z.literal(true) }),
  decide: z.union([roomState, z.strictObject({ dissolved: z.literal(true) })]),
  send: z.strictObject({ messageId: z.uuid(), archiveId: z.string().min(1).max(200), acceptedByRoom: z.literal(true), readByOthers: z.literal(false) }),
  messages: z.strictObject({ items: z.array(z.strictObject({ archiveId: z.string().min(1).max(200), messageId: z.string().nullable(),
    subjectId: subject, text: z.string().max(8000), sentAt: z.string().nullable() })).max(100),
  last: z.string().nullable(), complete: z.boolean(), source: z.literal('prosody-mam') }),
};
