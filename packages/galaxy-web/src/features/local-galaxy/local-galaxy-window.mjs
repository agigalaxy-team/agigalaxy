let sourceWindow=null;
const listeners=new Set();

// Navigation only. This live window reference never authorizes a local tool,
// an identity, an account action or a later handshake.
export function rememberLocalGalaxyWindow(entry){
 if(!entry?.valid||!globalThis.window?.opener||window.opener.closed)return;
 sourceWindow=window.opener;
 for(const listener of listeners)listener();
}
export function hasLocalGalaxyWindow(){return !!sourceWindow&&!sourceWindow.closed;}
export function subscribeLocalGalaxyWindow(listener){listeners.add(listener);return()=>listeners.delete(listener);}
export function returnToLocalGalaxyWindow(){
 if(!hasLocalGalaxyWindow())return false;
 try{sourceWindow.focus();window.close();return true;}catch{return false;}
}
