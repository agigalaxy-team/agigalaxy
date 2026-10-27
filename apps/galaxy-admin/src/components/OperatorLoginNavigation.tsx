'use client';

import {useEffect} from 'react';

export function OperatorLoginNavigation({target,automatic}:{target:string;automatic:boolean}){
 useEffect(()=>{
  if(automatic)window.location.replace(target);
 },[target,automatic]);
 return null;
}
