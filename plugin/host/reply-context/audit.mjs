import { ReplyContextDatabase, now } from './database.mjs';

/**
 * Per-run audit (spec §9, §11.1 reply_context_runs). One row per automatic-reply job records
 * the context hash, selected profile + revision, evidence catalog, retrieval trace, the model's
 * declared audit fields, and the gate outcome — so any auto reply can later be traced to its
 * sources and its allow/deny reason (§14.6).
 */

export class Audit {
  constructor(db) {
    this.db = db instanceof ReplyContextDatabase ? db : new ReplyContextDatabase(db);
  }

  write({jobId, workspaceId, conversationKey, contextHash, profileId, profileRevision,
    evidence, retrievalTrace, modelAudit, gateOutcome, gateReasonCode}) {
    const at = now();
    this.db.db.prepare(`INSERT OR REPLACE INTO reply_context_runs
      (job_id, workspace_id, conversation_key, context_hash, profile_id, profile_revision,
       evidence_json, retrieval_trace_json, model_audit_json, gate_outcome, gate_reason_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(jobId, workspaceId, conversationKey, contextHash, profileId ?? null, profileRevision ?? null,
        JSON.stringify(evidence ?? []), JSON.stringify(retrievalTrace ?? {}),
        JSON.stringify(modelAudit ?? {}), gateOutcome, gateReasonCode ?? '', at);
  }

  get(jobId, workspaceId) {
    const row = this.db.db.prepare('SELECT * FROM reply_context_runs WHERE job_id = ? AND workspace_id = ?').get(jobId, workspaceId);
    if (!row) return null;
    return {
      jobId: row.job_id, workspaceId: row.workspace_id, conversationKey: row.conversation_key,
      contextHash: row.context_hash, profileId: row.profile_id, profileRevision: row.profile_revision,
      evidence: JSON.parse(row.evidence_json), retrievalTrace: JSON.parse(row.retrieval_trace_json),
      modelAudit: JSON.parse(row.model_audit_json), gateOutcome: row.gate_outcome,
      gateReasonCode: row.gate_reason_code, createdAt: row.created_at
    };
  }
}
