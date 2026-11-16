import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Credentials are read from the environment. No credentials are printed or stored in state.
// Usage: node --env-file=.env infra/render.mjs inspect|create|deploy|status|logs|restart
const root = resolve(import.meta.dirname, '..');
const statePath = resolve(root, 'infra/state.json');
const state = JSON.parse(await readFile(statePath, 'utf8'));
const action = process.argv[2] || 'inspect';
if (!process.env.RENDER_API_KEY) throw new Error('RENDER_API_KEY is missing');
const headers = { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': 'Persona/1.0' };
async function api(path, method = 'GET', body) {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { message: text }; }
  if (!response.ok) throw new Error(`Render ${method} ${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function save() { await writeFile(statePath, JSON.stringify(state, null, 2)); }
if (action === 'inspect') {
  const owners = await api('/owners?limit=20');
  const services = await api('/services?limit=100');
  console.log(JSON.stringify({ owners: owners.map(x => ({ id: x.owner.id, name: x.owner.name })), services: services.map(x => ({ id: x.service.id, name: x.service.name, repo: x.service.repo, plan: x.service.serviceDetails?.plan, url: x.service.serviceDetails?.url })) }, null, 2));
} else if (action === 'create') {
  if (state.render_service_id) throw new Error('Dedicated Persona service already exists; use deploy instead');
  const required = ['DATABASE_URL', 'GROQ_API_KEY', 'SESSION_SECRET'];
  for (const key of required) if (!process.env[key]) throw new Error(`${key} is missing`);
  const envVars = ['DATABASE_URL', 'GROQ_API_KEY', 'SESSION_SECRET', 'GROQ_REASONING_MODEL', 'GROQ_CONVERSATION_MODEL', 'GROQ_STT_MODEL', 'GROQ_TTS_MODEL', 'GROQ_TTS_VOICE'].filter(key => process.env[key]).map(key => ({ key, value: process.env[key] }));
  const quotaDefaults = {
    DAILY_GLOBAL_AI_REQUESTS: '1500', DAILY_WORKSPACE_AI_REQUESTS: '200',
    MAX_INTERVIEW_TURNS: '10', MAX_CONCURRENT_INTERVIEWS: '5', MAX_AUDIO_MB: '12',
    MAX_AUDIO_BYTES: '12582912', DAILY_GLOBAL_SPEECH_CHARACTERS: '75000',
    DAILY_WORKSPACE_SPEECH_CHARACTERS: '20000', MAX_LLM_OUTPUT_TOKENS: '6000', AGENT_ATTEMPTS: '2',
  };
  for (const [key, value] of Object.entries(quotaDefaults)) envVars.push({ key, value: process.env[key] || value });
  envVars.push({ key: 'NODE_ENV', value: 'production' }, { key: 'NODE_VERSION', value: '22.16.0' });
  const result = await api('/services', 'POST', {
    type: 'web_service', name: 'persona-research-beta', ownerId: state.render_owner_id,
    repo: state.source_repository, branch: 'main', autoDeployTrigger: 'off', envVars,
    serviceDetails: { runtime: 'node', plan: 'free', region: 'oregon', numInstances: 1,
      healthCheckPath: '/api/health', envSpecificDetails: { buildCommand: 'npm ci --include=dev && npm run build', startCommand: 'npm start' } },
  });
  const service = result.service || result;
  state.render_service_id = service.id;
  state.render_service_url = service.serviceDetails?.url;
  state.render_plan = service.serviceDetails?.plan;
  state.render_deploy_id = result.deployId;
  await save();
  console.log(JSON.stringify({ id: state.render_service_id, url: state.render_service_url, plan: state.render_plan, deployId: state.render_deploy_id }, null, 2));
} else if (action === 'deploy') {
  if (!state.render_service_id) throw new Error('Create dedicated service first');
  const result = await api(`/services/${state.render_service_id}/deploys`, 'POST', { clearCache: process.argv.includes('--clear-cache') ? 'clear' : 'do_not_clear' });
  state.render_deploy_id = result.id; await save();
  console.log(JSON.stringify({ deployId: result.id, status: result.status }, null, 2));
} else if (action === 'status') {
  const service = await api(`/services/${state.render_service_id}`);
  const deploys = await api(`/services/${state.render_service_id}/deploys?limit=5`);
  console.log(JSON.stringify({ id: service.id, url: service.serviceDetails?.url, plan: service.serviceDetails?.plan, suspended: service.suspended, deploys: deploys.map(x => ({ id: x.deploy.id, status: x.deploy.status, createdAt: x.deploy.createdAt, finishedAt: x.deploy.finishedAt, commit: x.deploy.commit?.id })) }, null, 2));
} else if (action === 'restart') {
  if (!state.render_service_id) throw new Error('Create dedicated service first');
  const result = await api(`/services/${state.render_service_id}/restart`, 'POST');
  console.log(JSON.stringify({ serviceId: state.render_service_id, restart: result }, null, 2));
} else if (action === 'logs') {
  const result = await api(`/logs?ownerId=${state.render_owner_id}&resource=${state.render_service_id}&limit=100&direction=backward`);
  // Service log messages should never contain secrets. Redact all known credential values defensively.
  let output = JSON.stringify(result, null, 2);
  for (const key of ['RENDER_API_KEY', 'GROQ_API_KEY', 'DATABASE_URL', 'SESSION_SECRET']) if (process.env[key]) output = output.replaceAll(process.env[key], '[REDACTED]');
  console.log(output);
} else throw new Error(`Unknown action: ${action}`);
