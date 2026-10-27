'use client';

import {createContext,useContext,useMemo,useRef,useState,type ReactNode,type MutableRefObject} from 'react';
import './workbench-interaction.css';

type Interaction={source:string;setSource:(value:string)=>void;actionsTarget:HTMLDivElement|null;setActionsTarget:(value:HTMLDivElement|null)=>void;history:MutableRefObject<Record<string,{filter:string;selectedId:string|null;listTop?:number;detailTop?:number}>>};
const Context=createContext<Interaction|null>(null);

export function WorkbenchInteractionProvider({children}:{children:ReactNode}){
 const [source,setSource]=useState('actions'),[actionsTarget,setActionsTarget]=useState<HTMLDivElement|null>(null);
 const history=useRef<Record<string,{filter:string;selectedId:string|null;listTop?:number;detailTop?:number}>>({});
 const value=useMemo(()=>({source,setSource,actionsTarget,setActionsTarget,history}),[source,actionsTarget]);
 return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useWorkbenchInteraction(){
 const value=useContext(Context);
 if(!value)throw new Error('Workbench interaction provider is required');
 return value;
}
