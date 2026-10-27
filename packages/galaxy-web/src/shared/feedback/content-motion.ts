/** Animate committed content without wrappers, remounting or persistent inline styles. */
export function animateContent(node:HTMLElement|null){
 if(!node||typeof node.animate!=='function')return;
 const preference=window.matchMedia('(prefers-reduced-motion: reduce)');if(preference.matches)return;
 const style=getComputedStyle(node),durationToken=style.getPropertyValue('--galaxy-motion-soft').trim(),parsed=Number.parseFloat(durationToken),duration=Number.isFinite(parsed)?parsed*(durationToken.endsWith('ms')?1:1000):220;
 const easing=style.getPropertyValue('--galaxy-motion-ease').trim()||'cubic-bezier(.2,.75,.2,1)',opacity=Number.parseFloat(style.opacity)||1;
 const animations=[node.animate([{opacity:opacity*.9},{opacity}],{duration,easing}),node.animate([{transform:'translateY(3px)'},{transform:'translateY(0px)'}],{duration,easing,composite:'add'})];
 const cancel=()=>{for(const animation of animations)animation.cancel();};
 const reduce=()=>{if(preference.matches)cancel();};preference.addEventListener('change',reduce);
 for(const animation of animations)void animation.finished.catch(()=>{});
 return()=>{preference.removeEventListener('change',reduce);cancel();};
}
