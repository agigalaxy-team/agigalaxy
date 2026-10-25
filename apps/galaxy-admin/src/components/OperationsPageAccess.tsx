'use client';
import {createContext,useContext} from 'react';
import type {ReactNode} from 'react';
const OperationsPageAccess=createContext<readonly string[]>([]);
export function OperationsPageAccessProvider({permissions,children}:{permissions:readonly string[];children:ReactNode}){return <OperationsPageAccess.Provider value={permissions}>{children}</OperationsPageAccess.Provider>;}
export const useOperationsPageAccess=()=>useContext(OperationsPageAccess);
