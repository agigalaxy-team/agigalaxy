/** Keep a reader's existing bottom lock through images, Markdown and viewport reflow.
 * Selection, history restoration and user scroll intent remain with the caller. */
export function observeBottomFollow(viewport:HTMLElement,content:HTMLElement|null,canFollow:()=>boolean,follow:()=>void){
 const settle=()=>{if(canFollow())follow();};
 const resize=new ResizeObserver(settle);
 const observe=()=>{resize.disconnect();resize.observe(viewport);if(content)resize.observe(content);else for(const child of viewport.children)resize.observe(child);settle();};
 const changes=content?null:new MutationObserver(observe);changes?.observe(viewport,{childList:true});observe();
 return()=>{resize.disconnect();changes?.disconnect();};
}
