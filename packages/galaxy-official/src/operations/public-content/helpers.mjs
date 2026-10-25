import {forumTopics,forumUnclassifiedTopic} from "../../shared/community-forum-topics-v1.mjs";

export const sixTopics=[...forumTopics,forumUnclassifiedTopic],key=item=>item.kind+':'+item.id;
export const visibilityState=view=>view.sourceState!=='available'?'unavailable':view.visibility.hidden?'hidden':'visible';
export const candidates=`SELECT 'post'::text AS kind,p.id,p.created_at FROM forum_posts_v1 p
 LEFT JOIN community_accounts a ON a.id=p.account_id
 LEFT JOIN LATERAL (SELECT permission_id FROM forum_versions_v1 v WHERE v.post_id=p.id AND (p.current_version_id IS NULL OR v.id=p.current_version_id) ORDER BY version_number DESC LIMIT 1) v ON true
 LEFT JOIN forum_permissions_v1 permission ON permission.id=v.permission_id LEFT JOIN consents c ON c.id=permission.consent_id
 WHERE a.endpoint=$1 OR p.account_id IS NULL AND p.subject_id IS NOT NULL AND permission.subject_id=p.subject_id AND c.intent->>'subjectId'=p.subject_id AND c.intent->>'endpoint'=$1 AND c.intent->>'recipient'=$1
 UNION ALL SELECT 'reply'::text AS kind,r.id,r.created_at FROM forum_replies_v1 r
 LEFT JOIN community_accounts a ON a.id=r.account_id LEFT JOIN forum_permissions_v1 permission ON permission.id=r.permission_id LEFT JOIN consents c ON c.id=permission.consent_id
 WHERE a.endpoint=$1 OR r.account_id IS NULL AND r.subject_id IS NOT NULL AND permission.subject_id=r.subject_id AND c.intent->>'subjectId'=r.subject_id AND c.intent->>'endpoint'=$1 AND c.intent->>'recipient'=$1`;
