"use client";
export default function PageError({reset}:{error:Error&{digest?:string};reset:()=>void}){
 return <section className="message error" role="alert"><h1>暂时无法打开这个页面</h1><p>可以重试当前页面，或返回之前的页面。</p><button type="button" onClick={reset}>重新读取页面</button></section>;
}
