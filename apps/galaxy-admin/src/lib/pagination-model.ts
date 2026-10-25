/** Ordinary numbered pages only. Cursor and snapshot ownership stay with callers. */
export function paginationPageNumbers(page:number,totalPages:number):Array<number|null>{
  if(!Number.isSafeInteger(totalPages)||totalPages<=0)return [];
  const current=Math.min(Math.max(1,page),totalPages),pages=new Set([1,totalPages]);
  for(let value=Math.max(1,current-1);value<=Math.min(totalPages,current+1);value++)pages.add(value);
  if(current<=3)for(let value=1;value<=Math.min(4,totalPages);value++)pages.add(value);
  if(current>=totalPages-2)for(let value=Math.max(1,totalPages-3);value<=totalPages;value++)pages.add(value);
  const result:Array<number|null>=[];
  for(const value of [...pages].sort((a,b)=>a-b)){
    const previous=result[result.length-1];
    if(typeof previous==='number'&&value-previous>1)result.push(null);
    result.push(value);
  }
  return result;
}

export function paginationJumpTarget(value:string,totalPages:number|null):number|null{
  if(totalPages===null||!Number.isSafeInteger(totalPages)||totalPages<1||!/^\d+$/.test(value))return null;
  const target=Number(value);
  return Number.isSafeInteger(target)&&target>=1&&target<=totalPages?target:null;
}
