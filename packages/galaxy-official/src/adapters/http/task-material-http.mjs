import {ServiceError} from '../../shared/service-error.mjs';
import {recordBodyBytes} from './request.mjs';
import {taskMaterialLimits} from '../../shared/task-material-v1-schema.mjs';

// A dedicated finite envelope for detached controlled text. Ordinary Task
// requests retain the old 32768-byte boundary, regardless of root brevity.
export async function taskMaterialBody(request,{prepare=false}={}){
 if(request.headers['content-type']!=='application/json'||request.headers['content-encoding'])throw new ServiceError('unsupported_media_type',415);
 const chunks=[];let size=0;
 for await(const chunk of request){size+=chunk.length;recordBodyBytes(request,chunk.length);if(size>taskMaterialLimits.envelopeBytes)throw new ServiceError('request_too_large',413);chunks.push(chunk);}
 let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));}catch{throw new ServiceError('invalid_json');}
 if(!input||Object.getPrototypeOf(input)!==Object.prototype)throw new ServiceError('invalid_request');
 if(!prepare&&!Object.hasOwn(input,'signedIntent')&&(size>taskMaterialLimits.legacyEnvelopeBytes||Object.keys(input).sort().join(',')!=='consentId,payloadJson'))
  throw new ServiceError(size>taskMaterialLimits.legacyEnvelopeBytes?'request_too_large':'invalid_request',size>taskMaterialLimits.legacyEnvelopeBytes?413:400);
 return input;
}
