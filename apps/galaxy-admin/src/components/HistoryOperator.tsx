export function HistoryOperator({id,name}:{id?:string|null;name?:string|null}){
 const identifier=typeof id==='string'?id:'',label=identifier&&!identifier.startsWith('executor:')&&typeof name==='string'?name.trim():'';
 const executor=/^executor:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier);
 return <span title={identifier||undefined} style={{overflowWrap:'anywhere'}}>{label||(!identifier?'身份未记录':executor?'受控执行器':'管理账户')}</span>;
}
