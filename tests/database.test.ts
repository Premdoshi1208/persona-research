import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { migrate, pool, transaction } from '../server/db.js';
import { runPendingJobsOnce } from '../server/jobs.js';
import { reserveUsage } from '../server/ai.js';

test('PostgreSQL enforces public-token uniqueness, message ownership and cascading data deletion', { skip: !process.env.DATABASE_URL }, async () => {
  await migrate();
  await transaction(async db => {
    const workspace = (await db.query("INSERT INTO workspaces(name) VALUES('Database constraint test') RETURNING id")).rows[0];
    const token = randomBytes(24).toString('hex');
    const campaign = (await db.query('INSERT INTO campaigns(workspace_id,name,public_token) VALUES($1,$2,$3) RETURNING id', [workspace.id, 'Constraint test', token])).rows[0];
    await db.query('SAVEPOINT duplicate_token');
    await assert.rejects(db.query('INSERT INTO campaigns(workspace_id,name,public_token) VALUES($1,$2,$3)', [workspace.id, 'Duplicate test', token]), { code: '23505' });
    await db.query('ROLLBACK TO SAVEPOINT duplicate_token');
    const interview = (await db.query('INSERT INTO interviews(campaign_id,workspace_id,participant_label,token_hash) VALUES($1,$2,$3,$4) RETURNING id', [campaign.id, workspace.id, 'Constraint fixture', randomBytes(32).toString('hex')])).rows[0];
    const message = (await db.query("INSERT INTO messages(interview_id,role,text) VALUES($1,'user','A real database fixture.') RETURNING id", [interview.id])).rows[0];
    await db.query('DELETE FROM workspaces WHERE id=$1', [workspace.id]);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM messages WHERE id=$1', [message.id])).rows[0].count, 0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM interviews WHERE id=$1', [interview.id])).rows[0].count, 0);
  });
});

test('a persisted stale analysis job recovers after interruption and completes without replay duplication', { skip: !process.env.DATABASE_URL }, async () => {
  const workspace = (await pool.query("INSERT INTO workspaces(name) VALUES('Recoverable job database test') RETURNING id")).rows[0];
  try {
    const campaign = (await pool.query('INSERT INTO campaigns(workspace_id,name,public_token) VALUES($1,$2,$3) RETURNING id', [workspace.id, 'Job recovery test', randomBytes(24).toString('hex')])).rows[0];
    const key = `fixture-recovery:${randomBytes(16).toString('hex')}`;
    const job = (await pool.query("INSERT INTO jobs(workspace_id,campaign_id,kind,status,attempts,locked_at,unique_key) VALUES($1,$2,'synthesize_research','running',1,now()-interval '3 minutes',$3) RETURNING id", [workspace.id, campaign.id, key])).rows[0];
    await runPendingJobsOnce(job.id);
    const recovered = (await pool.query('SELECT status,attempts,locked_at FROM jobs WHERE id=$1', [job.id])).rows[0];
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.locked_at, null);
    await runPendingJobsOnce(job.id);
    assert.equal((await pool.query('SELECT attempts FROM jobs WHERE id=$1', [job.id])).rows[0].attempts, 2);
  } finally {
    await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace.id]);
  }
});

test('concurrent AI budget reservations cannot overspend a workspace allowance', { skip: !process.env.DATABASE_URL }, async () => {
  const workspace = (await pool.query("INSERT INTO workspaces(name) VALUES('Atomic usage budget test') RETURNING id")).rows[0];
  const before = process.env.DAILY_WORKSPACE_AI_REQUESTS;
  process.env.DAILY_WORKSPACE_AI_REQUESTS = '1';
  try {
    const requests = await Promise.allSettled([reserveUsage(workspace.id, 'llm', 'quota-test-fixture'), reserveUsage(workspace.id, 'llm', 'quota-test-fixture')]);
    assert.equal(requests.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = requests.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'WORKSPACE_BUDGET');
    assert.equal(rejected.reason.status, 429);
    assert.equal((await pool.query('SELECT count(*)::int count FROM usage_records WHERE workspace_id=$1', [workspace.id])).rows[0].count, 1);
  } finally {
    if (before === undefined) delete process.env.DAILY_WORKSPACE_AI_REQUESTS; else process.env.DAILY_WORKSPACE_AI_REQUESTS = before;
    await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace.id]);
  }
});

test.after(async () => { await pool.end(); });
