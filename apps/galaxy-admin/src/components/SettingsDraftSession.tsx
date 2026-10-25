'use client';
import {useLayoutEffect} from 'react';
import type {ReactNode} from 'react';
import {useAuth} from '@payloadcms/ui';
import {settingsDraftMemory,settingsOperatorId} from '../lib/settings-draft-memory';

/** Small identity observer only; no page tree, route subscription or data read. */
export function SettingsDraftSession({children}:{children:ReactNode}){
 const {user}=useAuth(),identity=settingsOperatorId(user);
 useLayoutEffect(()=>{settingsDraftMemory.observeIdentity(identity);},[identity]);
 return children;
}
