/* Progressive enhancement only. The identity provider owns form action and tokens. */
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('input[tabindex],a[tabindex],button[tabindex]').forEach(element=>{
    if(Number(element.getAttribute('tabindex'))>0)element.removeAttribute('tabindex');
  });
  for(const field of document.querySelectorAll('input[aria-invalid="true"],textarea[aria-invalid="true"]')){
    const error=document.getElementById(`input-error-${field.name==='password-new'?'password':field.name}`)||document.getElementById('input-error');
    if(error)field.setAttribute('aria-describedby',[...new Set([...(field.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean),error.id])].join(' '));
  }
  const submission=createAuthenticationSubmission({forms:document.forms,
    status:document.getElementById('auth-submit-status'),progress:document.getElementById('auth-progress'),message:document.getElementById('auth-submit-message')});
  for(const form of document.forms)form.addEventListener('submit',submission.submit);
  window.addEventListener('offline',submission.offline);
  window.addEventListener('online',submission.online);
  window.addEventListener('pagehide',submission.reset);
  window.addEventListener('pageshow',submission.reset);
});

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
