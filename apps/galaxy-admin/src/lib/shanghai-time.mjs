/** Format an already-validated instant in the user's display time zone.
 * @param {Date|number} value
 */
export function shanghaiMinute(value){
 return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(value);
}
