export const continuationLines=(heading,values)=>values.filter(value=>typeof value==='string'&&value.trim()).length?[heading,...values.filter(value=>typeof value==='string'&&value.trim())].join('\n'):'';
export const continuationReasons={'not-permitted':'当前身份不能读取这份资料。','source-unavailable':'这份资料目前不可读。','source-expired':'这份资料的可读期限已结束。','temporarily-unavailable':'暂时无法核对这份资料，连接恢复后可以继续。'};

export function continuationResultText(data){
 const output=[continuationLines('接着当前事情',[data.purpose])];
 for(const source of data.sources){
  if(source.state==='available')output.push(continuationLines(source.role==='current'?'当前内容：'+source.title:'所选资料：'+source.title,[source.content,...source.notes,...(source.url?['来源：'+source.url]:[])]));
  else output.push((source.role==='current'?'当前内容':'所选资料')+'：'+(continuationReasons[source.reason]??continuationReasons['source-unavailable']));
 }
 output.push('继续处理：围绕上面的目的整理可用内容与下一步；尚未取得的材料和结果保持未知。');
 output.push('回到原页面继续：\n'+data.returnUrl);
 return output.filter(Boolean).join('\n\n');
}
