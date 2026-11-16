import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSpeech, verifyExactEvidence, aggregateThemeSources, campaignSchema, analystSchema, speech, transcribe } from '../server/ai.js';

test('Orpheus segmentation preserves words and stays inside the actual 200 character API limit', () => {
  const source = `${'A customer response contains several useful details. '.repeat(15)}${'x'.repeat(230)}`;
  const chunks = splitSpeech(source);
  assert(chunks.length > 1);
  assert(chunks.every(part => part.length > 0 && part.length <= 190));
  assert.equal(chunks.join('').replace(/\s/g, ''), source.replace(/\s/g, ''));
});

test('evidence validation rejects paraphrases, invented ids and interviewer statements', () => {
  const messages = [
    { id: 'p1', role: 'participant', text: 'I spend two hours every Friday copying data into a spreadsheet.' },
    { id: 'a1', role: 'assistant', text: 'Would an automated export solve your problem?' },
  ];
  const accepted = verifyExactEvidence([
    { messageId: 'p1', quote: 'two hours every Friday' },
    { messageId: 'p1', quote: 'three hours every Monday' },
    { messageId: 'a1', quote: 'automated export' },
    { messageId: 'invented', quote: 'I need automation.' },
  ], messages);
  assert.deepEqual(accepted, [{ messageId: 'p1', quote: 'two hours every Friday' }]);
});

test('theme frequency counts independent interviews, not repeated quotes or findings', () => {
  const quote = { interviewId: 'i1', messageId: 'm1', quote: 'Manual exports are slow.' };
  const sources = new Map([
    ['f1', { evidence: [quote, quote] }],
    ['f2', { evidence: [{ ...quote, messageId: 'm2' }] }],
    ['f3', { evidence: [{ ...quote, interviewId: 'i2', messageId: 'm3' }] }],
  ]);
  const result = aggregateThemeSources({ findingIds: ['f1', 'f2', 'f3', 'f1', 'invented'] }, sources, 3);
  assert.equal(result.count, 2);
  assert.equal(result.percentage, 67);
  assert.equal(result.evidence.length, 3);
  assert.deepEqual(result.interviewIds, ['i1', 'i2']);
});

test('agent schemas reject missing campaign content and unsupported finding categories', () => {
  assert.equal(campaignSchema.safeParse({ name: 'Research' }).success, false);
  assert.equal(analystSchema.safeParse({ summary: 'An actual interview.', findings: [{ title: 'Unsupported', detail: 'No quote', category: 'fact', evidence: [] }], objectiveCoverage: [], limitations: [] }).success, false);
});

test('invalid voice input fails safely before a provider request is possible', async () => {
  await assert.rejects(speech('x'.repeat(1201), 'not-a-real-workspace'), { status: 400, code: 'INVALID_SPEECH' });
  await assert.rejects(speech('   ', 'not-a-real-workspace'), { status: 400, code: 'INVALID_SPEECH' });
  await assert.rejects(transcribe(Buffer.alloc(0), 'audio/wav', 'not-a-real-workspace'), { status: 400, code: 'AUDIO_SIZE' });
});
