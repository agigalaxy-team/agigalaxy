import type {AdminViewServerProps} from 'payload';
import {redirect} from 'next/navigation';
import {operationsPageContext} from './OperationsPage';
import {smtpLocation} from '../lib/smtp-view-model';

export async function SmtpView(props:AdminViewServerProps){
 const {searchParams}=await operationsPageContext(props,'/admin/operations/smtp');
 const location=smtpLocation(searchParams??{});
 // Historical entry points retain their purpose; connection editing has one owner.
 redirect(location.tab==='queue'||location.tab==='bounces'
  ?'/admin/operations/messaging?channel=email&view=runs'
  :'/admin/operations/system-settings?tab=mail');
}
