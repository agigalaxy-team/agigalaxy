// The stable host's Select exposes a short title and option descriptions.
// The actual host omits disabled options. A dedicated reading item therefore
// shows the body and opens DialogAlert; it is separate from business actions
// and has no numeric route or approval effect.
export function readableDialogSelect(input){
 const title=String(input.title??''),at=title.indexOf('\n');
 if(at<0||!input.options?.length)return input;
 const body=title.slice(at+1).trim();if(!body)return{...input,title:title.slice(0,at)};
 return{...input,title:title.slice(0,at),options:[{number:'',title:/[\u3400-\u9fff]/.test(title)?'阅读全部内容':'Read full content',description:body,reading:true},...input.options]};
}
