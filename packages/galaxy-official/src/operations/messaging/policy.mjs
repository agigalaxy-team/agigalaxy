import {createHash} from "node:crypto";
import {ServiceError} from "../../shared/service-error.mjs";

// Technical recovery bounds match the existing account-notice pg-boss policy.
// They are not business triggers, retention periods or delivery guarantees.
export const messagingRecoveryPolicy=Object.freeze({maxSubmitAttempts:4,retryDelaySeconds:30,retryDelayMaxSeconds:900,submissionLeaseSeconds:300,pageSize:25});
export const permission={create:'notices.create',save:'notices.update',activate:'notices.publish',resume:'notices.publish',pause:'notices.withdraw',stop:'notices.withdraw',withdraw:'notices.withdraw',retry:'notices.publish'};
export const auditAction={create:'notice-create',save:'notice-save',activate:'notice-publish',resume:'notice-publish',pause:'notice-withdraw',stop:'notice-withdraw',withdraw:'notice-withdraw',retry:'notice-delivery'};
export const same=(a,b)=>a?.kind==='business-operator'&&b?.kind==='business-operator'&&a.operatorId===b.operatorId&&a.endpoint===b.endpoint;
export const safeProviderCodes=new Set(['smtp_not_configured','smtp_credential_unavailable','smtp_credential_binding_mismatch','smtp_configuration_changed','smtp_authorization_unavailable','smtp_authorization_changed','smtp_recipient_ineligible','smtp_message_invalid','smtp_sender_invalid','smtp_temporary_rejection','smtp_permanent_rejection','smtp_submission_unknown','smtp_authentication_failed','smtp_tls_failed','smtp_connection_failed','smtp_timeout','smtp_dns_failed','smtp_protocol_failed','smtp_transport_failed','smtp_recipient_rejected','smtp_concurrency_limited','smtp_rate_limited','operations_permission_denied','business_admin_denied','identity_directory_unavailable','operations_messaging_not_active','operations_messaging_recipient_ineligible','operations_messaging_execution_interrupted']);
export const fail=(code,status=409)=>{throw new ServiceError(code,status);};
export const iso=seconds=>new Date(seconds*1000).toISOString();
export const messageId=(endpoint,runId,accountId)=>`<${createHash('sha256').update(JSON.stringify([endpoint,runId,accountId,'email'])).digest('hex')}@messages.agigalaxy.org>`;
