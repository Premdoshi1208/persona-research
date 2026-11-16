import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.PERSONA_TEST_IMPORT = '1';
const { mergeWav } = await import('../server/index.js');

function chunks(wav: Buffer) {
  const result: Record<string, Buffer> = {};
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.subarray(offset, offset + 4).toString();
    const size = wav.readUInt32LE(offset + 4);
    result[kind] = wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  return result;
}

test('actual generated Groq WAV segments merge into one valid PCM stream without losing samples', async () => {
  const sources = await Promise.all(['participant.wav', 'participant-two.wav'].map(name => readFile(new URL(`./fixtures/${name}`, import.meta.url))));
  const sourceChunks = sources.map(chunks);
  const merged = mergeWav(sources);
  const result = chunks(merged);
  assert.equal(merged.subarray(0, 4).toString(), 'RIFF');
  assert.equal(merged.subarray(8, 12).toString(), 'WAVE');
  assert.equal(merged.readUInt32LE(4), merged.length - 8);
  assert.equal(result['fmt '].readUInt16LE(0), 1); // PCM, not a compressed stream
  assert.equal(result['fmt '].readUInt16LE(2), 1); // mono
  assert.equal(result['fmt '].readUInt32LE(4), 24000);
  assert.equal(result['fmt '].readUInt16LE(14), 16);
  assert.deepEqual(result.data, Buffer.concat(sourceChunks.map(c => c.data)));
  assert(result.data.length / (24000 * 2) > 20);
});

test('malformed segmented provider audio fails with a safe playback error', () => {
  assert.throws(() => mergeWav([Buffer.from('not wave'), Buffer.from('not wave')]), { status: 503 });
  assert.throws(() => mergeWav([]), { status: 503 });
});
