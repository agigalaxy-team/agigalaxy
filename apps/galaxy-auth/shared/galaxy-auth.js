/* Progressive enhancement only. The identity provider owns form action and tokens. */
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('input[tabindex],a[tabindex],button[tabindex]').forEach(element=>{
    if(Number(element.getAttribute('tabindex'))>0)element.removeAttribute('tabindex');
  });
  for(const field of document.querySelectorAll('input[aria-invalid="true"],textarea[aria-invalid="true"]')){
    const error=document.getElementById(`input-error-${field.name==='password-new'?'password':field.name}`)||document.getElementById('input-error');
    if(error)field.setAttribute('aria-describedby',[...new Set([...(field.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean),error.id])].join(' '));
  }
  const timers=new WeakMap();
  let pendingForm=null;
  const status=document.getElementById('auth-submit-status');
  const progress=document.getElementById('auth-progress');
  const message=document.getElementById('auth-submit-message');
  const feedback=state=>{
    if(message)message.textContent=message.dataset[state]||message.dataset.pending;
    if(status){status.hidden=false;status.dataset.state=state;}
    if(progress)progress.hidden=state!=='pending';
  };
  const restore=form=>{
    window.clearTimeout(timers.get(form));timers.delete(form);
    delete form.dataset.submitting;form.removeAttribute('aria-busy');
  };
  for(const form of document.forms){
    form.addEventListener('submit',event=>{
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
    });
  }
  window.addEventListener('online',()=>{
    if(status?.dataset.state==='offline')feedback('reconnected');
  });
  window.addEventListener('pageshow',()=>{
    for(const form of document.forms)restore(form);
    pendingForm=null;
    if(status){status.hidden=true;delete status.dataset.state;}
    if(progress)progress.hidden=true;
  });
});
