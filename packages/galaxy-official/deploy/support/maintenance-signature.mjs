import {timingSafeEqual,createHmac,createHash} from 'node:crypto';
export function maintenanceRequestSignature(key,{id,at,body}){return createHmac('sha256',key).update(id+'\n'+at+'\n'+body).digest('hex');}
export function verifyMaintenanceSignature(key,supplied,context){
 if(typeof supplied!=='string'||!/^[a-f0-9]{64}$/.test(supplied))return false;
 return timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(maintenanceRequestSignature(key,context),'hex'));
}
export function maintenanceServiceKeyMatches(expected,received){
 if(typeof expected!=='string'||expected.length<32||typeof received!=='string'||received.length>1024)return false;
 const hash=value=>createHash('sha256').update(value).digest();return timingSafeEqual(hash(expected),hash(received));
}
