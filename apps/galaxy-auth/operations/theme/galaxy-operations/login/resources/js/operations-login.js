/* Presentation only. Keep native Keycloak actions, field names, password toggle and submit controller. */
document.addEventListener('DOMContentLoaded',()=>{
 const area=document.querySelector('.op-form-panel');if(!area)return;
 // A remembered SSO account yields Keycloak's password-only reauthentication.
 // Follow its own switch-account action so explicit management sign-in always
 // shows both native fields; do not synthesize a form or handle credentials.
 const restart=area.querySelector('#reset-login');
 if(restart&&area.querySelector('#kc-form-login input[name=password]')&&!area.querySelector('input[name=username]')){area.hidden=true;window.location.replace(restart.href);return;}
 for(const field of area.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio])')){
  const update=()=>field.classList.toggle('op-filled',field.value.length>0);field.addEventListener('input',update);field.addEventListener('focus',update);field.addEventListener('blur',update);update();
 }
 const submit=area.querySelector('#kc-login');if(submit&&!submit.parentElement.classList.contains('op-submit-control')){const wrapper=document.createElement('div');wrapper.className='op-submit-control';submit.before(wrapper);wrapper.append(submit);}
 const caps=document.getElementById('operations-caps-lock');for(const input of area.querySelectorAll('input[name^=password]')){const check=event=>{if(caps)caps.hidden=!event.getModifierState?.('CapsLock');};input.addEventListener('keydown',check);input.addEventListener('keyup',check);input.addEventListener('blur',()=>{if(caps)caps.hidden=true;});}
});
