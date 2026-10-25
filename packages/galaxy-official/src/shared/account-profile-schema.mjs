import {z} from 'zod';
import {accountAvatarKeys} from './account-profile-presentation.mjs';
export const accountAvatarKeySchema=z.enum(accountAvatarKeys).nullable();
// A self-description is plain text; consumers render it as text, never HTML.
export const accountBioSchema=z.string().trim().max(500);
