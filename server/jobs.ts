import { query, one, transaction } from './db.js';
import { analyzeInterview, synthesizeResearch } from './ai.js';

let running = false;
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;

export async function enqueueAnalysis(workspaceId: string, campaignId: string, interviewId?: string, force = false) {
  const key = interviewId ? `interview:${interviewId}` : `campaign:${campaignId}:${force ? Math.floor(Date.now() / 60000) : 'refresh'}`;
  const job = await one<any>(`INSERT INTO jobs(workspace_id,campaign_id,interview_id,kind,status,unique_key,run_after)
    VALUES($1,$2,$3,$4,'pending',$5,now()) ON CONFLICT(unique_key) DO UPDATE SET status=CASE WHEN jobs.status='failed' THEN 'pending' ELSE jobs.status END, attempts=CASE WHEN jobs.status='failed' THEN 0 ELSE jobs.attempts END,run_after=CASE WHEN jobs.status='failed' THEN now() ELSE jobs.run_after END RETURNING *`, [workspaceId, campaignId, interviewId || null, interviewId ? 'analyze_interview' : 'synthesize_research', key]);
  if (!running && !stopped) void tick();
  return job;
}

async function tick(reschedule = true, onlyJobId?: string) {
  if (running || stopped) return;
  running = true;
  try {
    await query(`UPDATE jobs SET status='pending',locked_at=NULL,run_after=now(),error='Recovered after worker interruption' WHERE status='running' AND locked_at < now()-interval '2 minutes' AND ($1::uuid IS NULL OR id=$1)`, [onlyJobId || null]);
    if (!onlyJobId) await query(`UPDATE agent_runs SET status='failed',error='Worker interrupted; task can be retried',summary='Recovered interrupted execution',finished_at=now() WHERE status='running' AND started_at < now()-interval '4 minutes'`);
    const job = await one<any>(`WITH next_job AS (SELECT id FROM jobs WHERE status='pending' AND run_after<=now() AND ($1::uuid IS NULL OR id=$1) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE jobs SET status='running',attempts=attempts+1,locked_at=now() FROM next_job WHERE jobs.id=next_job.id RETURNING jobs.*`, [onlyJobId || null]);
    if (job) {
      const heartbeat = setInterval(() => void query('UPDATE jobs SET locked_at=now() WHERE id=$1 AND status=\'running\'', [job.id]).catch(() => {}), 20_000);
      heartbeat.unref?.();
      try {
        // A PostgreSQL advisory lock serializes synthesis for a campaign across instances.
        await transaction(async (db: any) => {
          await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`persona-analysis:${job.campaign_id}`]);
          if (job.interview_id) await analyzeInterview(job.interview_id);
          await synthesizeResearch(job.campaign_id);
        });
        await query(`UPDATE jobs SET status='completed',locked_at=NULL,error=NULL WHERE id=$1`, [job.id]);
      } catch (error: any) {
        const retry = Number(job.attempts) < 3;
        await query(`UPDATE jobs SET status=$2,locked_at=NULL,error=$3,run_after=now()+($4::int * interval '1 second') WHERE id=$1`, [job.id, retry ? 'pending' : 'failed', String(error?.message || 'Analysis could not finish').slice(0, 500), 20 * Number(job.attempts)]);
        console.warn(JSON.stringify({ event: 'analysis_job_failed', jobId: job.id, retry, code: error?.code || 'ANALYSIS_ERROR' }));
      } finally {
        clearInterval(heartbeat);
      }
    }
  } catch (error: any) {
    console.warn(JSON.stringify({ event: 'job_worker_retry', code: error?.code || 'DATABASE_UNAVAILABLE' }));
  } finally {
    running = false;
    if (!stopped && reschedule) { timer = setTimeout(() => void tick(), 2000); timer.unref?.(); }
  }
}

export function startJobWorker() {
  stopped = false;
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

export async function runPendingJobsOnce(jobId?: string) {
  await tick(false, jobId);
}
