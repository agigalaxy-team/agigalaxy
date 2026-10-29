import * as z from 'zod/v4';
import { createPublicKey } from 'node:crypto';
import { isGalaxyGuid } from './identity/galaxy-guid.mjs';

export const controlSubject = z.string().refine(isGalaxyGuid);
export const controlPublicKey = z.string().max(256).refine(value => {
  try { const key=createPublicKey(value); return key.asymmetricKeyType==='ed25519' && key.export({type:'spki',format:'pem'})===value; }
  catch { return false; }
});
import {controlSchemas} from './trust-package-control-schema-factory.mjs';
export const {controlDeviceSchema,controlOperationSchema,controlCommitSchema}=controlSchemas({controlSubject,controlPublicKey});
