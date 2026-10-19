import {createHash} from 'node:crypto';
import {ServiceError} from '../../shared/service-error.mjs';

const ACCOUNT_CENTER='https://agigalaxy.org/app/account';
const css=`:root{font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#302a35;background:#fff;font-size:15px}*{box-sizing:border-box}body{margin:0;line-height:1.8}a{color:#9a5d78;text-decoration:none}a:hover{text-decoration:underline}a:focus-visible{outline:3px solid #dcb7ca;outline-offset:5px}header{position:fixed;inset:0 0 auto;height:72px;border-bottom:1px solid #ebe6ed;display:flex;align-items:center;gap:22px;padding:0 24px;background:#fff;z-index:2}header svg{width:32px;height:32px;color:#524455}header a{display:flex;align-items:center;gap:22px;color:#514553}header span{font-size:14px}nav{position:fixed;top:72px;bottom:0;left:0;width:80px;display:flex;flex-direction:column;gap:28px;padding:30px 8px;border-right:1px solid #ebe6ed;text-align:center;font-size:12px;background:#fff}nav a:last-child{margin-top:auto}main{margin:72px 0 0 80px;min-height:calc(100dvh - 72px);padding:70px 8vw;display:flex;align-items:center;justify-content:center}.result{width:100%;max-width:820px}.eyebrow{font-size:12px;color:#a06d86;letter-spacing:.1em}h1{font-size:32px;line-height:1.4;font-weight:500;letter-spacing:-.03em;margin:12px 0 22px}.lead{font-size:15px;color:#786c80;max-width:600px}.stages{display:grid;grid-template-columns:1fr 1fr;margin:38px 0;gap:30px;border-top:1px solid #ece6ee;border-bottom:1px solid #ece6ee;padding:26px 0}.stages strong{font-size:14px;font-weight:500;display:block}.stages p{font-size:12px;color:#8b7c93;margin:8px 0 0}.stage-icon{width:30px;height:30px;border-radius:50%;background:#fbf1f6;color:#b27694;display:grid;place-items:center;margin-bottom:14px;font-size:15px}.primary{display:inline-block;padding:11px 22px;background:#b66c8a;color:#fff;border-radius:9px;font-size:14px}.note{font-size:12px;color:#948699;margin-top:22px}.skip{position:fixed;top:-100px;left:10px;background:#fff;z-index:5;padding:10px}.skip:focus{top:10px}@media(max-width:600px){header{height:64px;padding:0 17px;gap:17px}header a{gap:17px}header span{font-size:12px}nav{top:64px;width:64px;padding:25px 5px;font-size:11px;gap:25px}main{margin:64px 0 0 64px;min-height:calc(100dvh - 64px);padding:40px 24px;align-items:flex-start}h1{font-size:25px}.lead{font-size:13px}.stages{grid-template-columns:1fr;gap:23px;margin:28px 0;padding:23px 0}.note{font-size:11px}.primary{font-size:13px;padding:10px 17px}}`;
const responsiveCss=css+`.primary{background:#a45e7a}.note,.stages p{color:#7c6e7b}.eyebrow{color:#95566f}@media(max-width:720px){body{padding-bottom:calc(74px + env(safe-area-inset-bottom,0px))}header{height:64px}nav{inset:auto 0 0;width:100%;height:calc(74px + env(safe-area-inset-bottom,0px));padding:4px 8px calc(4px + env(safe-area-inset-bottom,0px));display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:2px;border-right:0;border-top:1px solid #ebe6ed;align-items:center;font-size:11px}nav a{padding:10px 0}nav a:last-child{margin-top:0}main{margin:64px 0 0;min-height:calc(100dvh - 138px);padding:38px 24px}}`;
const styleHash=createHash('sha256').update(responsiveCss).digest('base64');

export function acceptsIdentityCallbackHtml(request){
  if(request.headers['sec-fetch-mode']&&request.headers['sec-fetch-mode']!=='navigate')return false;
  const accept=request.headers.accept;
  if(typeof accept!=='string')return false;
  const quality=new Map();
  for(const part of accept.split(',')){
    const [type,...parameters]=part.trim().toLowerCase().split(';');
    const qParameter=parameters.map(value=>value.trim()).find(value=>value.startsWith('q='));
    const value=qParameter?Number(qParameter.slice(2)):1;
    quality.set(type,Number.isFinite(value)&&value>=0&&value<=1?value:0);
  }
  return (quality.get('text/html')??0)>0&&(quality.get('text/html')??0)>(quality.get('application/json')??0);
}
function page(success,status,association=true){
  const expired=[400,401,403,404,409,410].includes(status);
  const title=success?'账户登录已完成':expired?'这次登录无法继续':'账户服务暂时不可用';
  const lead=success?'请回到刚才的页面，继续这次银河账户关联。原页面和已有内容仍由原应用保留。':expired?'这次登录可能已经过期、使用过或被取消。回到原页面重新开始账户登录，已有身份与资料不会因此改变。':'请稍后回到原页面重新开始。原有身份与资料不受影响。';
  const stages=success?'<div class="stages"><div><span class="stage-icon" aria-hidden="true">✓</span><strong>线上账户已登录</strong><p>已完成这次官方账户登录。</p></div><div><span class="stage-icon" aria-hidden="true">○</span><strong>回原页面继续关联</strong><p>由当前设备的银河插件继续确认，身份与历史分别保留。</p></div></div>':'';
  const note=association?'登录账户不等于身份已经关联。你可以关闭当前页面，回到发起关联的原页面，由本机银河插件继续。':'请回到账户中心重新开始登录，继续原来的事情。';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title} · 银河</title><style>${responsiveCss}</style></head><body><a class="skip" href="#main">跳到主要内容</a><header><a href="https://agigalaxy.org/" aria-label="银河首页"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><ellipse cx="16" cy="16" rx="13" ry="6" transform="rotate(-36 16 16)" stroke="currentColor" stroke-width="1.65"/><ellipse cx="16" cy="16" rx="6" ry="13" transform="rotate(-36 16 16)" stroke="currentColor" stroke-width="1.65"/><circle cx="16" cy="16" r="3.2" fill="currentColor"/><circle cx="26" cy="7" r="2.2" fill="#d8a9be" stroke="#fff" stroke-width="1.5"/></svg><span>银河 · 账户</span></a></header><nav aria-label="主要功能"><a href="https://agigalaxy.org/">首页</a><a href="https://agigalaxy.org/app/">发现</a><a href="https://agigalaxy.org/app/community">社区</a><a href="https://agigalaxy.org/app/rooms">消息</a><a href="https://agigalaxy.org/app/work">工作</a><a href="${ACCOUNT_CENTER}" aria-current="page">账户</a></nav><main id="main" tabindex="-1"><section class="result"><p class="eyebrow">${association?'银河账户关联':'银河在线账户'}</p><h1>${title}</h1><p class="lead">${lead}</p>${stages}<p><a class="primary" href="${ACCOUNT_CENTER}">前往账户中心</a></p><p class="note">${note}</p></section></main></body></html>`;
}
function securityHeaders(response){
  const vary=String(response.getHeader('Vary')??'').split(',').map(value=>value.trim()).filter(Boolean);
  if(!vary.some(value=>value.toLowerCase()==='accept'))vary.push('Accept');
  response.setHeader('Vary',vary.join(', '));
  response.setHeader('Cache-Control','no-store');
  response.setHeader('Pragma','no-cache');
  response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('X-Content-Type-Options','nosniff');
}
export async function serveIdentityCallback({identity,providerId,returnedUrl,request,response,send,recordFailure=async()=>{}}){
  securityHeaders(response);
  if(!acceptsIdentityCallbackHtml(request))return send(200,await identity.callback(providerId,returnedUrl));
  let success=false,status=200;
  try{
    const result=await identity.callback(providerId,returnedUrl);
    if(result?.state!=='awaiting-local-signature')throw new Error('Unexpected identity callback state');
    success=true;
  }catch(error){
    status=error instanceof ServiceError&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:500;
    await recordFailure(status,error instanceof ServiceError?error.code:'internal_error');
  }
  response.statusCode=status;
  response.setHeader('Content-Type','text/html; charset=utf-8');
  response.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  response.setHeader('X-Frame-Options','DENY');
  response.setHeader('X-Robots-Tag','noindex, nofollow');
  response.end(page(success,status));
}

// Browser entry failures must remain readable while programmatic clients keep
// the existing JSON status/error contract. No request or upstream text is used.
export async function serveAccountNavigationError({request,response,error,recordFailure=async()=>{}}){
  if(!acceptsIdentityCallbackHtml(request))return false;
  const status=error instanceof ServiceError&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:500;
  await recordFailure(status,error instanceof ServiceError?error.code:'internal_error');
  securityHeaders(response);response.statusCode=status;
  response.setHeader('Content-Type','text/html; charset=utf-8');
  response.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  response.setHeader('X-Frame-Options','DENY');response.setHeader('X-Robots-Tag','noindex, nofollow');
  response.end(page(false,status,false));return true;
}
