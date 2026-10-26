import React, { Children, isValidElement, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './reading-details.css';

type SummaryProps = { children?: React.ReactNode; className?: string };
export function ReadingSummary({ children }: SummaryProps) { return <>{children}</>; }

/** A separately focused reading/editing surface, with return to the invoking control. */
export function ReadingSurface({open,title,children,onClose,className=''}:{open:boolean;title:React.ReactNode;children:React.ReactNode;onClose:()=>void;className?:string}) {
  const dialog=useRef<HTMLDialogElement>(null), id=useId();
  useEffect(()=>{
    const surface=dialog.current;
    if(!surface||!open)return;
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
    surface.showModal();
    return()=>{surface.close();if(previous?.isConnected)previous.focus();};
  },[open]);
  return createPortal(<dialog ref={dialog} className={'reading-detail-dialog galaxy-site '+className} aria-labelledby={id}
    onCancel={event=>{event.preventDefault();event.stopPropagation();onClose();}}>
    <header className="reading-detail-header"><h2 id={id}>{title}</h2><button type="button" className="reading-detail-close" onClick={onClose}>关闭</button></header>
    <div className="reading-detail-body">{open?children:null}</div>
  </dialog>,document.body);
}

type Props = Omit<React.HTMLAttributes<HTMLDivElement>, 'onToggle'> & {
  children: React.ReactNode;
  mode?: 'dialog' | 'inline';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** Secondary reading has its own surface; essential content is explicitly inline. */
export function ReadingDetails({ children, mode = 'dialog', open = false, onOpenChange, className = '', ...attributes }: Props) {
  const parts = Children.toArray(children);
  const summary = parts.find(child => isValidElement<SummaryProps>(child) && child.type === ReadingSummary);
  const title = isValidElement<SummaryProps>(summary) ? summary.props.children : '详细资料';
  const body = parts.filter(child => child !== summary);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState({external:open,shown:open});
  if(state.external!==open)setState({external:open,shown:open});
  const shown=state.external!==open?open:state.shown;
  const setShown=(value:boolean)=>setState(previous=>({...previous,shown:value}));
  const change=useEffectEvent((value:boolean)=>onOpenChange?.(value));
  useEffect(() => {
    if (mode === 'inline') {
      change(!attributes.hidden);
      return () => { change(false); };
    }
  }, [mode, attributes.hidden]);
  useEffect(() => {
    if (mode !== 'dialog') return;
    const surface = dialog.current;
    if (!surface) return;
    const visible=shown&&!attributes.hidden;
    if (visible && !surface.open) surface.showModal();
    if (!visible && surface.open) surface.close();
    change(visible);
  }, [shown, mode, attributes.hidden]);

  if (mode === 'inline') return <section {...attributes} className={'reading-section ' + className}>
    <h3 className="reading-section-title">{title}</h3><div className="reading-section-body">{body}</div>
  </section>;

  return <div {...attributes} className={'reading-detail-entry ' + className}>
    <button ref={trigger} type="button" className="reading-detail-link" aria-haspopup="dialog" onClick={() => setShown(true)}>{title}</button>
    {createPortal(<dialog ref={dialog} className={'reading-detail-dialog galaxy-site ' + className} aria-labelledby={id}
      onCancel={event=>{event.preventDefault();event.stopPropagation();setShown(false);}}
      onClose={event => { if(event.target!==event.currentTarget)return;event.stopPropagation();setShown(false);trigger.current?.focus(); }}>
      <header className="reading-detail-header"><h2 id={id}>{title}</h2><button type="button" className="reading-detail-close" onClick={() => setShown(false)}>关闭</button></header>
      <div className="reading-detail-body">{shown ? body : null}</div>
    </dialog>, document.body)}
  </div>;
}
