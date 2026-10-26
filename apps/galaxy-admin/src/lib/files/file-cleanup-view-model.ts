import type {CleanupCandidate,CleanupPlan} from "../../components/files/file-cleanup-types";
export const cleanupStates:Record<CleanupPlan['state'],string>={'awaiting-approval':'等待确认',queued:'等待清理',running:'正在清理',completed:'处理已结束',attention:'有结果未确认',cancelled:'已取消'};
export const cleanupReasons={expired:'已到既有保留期限',unreferenced:'现有来源已无有效引用'};
export const cleanupCodes:Record<string,string>={
 'processing-active':'正在上传或扫描，暂不能选择','reference-check-incomplete':'引用尚未完整核对','storage-unavailable':'对象存储暂不可用',
 'file-unavailable':'文件记录当前不可取得','already-removed':'对象此前已移除','file-changed':'文件状态已变化，未继续清理','references-changed':'来源引用已变化，未继续清理','eligibility-changed':'当前已不符合本次清理条件',
 'plan-cancelled':'已取消后续清理','object-removed':'对象已移除','object-already-absent':'已核实对象不存在',
 operations_permission_denied:'执行权限已变化，未继续清理',business_admin_denied:'管理资格已变化，未继续清理',operations_authorization_unavailable:'当前执行授权暂不可核对',
 attachment_service_unavailable:'对象存储暂不可用',attachment_storage_unavailable:'对象存储暂不可用',attachment_storage_integrity_failed:'对象信息不一致，已停止清理',operations_file_cleanup_result_unknown:'正在核对对象是否已移除',
 operations_file_cleanup_unavailable:'清理服务暂时无法取得结果',
 operations_file_changed:'文件状态已有更新，所选范围和说明已保留。',operations_file_cleanup_ineligible:'所选文件当前不符合清理条件，请查看最新状态。',
 operations_file_cleanup_plan_changed:'文件或引用已有更新，请查看当前计划；范围变化后需重新制定。',operations_file_cleanup_plan_state:'这份计划的处理状态已更新。',
};
export const cleanupTitle=(file:Pick<CleanupCandidate,'name'|'id'>)=>file.name?.trim()||'文件 '+file.id.slice(0,8);
export const cleanupKey=(file:Pick<CleanupCandidate,'kind'|'id'>)=>file.kind+':'+file.id;
export function cleanupCandidatesPath(kind:'chat'|'forum'|'all',after=''){
 const query=new URLSearchParams({limit:'25'});if(kind!=='all')query.set('kind',kind);if(after)query.set('after',after);return'/v1/operations/files/cleanup/candidates?'+query;
}
