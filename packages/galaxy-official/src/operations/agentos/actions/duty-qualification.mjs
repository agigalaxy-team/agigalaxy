import { isDeepStrictEqual } from 'node:util';
import {
  fail,
  parse,
  requestSchema,
  requiredActionFor,
  humanDraftConfig,
} from './support.mjs';

export async function assertPriorDutyDecisionWithin(
  db,
  actor,
  request,
  grantId,
) {
  const actions = {
    'content-visibility': [
      'community-content-visibility',
      'community-content-batch-visibility',
    ],
    'content-curation': ['community-content-curation'],
    'section-classification': ['community-section-classify'],
    'section-visibility': ['community-section-visibility'],
    'resource-visibility': ['resource-visibility'],
    'account-restriction': ['restriction-set', 'restriction-release'],
    'feedback-update': ['feedback-update'],
    'file-access': ['file-access-stop', 'file-access-restore'],
    'case-resolve': ['community-report-resolve'],
    'recommendation-direction': ['recommendations.configure'],
    'search-apply': ['search-quality.publish', 'search-quality.restore'],
    'search-restore': ['search-quality.publish', 'search-quality.restore'],
    'messaging-state': ['notice-publish', 'notice-withdraw'],
  }[request.kind];
  if (!actions) return;
  const id = request.targetId ?? request.versionId ?? null,
    rows = (
      await db.query(
        `SELECT actor_kind,operator_id,grant_id,operation_id FROM business_admin_audit_v1 WHERE endpoint=$1 AND action=ANY($2::text[])
   AND ($3::text IS NULL OR account_id::text=$3 OR selection->>'id'=$3 OR selection->>'resourceId'=$3 OR selection->>'planId'=$3 OR selection->'items' @> jsonb_build_array(jsonb_build_object('id',$3::text)))
   ORDER BY sequence DESC LIMIT 1`,
        [this.endpoint, actions, id],
      )
    ).rows;
  const previous = rows[0];
  if (
    previous &&
    (previous.actor_kind !== 'operations-ai-service' ||
      previous.operator_id !== actor.operatorId ||
      previous.grant_id !== grantId)
  )
    fail('operations_agentos_human_review_required', 409);
}

export async function qualifyDutyTargetWithin(
  db,
  { actor, permission, targetId, request, command, grantId = null },
) {
  const x = parse(requestSchema(request), request);
  if (requiredActionFor(x) !== permission || !this.dutyActionReady(permission))
    fail('operations_agentos_action_not_connected', 503);
  const expected =
    x.targetId ??
    x.reportId ??
    x.strategyId ??
    (x.kind === 'public-content-batch'
      ? targetId
      : x.kind === 'recommendation-direction'
        ? x.themeKey
        : x.kind === 'message-draft-create'
          ? command?.planId
          : command?.versionId);
  if (
    expected !== targetId ||
    (x.kind === 'public-content-batch' &&
      !x.items.some((item) => item.id === targetId))
  )
    fail('operations_agentos_scope_denied', 403);
  if (['job-cancel', 'job-retry', 'search-retry'].includes(x.kind)) {
    await this.service('jobActions', 'qualifyWithin').qualifyWithin(
      db,
      actor,
      x.kind,
      x,
      command,
    );
  } else if (x.kind === 'public-content-batch') {
    for (const item of x.items) {
      const service = this.service('content', 'rawWithin'),
        source = await service.rawWithin(db, item.kind, item.id);
      if (
        !(
          await service.publicSourceWithin(
            db,
            item.kind,
            source.head,
            source.source,
          )
        ).available
      )
        fail('operations_source_unavailable', 409);
      if (grantId)
        await this.assertPriorDutyDecisionWithin(
          db,
          actor,
          { kind: 'content-visibility', targetId: item.id },
          grantId,
        );
    }
  } else if (x.kind === 'private-case-message') {
    const g = this.service('chatReports', 'assertDutyCaseWithin');
    await g.assertDutyCaseWithin(db, actor, x.reportId);
    const row = await g.row(db, x.reportId),
      context = await g.contextWithin(db, row, actor, { operator: true });
    if (!context.canModerate || g.expired(row))
      fail('operations_agentos_human_review_required', 409);
    const materials = (
      await db.query(
        'SELECT * FROM account_chat_governance_materials_v1 WHERE report_id=$1 AND message_id=$2 AND revision=$3 AND erased_at IS NULL',
        [x.reportId, x.messageId, command.messageRevision],
      )
    ).rows;
    if (
      !materials.length ||
      !(await g.sourceStillAvailableWithin(db, materials[0]))
    )
      fail('chat_report_source_unavailable', 409);
    if (grantId) {
      const prior = (
        await db.query(
          "SELECT actor_kind,operator_id,grant_id FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='chat-report-event' AND selection->>'reportId'=$2 AND selection->>'messageId'=$3 ORDER BY sequence DESC LIMIT 1",
          [this.endpoint, x.reportId, x.messageId],
        )
      ).rows[0];
      if (
        prior &&
        (prior.actor_kind !== 'operations-ai-service' ||
          prior.operator_id !== actor.operatorId ||
          prior.grant_id !== grantId)
      )
        fail('operations_agentos_human_review_required', 409);
    }
  } else if (x.kind === 'content-visibility' || x.kind === 'content-curation') {
    const source = await this.service('content', 'rawWithin').rawWithin(
        db,
        x.targetKind,
        x.targetId,
      ),
      state = await this.services.content.publicSourceWithin(
        db,
        x.targetKind,
        source.head,
        source.source,
      );
    if (!state.available) fail('operations_source_unavailable', 409);
  } else if (x.kind === 'resource-visibility') {
    const service = this.service('resources', 'rowWithin'),
      row = await service.rowWithin(db, x.targetKind, x.targetId);
    if (
      (await service.sourceWithin(db, x.targetKind, row)).state !== 'available'
    )
      fail('operations_source_unavailable', 409);
  } else if (
    x.kind === 'section-visibility' ||
    x.kind === 'section-classification'
  ) {
    const service = this.service('community', 'sectionWithin'),
      row = await service.sectionWithin(db, x.targetId);
    if (
      (await service.sectionViewWithin(db, row, actor)).sourceState !==
      'available'
    )
      fail('operations_source_unavailable', 409);
  } else if (x.kind === 'case-resolve') {
    const service = this.service('community', 'reportWithin'),
      row = await service.reportWithin(db, x.targetId),
      view = await service.reportViewWithin(db, row, actor, { detail: true });
    if (!view.canModerate || view.source.availability !== 'available')
      fail('operations_agentos_human_review_required', 409);
    if (
      row.decision_event_id &&
      (
        await db.query('SELECT 1 FROM forum_governance_events_v1 WHERE id=$1', [
          row.decision_event_id,
        ])
      ).rows.length
    )
      fail('operations_agentos_human_review_required', 409);
  } else if (x.kind === 'account-restriction')
    await this.service('accounts', 'accountWithin').accountWithin(
      db,
      x.targetId,
    );
  else if (x.kind === 'feedback-update')
    await this.service('feedback', 'headWithin').headWithin(db, x.targetId);
  else if (x.kind === 'file-access' || x.kind === 'file-scan-retry')
    await this.service(
      x.kind === 'file-access' ? 'fileAccess' : 'files',
      'scopedRowWithin',
    ).scopedRowWithin(db, x.targetKind, x.targetId);
  else if (x.kind === 'recommendation-direction') {
    const catalog = await this.service(
      'recommendations',
      'catalogWithin',
    ).catalogWithin(db);
    if (!catalog.some((theme) => theme.key === x.themeKey && theme.enabled))
      fail('recommendation_theme_unavailable', 409);
  } else if (x.kind === 'search-apply' || x.kind === 'search-restore') {
    const selected = await this.service(
      'searchQuality',
      'versionWithin',
    ).versionWithin(db, command.versionId);
    if (!selected) fail('search_quality_version_unavailable', 409);
  } else if (
    x.kind === 'ordinary-strategy-draft' ||
    x.kind === 'ordinary-strategy-publish'
  ) {
    const current = await this.service(
      'ordinaryStrategies',
      'inspectWithin',
    ).inspectWithin(db, actor, x.strategyId);
    if (
      current.head.paused ||
      !current.strategy.ordinaryBounds ||
      current.strategy.mode === 'human-led'
    )
      fail('operations_agentos_human_review_required', 409);
  } else if (
    x.kind === 'message-draft-create' ||
    x.kind === 'message-draft-save'
  ) {
    if (!isDeepStrictEqual(command?.config, humanDraftConfig(x.config)))
      fail('operations_agentos_scope_denied', 403);
    // Eligible scope proves only a new, unapproved draft or a current draft.
    // It grants no publication, delivery, fact or audience approval.
    await this.service(
      'messaging',
      'assertDutyDraftWithin',
    ).assertDutyDraftWithin(db, actor, {
      planId: targetId,
      kind: x.kind === 'message-draft-create' ? 'create' : 'save',
      config: command.config,
    });
  } else if (x.kind === 'messaging-state') {
    const messaging = this.service('messaging', 'assertDutyPlanWithin'),
      plan = await messaging.planWithin(db, x.targetId);
    await messaging.assertDutyPlanWithin(db, actor, plan, x.action);
  } else fail('operations_agentos_action_not_connected', 503);
  if (grantId) await this.assertPriorDutyDecisionWithin(db, actor, x, grantId);
  return { allowed: true };
}

export async function qualifyDutyBatchImpactWithin(
  db,
  actor,
  request,
  approved,
) {
  const ids = request.items.map((item) => item.id),
    context = this.authority.dutyContext(actor),
    task = (
      await db.query(
        'SELECT configuration FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2',
        [this.endpoint, context.taskId],
      )
    ).rows[0],
    grant = (
      await db.query(
        'SELECT resource_scope_kind,resource_ids FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2',
        [this.endpoint, approved.grantId],
      )
    ).rows[0],
    version = (
      await db.query(
        'SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2',
        [this.endpoint, approved.strategyVersionId],
      )
    ).rows[0],
    scope = version?.configuration.strategies.find(
      (item) => item.id === approved.strategyId,
    )?.execution?.resourceScope;
  const planIds = task?.configuration.plan?.resourceIds;
  if (
    !Array.isArray(planIds) ||
    !planIds.length ||
    grant?.resource_scope_kind !== 'selected' ||
    scope?.kind !== 'selected' ||
    ids.some(
      (id) =>
        !planIds.includes(id) ||
        !grant.resource_ids.includes(id) ||
        !scope.resourceIds.includes(id),
    )
  )
    fail('operations_agentos_human_review_required', 409);
}
