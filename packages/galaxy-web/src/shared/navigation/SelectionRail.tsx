'use client';
import React,{useRef,type ComponentProps} from 'react';
import {useSelectionIndicator} from './use-selection-indicator';
import './selection-rail.css';

/** Existing links and buttons keep their own navigation, semantics and guards. */
export function SelectionRail({active,children,...props}:ComponentProps<'nav'>&{active:string}){
 const rail=useRef<HTMLElement>(null);useSelectionIndicator(rail,active);
 return <nav {...props} ref={rail} data-selection-rail><span data-selection-marker aria-hidden="true"/>{children}</nav>;
}
