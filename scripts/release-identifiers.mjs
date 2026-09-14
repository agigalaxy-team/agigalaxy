export const COMPONENTS=Object.freeze(['site','api','client','docs']);
export const INITIAL_VERSION='0.1.0';
export function componentRelease(component,version=INITIAL_VERSION){if(!COMPONENTS.includes(component)||!parseComponentRelease(version))throw new Error('invalid_release_identifier');return version;}
export function parseComponentRelease(value){const m=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);return m?{major:+m[1],minor:+m[2],patch:+m[3],version:value}:null;}
export function bumpVersion(value,kind){const v=parseComponentRelease(value);if(!v||!['major','minor','patch'].includes(kind))throw new Error('invalid_release_increment');return (kind==='major'?[v.major+1,0,0]:kind==='minor'?[v.major,v.minor+1,0]:[v.major,v.minor,v.patch+1]).join('.');}
export function legacyReleaseAlias(value){return /^(?:20260913|2026\.09\.13)-product-v2-r[1-9][0-9]*$/.test(value)||/^official-2026\.09\.13-product-v2-r[1-9][0-9]*$/.test(value)?value:null;}
