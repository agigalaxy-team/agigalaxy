// Closed local artwork keys. No network or file-upload capability is implied.
export const accountAvatarOptions=Object.freeze([
 Object.freeze({key:'orbit',label:'星环'}),Object.freeze({key:'camera',label:'相机'}),
 Object.freeze({key:'book',label:'书页'}),Object.freeze({key:'leaf',label:'新叶'}),
 Object.freeze({key:'mountain',label:'山岚'}),Object.freeze({key:'palette',label:'调色盘'}),
 Object.freeze({key:'music',label:'音符'}),Object.freeze({key:'sunrise',label:'晨光'}),
]);
export const accountAvatarKeys=Object.freeze(accountAvatarOptions.map(item=>item.key));
export const accountAvatarKey=value=>typeof value==='string'&&accountAvatarKeys.includes(value)?value:null;
export const accountProfileFields=Object.freeze(['displayName','avatarKey','bio']);
