/* Progressive enhancement only. The identity provider owns form action and tokens. */
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('input[tabindex],a[tabindex],button[tabindex]').forEach(element=>{
    if(Number(element.getAttribute('tabindex'))>0)element.removeAttribute('tabindex');
  });
  for(const field of document.querySelectorAll('input[aria-invalid="true"],textarea[aria-invalid="true"]')){
    const error=document.getElementById(`input-error-${field.name==='password-new'?'password':field.name}`)||document.getElementById('input-error');
    if(error)field.setAttribute('aria-describedby',error.id);
  }
  const originalDisabled=new WeakSet([...document.querySelectorAll('[type="submit"]')].filter(control=>control.disabled));
  const restore=form=>{
    if(form.dataset.submitting!=='true')return;
    delete form.dataset.submitting;form.removeAttribute('aria-busy');
    for(const control of form.querySelectorAll('[type="submit"]'))if(!originalDisabled.has(control))control.disabled=false;
  };
  for(const form of document.forms){
    form.addEventListener('submit',event=>{
      if(event.defaultPrevented||!form.checkValidity())return;
      if(form.dataset.submitting==='true'){event.preventDefault();return;}
      form.dataset.submitting='true';
      const status=document.getElementById('auth-submit-status');
      const progress=document.getElementById('auth-progress');
      const message=document.getElementById('auth-submit-message');
      if(!navigator.onLine){
        event.preventDefault();restore(form);
        if(message)message.textContent=message.dataset.offline;
        if(status)status.hidden=false;if(progress)progress.hidden=true;
        return;
      }
      if(message)message.textContent=message.dataset.pending;
      form.setAttribute('aria-busy','true');
      if(status)status.hidden=false;
      if(progress)progress.hidden=false;
      // Do not disable named submit controls: their values belong to Keycloak's flow.
      // A failed navigation must leave the same page usable, with its inputs intact.
      window.setTimeout(()=>{
        restore(form);
        if(status)status.hidden=true;if(progress)progress.hidden=true;
      },15000);
    });
  }
  window.addEventListener('pageshow',()=>{
    for(const form of document.forms)restore(form);
    const status=document.getElementById('auth-submit-status');if(status)status.hidden=true;
    const progress=document.getElementById('auth-progress');if(progress)progress.hidden=true;
  });
});
