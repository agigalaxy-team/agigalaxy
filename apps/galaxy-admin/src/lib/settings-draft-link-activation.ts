'use client';
import {createContext,useContext} from 'react';

export type SettingsDraftLinkActivation=(element:HTMLAnchorElement|null)=>void;
const nativeClick:SettingsDraftLinkActivation=element=>element?.click();

// A synchronous reference to the actual Next Link, never a destination or guard.
// Hosts outside a draft boundary retain their original native click behavior.
export const SettingsDraftLinkActivationContext=createContext<SettingsDraftLinkActivation>(nativeClick);
export const useSettingsDraftLinkActivation=()=>useContext(SettingsDraftLinkActivationContext);
