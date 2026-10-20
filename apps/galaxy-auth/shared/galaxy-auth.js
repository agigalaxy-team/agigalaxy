/* Progressive enhancement only. The identity provider owns form action and tokens. */
document.addEventListener('DOMContentLoaded',()=>{
  const authenticationArea=document.querySelector('.auth-form-area');
  if(!authenticationArea)return;
  authenticationArea.querySelectorAll('input[tabindex],a[tabindex],button[tabindex]').forEach(element=>{
    if(Number(element.getAttribute('tabindex'))>0)element.removeAttribute('tabindex');
  });
  for(const field of authenticationArea.querySelectorAll('input[aria-invalid="true"],textarea[aria-invalid="true"]')){
    const error=document.getElementById(`input-error-${field.name==='password-new'?'password':field.name}`)||document.getElementById('input-error');
    if(error)field.setAttribute('aria-describedby',[...new Set([...(field.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean),error.id])].join(' '));
  }
  const forms=authenticationArea.querySelectorAll('form');
  const submission=createAuthenticationSubmission({forms,
    status:document.getElementById('auth-submit-status'),progress:document.getElementById('auth-progress'),message:document.getElementById('auth-submit-message')});
  for(const form of forms)form.addEventListener('submit',submission.submit);
  const emailCode=createEmailCodeEnhancement(authenticationArea);
  window.addEventListener('offline',submission.offline);
  window.addEventListener('online',submission.online);
  window.addEventListener('pagehide',()=>{submission.reset();emailCode.pause();});
  window.addEventListener('pageshow',()=>{submission.reset();emailCode.resume();});
});

// The clock is display-only. Sending, limits, expiry and verification belong to Keycloak.
function createEmailCodeEnhancement(area){
  const inputs=[...area.querySelectorAll('[data-email-code-form] input[name="code"]')];
  const clocks=[...area.querySelectorAll('[data-email-code-resend]')].map(button=>{
    const seconds=Number(button.dataset.resendAfter);
    return {button,until:Date.now()+(Number.isFinite(seconds)?Math.max(0,seconds)*1000:0),
      disabledByServer:button.dataset.canResend===undefined?button.disabled:button.dataset.canResend!=='true',label:button.dataset.resendLabel||button.textContent,
      format:button.dataset.resendFormat||button.textContent};
  });
  let timer=null;
  const pause=()=>{if(timer!==null)window.clearTimeout(timer);timer=null;};
  const resume=()=>{
    pause();let waiting=false;
    for(const clock of clocks){
      const remaining=Math.max(0,Math.ceil((clock.until-Date.now())/1000));
      clock.button.disabled=clock.disabledByServer||remaining>0;
      clock.button.textContent=remaining>0?clock.format.replace('__SECONDS__',String(remaining)):clock.label;
      if(remaining>0)waiting=true;
    }
    if(waiting)timer=window.setTimeout(resume,250);
  };
  for(const input of inputs)input.addEventListener('paste',event=>{
    const value=(event.clipboardData?.getData('text')||'').normalize('NFKC').replace(/[\s-]/g,'');
    if(!/^[0-9]{6}$/.test(value))return;
    event.preventDefault();input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  resume();
  return {pause,resume};
}

// This controller describes navigation feedback. It cannot cancel or replay
// the identity provider's form submission and never decides its outcome.
function createAuthenticationSubmission({forms,status,progress,message}){
  const timers=new WeakMap();
  let pendingForm=null;
  const feedback=state=>{
    if(message)message.textContent=message.dataset[state]||message.dataset.pending;
    if(status){status.hidden=false;status.dataset.state=state;}
    if(progress)progress.hidden=state!=='pending';
  };
  const restore=form=>{
    window.clearTimeout(timers.get(form));timers.delete(form);
    delete form.dataset.submitting;form.removeAttribute('aria-busy');
  };
  const submit=event=>{
      const form=event.currentTarget;
      if(event.defaultPrevented||!form.checkValidity())return;
      if(form.dataset.submitting==='true'){event.preventDefault();return;}
      form.dataset.submitting='true';
      pendingForm=form;
      if(!navigator.onLine){
        event.preventDefault();restore(form);
        feedback('offline');
        return;
      }
      form.setAttribute('aria-busy','true');
      feedback('pending');
      // Do not disable named submit controls: their values belong to Keycloak's flow.
      // A failed navigation must leave the same page usable, with its inputs intact.
      timers.set(form,window.setTimeout(()=>{
        restore(form);
        if(pendingForm===form)feedback('delayed');
      },15000));
  };
  const offline=()=>{
    if(!pendingForm||status?.hidden)return;
    for(const form of forms)restore(form);
    feedback('offline');
  };
  const online=()=>{
    if(status?.dataset.state==='offline')feedback('reconnected');
  };
  const reset=()=>{
    for(const form of forms)restore(form);
    pendingForm=null;
    if(status){status.hidden=true;delete status.dataset.state;}
    if(progress)progress.hidden=true;
  };
  return {submit,offline,online,reset};
}
