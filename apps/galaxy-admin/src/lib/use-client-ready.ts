'use client';
import {useSyncExternalStore} from 'react';

const subscribeReady=()=>()=>{};
const clientReady=()=>true;
const serverReady=()=>false;

/** Match the server snapshot until React has attached the client handlers. */
export function useClientReady(){
 return useSyncExternalStore(subscribeReady,clientReady,serverReady);
}
