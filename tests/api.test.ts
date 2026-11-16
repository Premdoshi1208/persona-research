import 'dotenv/config';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { writeFile } from 'node:fs/promises';

process.env.PERSONA_TEST_IMPORT = '1';
const { app } = await import('../server/index.js');
const { migrate, one, query, pool } = await import('../server/db.js');
const { hash } = await import('../server/security.js');

type Client = { cookie?: string; csrf?: string; ip: string };
const owner: Client = { ip: `192.0.2.${Math.floor(Math.random() * 200) + 1}` };
const stranger: Client = { ip: `198.51.100.${Math.floor(Math.random() * 200) + 1}` };
const anonymous: Client = { ip: '203.0.113.87' };
const run = randomUUID();
const email = `qa-api-${run}@persona.example`;
const password = `Initial-${run}`;
const changedPassword = `Changed-${run}`;
const recoveredPassword = `Recovered-${run}`;
const workspaceIds: string[] = [];
const checks: string[] = [];
let server: Server;
let base: string;
let campaign: any;
let duplicate: any;
let ownerWorkspace: string;
let ownerUser: string;
let recoveryCode: string;
let sharedToken: string;
let fixtureInterviewId: string;

async function call(client: Client, method: string, endpoint: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'X-Forwarded-For': client.ip, ...extra };
  if (client.cookie) headers.Cookie = client.cookie;
  if (client.csrf && !('X-CSRF-Token' in extra)) headers['X-CSRF-Token'] = client.csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookie = response.headers.getSetCookie().find(v => v.startsWith('persona='));
  if (cookie) client.cookie = cookie.split(';')[0];
  const bytes = Buffer.from(await response.arrayBuffer());
  const isJson = response.headers.get('Content-Type')?.includes('application/json');
  const data = isJson ? JSON.parse(bytes.toString()) : undefined;
  if (data?.csrf) client.csrf = data.csrf;
  return { status: response.status, headers: response.headers, data, bytes };
}
function check(name: string) { checks.push(name); }
const campaignInput = {
  name: 'QA API research — isolated test fixture',
  description: 'Automated QA fixture, deleted at the end of the integration run.',
  audience: 'Automated test fixture',
  objectives: ['Verify publication and data isolation'],
  questions: ['What was difficult about planning your work?', 'How did you work around that problem?'],
  assumptions: ['Planning may be difficult'],
  strategy: 'Ask neutral follow-up questions.',
  duration_minutes: 3,
  max_participants: 4,
};

describe('real PostgreSQL API integration', { concurrency: false }, () => {
  before(async () => {
    await migrate();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
  });
  after(async () => {
    // Cleanup only this run's known resource IDs; never touch another workspace.
    for (const id of workspaceIds) await query('DELETE FROM workspaces WHERE id=$1', [id]);
    if (ownerUser) await query('DELETE FROM users WHERE id=$1 AND email=$2', [ownerUser, email]);
    await query('DELETE FROM rate_buckets WHERE key IN ($1,$2,$3,$4,$5)', [
      `guest:${hash(owner.ip)}`, `guest:${hash(stranger.ip)}`, `auth:${hash(owner.ip)}`,
      `auth:${hash(anonymous.ip)}`, `recover:${hash(anonymous.ip)}`,
    ]);
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await writeFile('evidence/api-integration.json', JSON.stringify({ verifiedAt: new Date().toISOString(), database: 'real PostgreSQL', providerCalls: 0, checks, passed: checks.length === 16, cleanup: 'Dedicated QA workspaces and user removed' }, null, 2));
    await pool.end();
  });

  it('exposes database health and denies anonymous private API access', async () => {
    const health = await call(anonymous, 'GET', '/api/health');
    assert.equal(health.status, 200); assert.equal(health.data.database, 'connected');
    assert.equal((await call(anonymous, 'GET', '/api/dashboard')).status, 401);
    assert.equal((await call(anonymous, 'GET', '/api/me')).data.workspace, null);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('cache-control'), 'no-store');
    check('Database health, security headers, and anonymous access controls');
  });
  it('creates isolated persistent guest sessions with secure cookie attributes', async () => {
    const a = await call(owner, 'POST', '/api/guest', {});
    const b = await call(stranger, 'POST', '/api/guest', {});
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    ownerWorkspace = a.data.workspace.id;
    workspaceIds.push(ownerWorkspace, b.data.workspace.id);
    assert.notEqual(ownerWorkspace, b.data.workspace.id);
    assert(a.headers.get('set-cookie')?.includes('HttpOnly'));
    assert(a.headers.get('set-cookie')?.includes('SameSite=Lax'));
    const me = await call(owner, 'GET', '/api/me');
    assert.equal(me.data.workspace.id, ownerWorkspace); assert.equal(me.data.workspace.is_guest, true);
    assert.equal((await call(owner, 'POST', '/api/guest', {})).data.workspace.id, ownerWorkspace);
    check('Independent guest workspaces, HTTP-only cookies, and session persistence');
  });
  it('rejects missing CSRF tokens, hostile origins, and invalid campaign data', async () => {
    assert.equal((await call(owner, 'POST', '/api/campaigns', campaignInput, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await call(owner, 'POST', '/api/campaigns', campaignInput, { Origin: 'https://hostile.example' })).status, 403);
    assert.equal((await call(owner, 'POST', '/api/campaigns', { ...campaignInput, name: 'x', questions: [] })).status, 400);
    check('CSRF, origin, and Zod input validation');
  });
  it('creates, edits, reorders, publishes, pauses, resumes, and duplicates a campaign', async () => {
    const saved = await call(owner, 'POST', '/api/campaigns', campaignInput);
    assert.equal(saved.status, 201); campaign = saved.data;
    const questions = [...campaignInput.questions].reverse();
    const edited = await call(owner, 'PATCH', `/api/campaigns/${campaign.id}`, { questions, name: 'QA API research — edited', duration_minutes: 4 });
    assert.equal(edited.status, 200); assert.deepEqual(edited.data.questions, questions);
    const published = await call(owner, 'POST', `/api/campaigns/${campaign.id}/publish`, {});
    assert.equal(published.status, 200); assert.equal(published.data.status, 'active');
    assert(published.data.url.includes(`/interview/${campaign.public_token}`));
    assert.equal((await call(anonymous, 'GET', `/api/public/campaigns/${campaign.public_token}`)).status, 200);
    assert.equal((await call(owner, 'PATCH', `/api/campaigns/${campaign.id}`, { status: 'paused' })).status, 200);
    assert.equal((await call(anonymous, 'GET', `/api/public/campaigns/${campaign.public_token}`)).data.status, 'paused');
    assert.equal((await call(anonymous, 'POST', '/api/public/interviews', { campaignToken: campaign.public_token, consent: true })).status, 409);
    assert.equal((await call(owner, 'PATCH', `/api/campaigns/${campaign.id}`, { status: 'active' })).status, 200);
    const copied = await call(owner, 'POST', `/api/campaigns/${campaign.id}/duplicate`, {});
    assert.equal(copied.status, 201); duplicate = copied.data;
    assert.notEqual(duplicate.public_token, campaign.public_token); assert.equal(duplicate.status, 'draft');
    check('Campaign CRUD, question order, publication, pause/resume, and duplication');
  });
  it('enforces workspace ownership on reads, writes, exports, agents, and settings', async () => {
    assert.deepEqual((await call(stranger, 'GET', '/api/campaigns')).data, []);
    for (const [method, endpoint, body] of [
      ['GET', `/api/campaigns/${campaign.id}`, undefined],
      ['PATCH', `/api/campaigns/${campaign.id}`, { name: 'Unauthorized overwrite' }],
      ['POST', `/api/campaigns/${campaign.id}/publish`, {}],
      ['POST', `/api/campaigns/${campaign.id}/duplicate`, {}],
      ['DELETE', `/api/campaigns/${campaign.id}`, undefined],
      ['GET', `/api/reports/${campaign.id}.pdf`, undefined],
      ['POST', `/api/reports/${campaign.id}/share`, {}],
      ['POST', '/api/ask', { question: 'What did customers say?', campaignId: campaign.id }],
    ] as [string, string, unknown][]) assert.equal((await call(stranger, method, endpoint, body)).status, 404, endpoint);
    assert.deepEqual((await call(stranger, 'GET', '/api/agents')).data, []);
    assert.deepEqual((await call(stranger, 'GET', '/api/ask')).data, []);
    assert.equal((await call(owner, 'PATCH', '/api/settings', { name: 'QA private workspace' })).status, 200);
    assert.notEqual((await call(stranger, 'GET', '/api/me')).data.workspace.name, 'QA private workspace');
    check('Cross-workspace read/write/export/assistant authorization');
  });
  it('enforces the campaign quota without creating overflow rows', async () => {
    const third = await call(owner, 'POST', '/api/campaigns', { ...campaignInput, name: 'QA third campaign' });
    assert.equal(third.status, 201);
    assert.equal((await call(owner, 'POST', '/api/campaigns', { ...campaignInput, name: 'QA rejected fourth campaign' })).status, 429);
    assert.equal((await call(owner, 'GET', '/api/campaigns')).data.length, 3);
    assert.equal((await call(owner, 'DELETE', `/api/campaigns/${third.data.id}`)).status, 200);
    check('Transactional campaign quota and safe deletion');
  });
  it('converts the current guest to an account while preserving private campaigns', async () => {
    const old = { ...owner };
    const registered = await call(owner, 'POST', '/api/auth/register', { email, password, name: 'API QA' });
    assert.equal(registered.status, 201); assert.equal(registered.data.workspace.id, ownerWorkspace);
    assert.equal(registered.data.workspace.is_guest, false); assert.equal(registered.data.workspace.expires_at, null);
    ownerUser = registered.data.user.id; recoveryCode = registered.data.recoveryCode;
    assert(recoveryCode.length >= 40); assert.equal((await call(old, 'GET', '/api/dashboard')).status, 401);
    assert.equal((await call(owner, 'GET', `/api/campaigns/${campaign.id}`)).status, 200);
    const stored = await one('SELECT password_hash,recovery_hash FROM users WHERE id=$1', [ownerUser]);
    assert(stored.password_hash.startsWith('$2')); assert.notEqual(stored.password_hash, password);
    assert.notEqual(stored.recovery_hash, recoveryCode);
    check('Guest conversion, bcrypt hashes, recovery code, and old-session invalidation');
  });
  it('rejects invalid login, creates an authenticated session, and changes passwords', async () => {
    assert.equal((await call(anonymous, 'POST', '/api/auth/login', { email, password: 'Wrong-password-123' })).status, 401);
    const loggedIn: Client = { ip: anonymous.ip };
    assert.equal((await call(loggedIn, 'POST', '/api/auth/login', { email, password })).status, 200);
    assert.equal((await call(loggedIn, 'GET', '/api/me')).data.workspace.id, ownerWorkspace);
    assert.equal((await call(owner, 'POST', '/api/auth/password', { currentPassword: 'bad', password: changedPassword })).status, 401);
    assert.equal((await call(owner, 'POST', '/api/auth/password', { currentPassword: password, password: changedPassword })).status, 200);
    assert.equal((await call(loggedIn, 'GET', '/api/dashboard')).status, 401);
    assert.equal((await call(anonymous, 'POST', '/api/auth/login', { email, password })).status, 401);
    check('Login, password changes, and revocation of other sessions');
  });
  it('recovers with the one-time code and rotates the recovery secret', async () => {
    const recovered = await call(anonymous, 'POST', '/api/auth/recover', { email, recoveryCode, password: recoveredPassword });
    assert.equal(recovered.status, 200); assert.notEqual(recovered.data.recoveryCode, recoveryCode);
    assert.equal((await call(owner, 'GET', '/api/dashboard')).status, 401);
    assert.equal((await call(anonymous, 'POST', '/api/auth/recover', { email, recoveryCode, password: recoveredPassword })).status, 401);
    assert.equal((await call(owner, 'POST', '/api/auth/login', { email, password: recoveredPassword })).status, 200);
    check('Recovery-code rotation and invalidation of previous sessions');
  });
  it('uses database-derived empty-state metrics and generates real PDF and CSV files', async () => {
    const dashboard = await call(owner, 'GET', '/api/dashboard');
    assert.equal(dashboard.data.metrics.totalCampaigns, 2); assert.equal(dashboard.data.metrics.completedInterviews, 0);
    assert.equal(dashboard.data.metrics.completionRate, 0); assert.equal(dashboard.data.metrics.themes, 0);
    const pdf = await call(owner, 'GET', `/api/reports/${campaign.id}.pdf`);
    assert.equal(pdf.status, 200); assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
    assert(pdf.headers.get('content-disposition')?.includes('attachment'));
    const csv = await call(owner, 'GET', `/api/reports/${campaign.id}.csv`);
    assert.equal(csv.status, 200); assert(csv.bytes.toString().includes('Transcript'));
    check('Real database metrics, PDF bytes, and CSV download');
  });
  it('keeps raw transcripts, identities, and detailed findings out of public reports', async () => {
    const participantToken = randomUUID();
    fixtureInterviewId = (await one("INSERT INTO interviews(workspace_id,campaign_id,participant_label,status,token_hash,completed_at,duration_seconds) VALUES($1,$2,'QA private participant','completed',$3,now(),90) RETURNING id", [ownerWorkspace, campaign.id, hash(participantToken)])).id;
    const message = await one("INSERT INTO messages(interview_id,role,text) VALUES($1,'user',$2) RETURNING id", [fixtureInterviewId, 'QA private quote: contact person@example.org for confidential details.']);
    await query('INSERT INTO insights(workspace_id,campaign_id,data) VALUES($1,$2,$3)', [ownerWorkspace, campaign.id, JSON.stringify({ summary: 'QA private executive summary', themes: [{ id: 'qa-theme', title: 'Planning needs: person@example.org', description: 'QA private research note', category: 'need', count: 1, percentage: 100, evidence: [{ interviewId: fixtureInterviewId, messageId: message.id, quote: 'QA private quote: contact person@example.org for confidential details.' }] }], recommendations: [{ title: 'Improve planning', priority: 'medium', rationale: 'QA private rationale' }], limitations: ['QA private limitation: person@example.org'], nextSteps: [] })]);
    const share = await call(owner, 'POST', `/api/reports/${campaign.id}/share`, {});
    assert.equal(share.status, 200); sharedToken = share.data.token;
    const publicReport = await call(anonymous, 'GET', `/api/public/reports/${sharedToken}`);
    assert.equal(publicReport.status, 200); assert.equal(publicReport.data.participantCount, 1);
    const serialized = JSON.stringify(publicReport.data);
    for (const secret of ['QA private quote', 'QA private participant', 'QA private research note', 'QA private executive summary', 'person@example.org', 'QA private rationale', 'QA private limitation', fixtureInterviewId]) assert(!serialized.includes(secret), secret);
    assert(serialized.includes('[email omitted]'));
    assert.equal((await call(stranger, 'GET', `/api/interviews/${fixtureInterviewId}`)).status, 404);
    check('Read-only aggregate public reports omit transcripts, identities, and private notes');
  });
  it('rotates public share links and supports immediate revocation', async () => {
    const replacement = await call(owner, 'POST', `/api/reports/${campaign.id}/share`, {});
    assert.notEqual(replacement.data.token, sharedToken);
    assert.equal((await call(anonymous, 'GET', `/api/public/reports/${sharedToken}`)).status, 404);
    assert.equal((await call(anonymous, 'GET', `/api/public/reports/${replacement.data.token}`)).status, 200);
    assert.equal((await call(owner, 'DELETE', `/api/reports/${campaign.id}/share`)).status, 200);
    assert.equal((await call(anonymous, 'GET', `/api/public/reports/${replacement.data.token}`)).status, 404);
    check('Share-link rotation and immediate revocation');
  });
  it('does not expose stored credentials or authentication hashes in product APIs', async () => {
    const me = await call(owner, 'GET', '/api/me');
    const dashboard = await call(owner, 'GET', '/api/dashboard');
    const content = JSON.stringify([me.data, dashboard.data]);
    for (const key of ['GROQ_API_KEY', 'RENDER_API_KEY', 'DATABASE_URL', 'password_hash', 'recovery_hash', 'token_hash']) assert(!content.includes(key));
    const interview = await call(owner, 'GET', `/api/interviews/${fixtureInterviewId}`);
    assert.equal(interview.status, 200); assert(!('token_hash' in interview.data.interview));
    check('Secret and credential-hash non-disclosure');
  });
  it('logs out securely and rejects the previous cookie', async () => {
    const previous = { ...owner };
    assert.equal((await call(owner, 'POST', '/api/auth/logout', {})).status, 200);
    assert.equal((await call(previous, 'GET', '/api/dashboard')).status, 401);
    assert.equal((await call(owner, 'GET', '/api/me')).data.workspace, null);
    assert.equal((await call(owner, 'POST', '/api/auth/login', { email, password: recoveredPassword })).status, 200);
    check('Logout and invalidation of the previous session cookie');
  });
  it('closes and deletes campaigns with dependent records safely removed', async () => {
    assert.equal((await call(owner, 'PATCH', `/api/campaigns/${duplicate.id}`, { status: 'closed' })).status, 200);
    assert.equal((await call(owner, 'DELETE', `/api/campaigns/${duplicate.id}`)).status, 200);
    assert.equal((await call(owner, 'GET', `/api/campaigns/${duplicate.id}`)).status, 404);
    assert.equal((await call(owner, 'DELETE', `/api/campaigns/${campaign.id}`)).status, 200);
    assert.equal(await one('SELECT id FROM interviews WHERE id=$1', [fixtureInterviewId]), undefined);
    assert.equal((await call(owner, 'GET', '/api/interviews')).data.length, 0);
    check('Campaign closure/deletion and foreign-key cascades');
  });
  it('deletes account/workspace data and invalidates every workspace session', async () => {
    const previous = { ...owner };
    assert.equal((await call(owner, 'DELETE', '/api/workspace')).status, 200);
    assert.equal((await call(previous, 'GET', '/api/dashboard')).status, 401);
    assert.equal(await one('SELECT id FROM users WHERE id=$1', [ownerUser]), undefined);
    assert.equal(await one('SELECT id FROM workspaces WHERE id=$1', [ownerWorkspace]), undefined);
    assert.equal((await call(stranger, 'DELETE', '/api/workspace')).status, 200);
    check('Account/workspace deletion and session invalidation');
  });
});
