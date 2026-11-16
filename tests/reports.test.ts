import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell } from '../server/reports.js';

test('CSV exports neutralize formula injection including leading whitespace and control characters', () => {
  for (const input of ['=HYPERLINK("https://evil.example")', '+cmd', '-2+3', '@SUM(A1:A2)', '  =1+1', '\uFEFF\t=1+1', '\u0000 =1+1', '\n=1+1', '\r@SUM(A1:A2)']) {
    assert(csvCell(input).startsWith('"\''), JSON.stringify(input));
  }
  assert.equal(csvCell('ordinary customer feedback'), '"ordinary customer feedback"');
  assert.equal(csvCell('  ordinary customer feedback'), '"  ordinary customer feedback"');
  assert.equal(csvCell('She said "hello", then left.'), '"She said ""hello"", then left."');
  assert.equal(csvCell(null), '""');
});
