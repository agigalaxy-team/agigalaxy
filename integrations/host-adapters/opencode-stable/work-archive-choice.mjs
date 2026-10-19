/** Apply this work's explicit choice to the latest local selection. Paused
 * scopes do not restart when the user selects a different conversation. */
export async function setWorkArchiveSelection(archive,{galaxyId,host,sessionId,enabled}){
 const current=await archive.settings();
 if(current.galaxyId!==galaxyId)throw Error('local_identity_changed');
 const selected=current.settings;
 const other=selected.sessions.filter(item=>item.host!==host||item.sessionId!==sessionId);
 const sessions=enabled?[...(selected.enabled?other:[]),{host,sessionId}]:other;
 return archive.configure({galaxyId,enabled:enabled||(selected.enabled&&sessions.length>0),sessions,autoCleanAfterDays:selected.autoCleanAfterDays});
}
