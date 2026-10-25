// Local DiceBear 10.6.0 artwork; details and licenses: ../THIRD_PARTY_AVATARS.md.
// The stable account ID selects a character; the saved key selects a visual
// variant. No account information is sent to an image service.
import {generateAccountAvatar} from './vendor/account-avatar-generator.mjs';
const variants=Object.freeze({orbit:0,camera:1,book:2,leaf:3,mountain:4,palette:5,music:6,sunrise:7});
const cache=new Map();
/**
 * @param {string | null | undefined} key
 * @param {string | null | undefined} seed
 * @param {'person' | 'organization' | 'agent' | null} [subjectType]
 */
export function accountAvatarSelection(key,seed,subjectType=null){
 const explicit=typeof key==='string'&&Object.hasOwn(variants,key);
 const normalizedSeed=typeof seed==='string'&&seed.trim()?seed.trim().toLowerCase().replace(/^account:/,''):'galaxy-avatar-unset';
 const kind=subjectType==='person'||subjectType==='organization'||subjectType==='agent'?subjectType:'unknown';
 const choice=explicit?key:'default',identity=JSON.stringify([kind,normalizedSeed,choice]);
 const known=cache.get(identity);if(known)return known;
 let hash=2166136261;for(const character of normalizedSeed)hash=Math.imul(hash^character.charCodeAt(0),16777619)>>>0;
 const index=explicit?variants[key]:hash%8;
 const result=Object.freeze({src:generateAccountAvatar(kind,identity,index),index,mode:explicit?'selected':'default',subjectType:kind});
 if(cache.size>=256)cache.delete(cache.keys().next().value);
 cache.set(identity,result);return result;
}

