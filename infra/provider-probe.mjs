import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Run with: node --env-file=.env infra/provider-probe.mjs
const root = resolve(import.meta.dirname, '..');
const key = process.env.GROQ_API_KEY;
if (!key) throw new Error('GROQ_API_KEY is missing');
const headers = { Authorization: `Bearer ${key}`, 'User-Agent': 'Persona/1.0' };
const evidence = { verifiedAt: new Date().toISOString(), requests: [], docs: [
  'https://console.groq.com/docs/models',
  'https://console.groq.com/docs/speech-to-text',
  'https://console.groq.com/docs/text-to-speech/orpheus',
] };
await mkdir(resolve(root, 'evidence'), { recursive: true });
await mkdir(resolve(root, 'tests/fixtures'), { recursive: true });
async function request(name, path, options = {}) {
  const started = Date.now();
  const response = await fetch(`https://api.groq.com/openai/v1/${path}`, {
    ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(60000),
  });
  const item = { name, status: response.status, elapsedMs: Date.now() - started, requestId: response.headers.get('x-request-id') };
  evidence.requests.push(item);
  if (!response.ok) {
    item.error = (await response.text()).slice(0, 1000);
    await writeFile(resolve(root, 'evidence/provider-verification.json'), JSON.stringify(evidence, null, 2));
    throw new Error(`${name}: HTTP ${response.status} ${item.error}`);
  }
  return { response, item };
}
const models = await request('model availability', 'models');
evidence.availableModels = (await models.response.json()).data.map(m => m.id);
const llm = await request('structured reasoning', 'chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'openai/gpt-oss-120b', max_completion_tokens: 512, reasoning_effort: 'low', temperature: 0.2,
    response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Return JSON with keys status and nextQuestion. status must be ok. Suggest one short neutral research question about remote working.' }] }),
});
const llmBody = await llm.response.json();
llm.item.output = JSON.parse(llmBody.choices[0].message.content);
llm.item.usage = llmBody.usage;
const fixtureText = 'As a remote worker, I struggle with switching between too many tools. I spend an hour each day updating tasks. I would pay for one simple place to see priorities and focus on important work.';
const tts = await request('generated speech', 'audio/speech', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'canopylabs/orpheus-v1-english', input: fixtureText, voice: 'autumn', response_format: 'wav' }),
});
const audio = Buffer.from(await tts.response.arrayBuffer());
tts.item.bytes = audio.length;
tts.item.signature = audio.subarray(0, 4).toString();
tts.item.inputCharacters = fixtureText.length;
await writeFile(resolve(root, 'tests/fixtures/participant.wav'), audio);
const form = new FormData();
form.set('model', 'whisper-large-v3-turbo');
form.set('response_format', 'json');
form.set('language', 'en');
form.set('file', new File([audio], 'participant.wav', { type: 'audio/wav' }));
const stt = await request('speech recognition', 'audio/transcriptions', { method: 'POST', body: form });
stt.item.output = await stt.response.json();
evidence.selectedModels = { reasoning: 'openai/gpt-oss-120b', conversation: 'openai/gpt-oss-20b', stt: 'whisper-large-v3-turbo', tts: 'canopylabs/orpheus-v1-english', voice: 'autumn' };
evidence.passed = llm.item.output.status === 'ok' && audio.length > 1000 && /remote|tools|priorities/i.test(stt.item.output.text);
await writeFile(resolve(root, 'evidence/provider-verification.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
