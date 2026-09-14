import { randomUUID } from 'node:crypto';
import { AuditService } from './audit.mjs';
import { digest } from './shared/digest.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { ownerExportDatasets, exportViewScopes, exportCreateSchema, exportIdSchema, exportPageSchema, exportBinarySchema, sameExportViews } from './shared/data-export-schema.mjs';
import { exportSources } from './infrastructure/export-datasets.mjs';
import { readExportView } from './domain/export-view.mjs';
const parse = (schema, value) => { const parsed = schema.safeParse(value); if (!parsed.success) throw new ServiceError('invalid_export_request'); return parsed.data; };
const iso = seconds => new Date(seconds * 1000).toISOString();

export class DataExportService {
  constructor(access, viewServices = {}, retirement = null) { this.access = access; this.audit = new AuditService(access); this.viewServices = viewServices; this.retirement = retirement; }
  specification(actor) {
    return this.access.runAuthorized(actor, 'data-export', async (_db, authorization) => ({ version: 1, endpoint: this.access.endpoint,
      subjectId: actor.subjectId, datasets: ownerExportDatasets, ownership: 'own-submissions-and-selected-current-authorized-views',
      viewKinds: Object.keys(exportViewScopes).filter(kind => authorization.credentialScopes.includes(exportViewScopes[kind])),
      binaryDatasets: ['outcome-materials-v2'],
      binaryExportPolicy: 'current-authorized-outcome-material-read; unavailable after revocation or expiry; chunked up to 524288 bytes',
      maxSelectedViews: 32, serviceStatus: this.retirement?.snapshot() ?? null,
      maxLifetimeSeconds: 600, maxPageSize: 100, serverStoresPayloadCopy: false,
      excluded: ['authentication challenges and credentials', 'service secrets', 'other authors records without current read permission', 'remote source files'],
      proofPolicy: 'historical signed bytes; current public validity requires online recheck' }));
  }
  describe(row) { return { version: 1, endpoint: this.access.endpoint, id: row.id, subjectId: row.subject_id,
    datasets: row.datasets, bounds: row.bounds, selectionCutoff: new Date(row.selection_cutoff).toISOString(),
    expiresAt: Date.parse(row.expires_at) / 1000, revoked: Boolean(row.revoked_at), views: row.views,
    ownership: row.views.length ? 'mixed-authorized-copy' : 'owner-copy',
    consistency: 'bounded-live-pages; mutable status is re-read, not a database backup' }; }
  async ticket(db, actor, id) {
    this.retirement?.assertDownload();
    const row = (await db.query('SELECT * FROM data_exports WHERE id=$1 AND subject_id=$2 AND binding_id=$3 FOR SHARE', [id, actor.subjectId, actor.bindingId])).rows[0];
    if (!row) throw new ServiceError('not_found', 404);
    if (row.revoked_at || Date.parse(row.expires_at) <= this.access.now() * 1000) throw new ServiceError('export_expired', 410);
    return row;
  }
  create(actor, input) {
    this.retirement?.assertDownload();
    const selected = parse(exportCreateSchema, input);
    return this.access.runResourceWrite(actor,'data-export',{}, async (db, authorization) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`data-export:${actor.bindingId}`]);
      const existing = (await db.query('SELECT id FROM data_exports WHERE id=$1', [selected.id])).rows[0];
      if (existing) {
        const row = await this.ticket(db, actor, selected.id);
        if (JSON.stringify(row.datasets) !== JSON.stringify(selected.datasets) || !sameExportViews(row.views, selected.views)) throw new ServiceError('export_conflict', 409);
        return this.describe(row);
      }
      const count = (await db.query('SELECT count(*) FROM data_exports WHERE binding_id=$1 AND revoked_at IS NULL AND expires_at>$2', [actor.bindingId, iso(this.access.now())])).rows[0].count;
      if (Number(count) >= 3) throw new ServiceError('export_limit', 429);
      const cutoff = (await db.query('SELECT transaction_timestamp() AS value')).rows[0].value;
      const bounds = {};
      for (const name of selected.datasets) {
        if (name === 'authorized-views') {
          for (const view of selected.views) await readExportView(this.viewServices, db, actor, view, authorization, this.access.now(), 'inspect');
          bounds[name] = String(selected.views.length).padStart(8, '0'); continue;
        }
        const source = exportSources[name];
        bounds[name] = (await db.query(`SELECT max((${source.key}) COLLATE "C") AS last FROM ${source.from}
          WHERE ${source.owner}=$1 AND ${source.cutoff}<=$2`, [actor.subjectId, cutoff])).rows[0].last ?? '';
      }
      const expires = Math.min(this.access.now() + 600, this.retirement?.downloadDeadline() ?? Infinity, Date.parse((await db.query('SELECT expires_at FROM bindings WHERE id=$1', [actor.bindingId])).rows[0].expires_at) / 1000);
      const row = (await db.query(`INSERT INTO data_exports(id,subject_id,binding_id,datasets,bounds,selection_cutoff,expires_at,views)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb) RETURNING *`, [selected.id, actor.subjectId, actor.bindingId, JSON.stringify(selected.datasets), JSON.stringify(bounds), cutoff, iso(expires), JSON.stringify(selected.views)])).rows[0];
      await this.audit.record(db, actor, authorization, 'data.export.create', selected.id, 'data-export');
      return this.describe(row);
    });
  }
  page(actor, input) {
    const selection = parse(exportPageSchema, input);
    return this.access.runAuthorized(actor, 'data-export', async (db, authorization) => {
      const ticket = await this.ticket(db, actor, selection.id), source = exportSources[selection.dataset];
      if (!ticket.datasets.includes(selection.dataset)) throw new ServiceError('export_dataset_denied', 403);
      const through = ticket.bounds[selection.dataset];
      if (selection.after > through) throw new ServiceError('invalid_export_cursor');
      const projected = selection.dataset === 'authorized-views';
      let rows;
      if (projected) {
        if (selection.after && !/^\d{8}$/.test(selection.after)) throw new ServiceError('invalid_export_cursor');
        const start = Number(selection.after || '0');
        if (start > ticket.views.length) throw new ServiceError('invalid_export_cursor');
        rows = [];
        // A single view per page avoids holding locks over unrelated objects in
        // caller-selected order; revoked views fail explicitly, never vanish.
        if (start < ticket.views.length) rows.push({ export_cursor: String(start + 1).padStart(8, '0'),
          ...await readExportView(this.viewServices, db, actor, ticket.views[start], authorization, this.access.now()) });
      } else rows = (await db.query(`SELECT ${source.key} AS export_cursor,${source.fields} FROM ${source.from}
        WHERE ${source.owner}=$1 AND (${source.key}) COLLATE "C">$2 AND (${source.key}) COLLATE "C"<=$3
        AND ${source.cutoff}<=$4 ORDER BY (${source.key}) COLLATE "C" LIMIT $5`,
      [actor.subjectId, selection.after, through, ticket.selection_cutoff, selection.limit + 1])).rows;
      const items = []; let bytes = 0, cursor = selection.after;
      for (const row of rows.slice(0, selection.limit)) {
        const { export_cursor, ...original } = row;
        let item = source?.transform ? source.transform(original, this.access.now()) : original;
        // Outcome material metadata is exportable as the owner's own record.
        // Attachment bytes must be read through the same current authorization
        // path as ordinary material reads; storage keys and encryption IDs are
        // never exposed in the export projection.
        if (selection.dataset === 'outcome-materials-v2' && original.source_kind === 'attachment') {
          const reader = this.viewServices.outcomeMaterials;
          if (!reader) throw new ServiceError('export_binary_unavailable', 503);
          // page() already owns the authorization transaction; use the
          // within-transaction reader to avoid nested PGlite/PostgreSQL
          // transactions and to recheck current Consent atomically.
          const content = await reader.readWithin(db, actor, original.id);
          item = content.contentAvailable && content.bytesBase64
            ? { ...item, binaryContentAvailable: true, contentBase64: content.bytesBase64 }
            : { ...item, binaryContentAvailable: false, contentBase64: undefined };
        }
        const size = Buffer.byteLength(JSON.stringify(item));
        if (size > 700000) throw new ServiceError('export_record_too_large', 413);
        if (bytes + size > 700000) break;
        bytes += size; cursor = export_cursor; items.push(item);
      }
      const snapshot = { version: 1, endpoint: this.access.endpoint, subjectId: actor.subjectId, exportId: ticket.id,
        dataset: selection.dataset, after: selection.after, through, expiresAt: Date.parse(ticket.expires_at) / 1000,
        selectionCutoff: new Date(ticket.selection_cutoff).toISOString(), checkedAt: this.access.now(), ownership: projected ? 'current-authorized-view' : 'owner-copy',
        items, nextAfter: (projected ? Number(cursor || '0') < ticket.views.length : rows.length > items.length) ? cursor : null,
        proofValidity: 'historical-not-current-authorization' };
      const hash = digest(JSON.stringify(snapshot)), id = randomUUID();
      await db.query(`INSERT INTO data_export_reads(id,export_id,subject_id,dataset,after_cursor,result_hash,result_count)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, ticket.id, actor.subjectId, selection.dataset, selection.after, hash, items.length]);
      await this.audit.record(db, actor, authorization, 'data.export.page', id, 'data-export');
      return { ...snapshot, sha256: hash };
    });
  }
  binary(actor, input) {
    const selection = parse(exportBinarySchema, input);
    return this.access.runAuthorized(actor, 'data-export', async (db, authorization) => {
      const ticket = await this.ticket(db, actor, selection.id);
      if (!ticket.datasets.includes(selection.dataset)) throw new ServiceError('export_dataset_denied', 403);
      const row = (await db.query(`SELECT * FROM outcome_materials_v2 WHERE id=$1 AND subject_id=$2 AND created_at<=$3`,
        [selection.recordId, actor.subjectId, ticket.selection_cutoff])).rows[0];
      if (!row || row.source_kind !== 'attachment') throw new ServiceError('export_binary_unavailable', 404);
      const reader = this.viewServices.outcomeMaterials;
      if (!reader?.readWithin) throw new ServiceError('export_binary_unavailable', 503);
      const content = await reader.readWithin(db, actor, row.id);
      if (!content.contentAvailable || !content.bytesBase64) {
        if (actor.httpRequestId) await this.audit.record(db, actor, authorization, 'data.export.binary', row.id, 'data-export');
        return {
        version: 1, endpoint: this.access.endpoint, subjectId: actor.subjectId, exportId: ticket.id,
        dataset: selection.dataset, recordId: row.id, offset: selection.offset, length: 0,
        totalBytes: Number(row.byte_size), nextOffset: null, complete: false, binaryContentAvailable: false,
        reason: content.reason ?? 'unavailable', sha256: row.sha256
        };
      }
      const bytes = Buffer.from(content.bytesBase64, 'base64'), start = selection.offset;
      if (start > bytes.length) throw new ServiceError('invalid_export_cursor', 400);
      const chunk = bytes.subarray(start, Math.min(bytes.length, start + selection.length));
      const nextOffset = start + chunk.length < bytes.length ? start + chunk.length : null;
      if (actor.httpRequestId) await this.audit.record(db, actor, authorization, 'data.export.binary', row.id, 'data-export');
      return { version: 1, endpoint: this.access.endpoint, subjectId: actor.subjectId, exportId: ticket.id,
        dataset: selection.dataset, recordId: row.id, offset: start, length: chunk.length, totalBytes: bytes.length,
        nextOffset, complete: nextOffset === null, binaryContentAvailable: true,
        contentBase64: chunk.toString('base64'), sha256: row.sha256 };
    });
  }
  revoke(actor, input) {
    const { id } = parse(exportIdSchema, input);
    return this.access.runAuthorized(actor, 'data-export', async (db, authorization) => {
      const row = (await db.query('SELECT * FROM data_exports WHERE id=$1 AND subject_id=$2 FOR UPDATE', [id, actor.subjectId])).rows[0];
      if (!row) throw new ServiceError('not_found', 404);
      if (!row.revoked_at) {
        await db.query('UPDATE data_exports SET revoked_at=$2 WHERE id=$1', [id, iso(this.access.now())]);
        await this.audit.record(db, actor, authorization, 'data.export.revoke', id, 'data-export');
      }
      return { id, revoked: true };
    });
  }
}
