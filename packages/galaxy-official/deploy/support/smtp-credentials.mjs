import {ServiceError} from '../../../galaxy-contracts/src/service-error.mjs';

export const operationsSmtpCredentialAlias=reference=>{
 if(!/^system-key:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reference??''))throw new ServiceError('system_settings_credential_unavailable',409);
 return reference.replace(':','-');
};
