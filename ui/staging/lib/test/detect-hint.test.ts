import type { StagingDetection } from '@archive/staging/api';
import { assertEquals } from '@std/assert';
import { detectHint, detectHints, newCategoryRoute } from '../detect-hint.ts';

const FILES = '/home/anna/staging/files';
const TAKEOUT = `${FILES}/inbox/upload-2026-10-18/Takeout`;

const detection = (over: Partial<StagingDetection>): StagingDetection => ({
  path: TAKEOUT,
  dismissed: false,
  source: 'google-photos',
  confidence: 'high',
  evidence: ['a Takeout/Google Photos folder'],
  seen: { files: 10, sampled: 10, folders: 3 },
  ...over,
});

Deno.test('a folder of the default category that looks like Google Photos is offered a new category called after its source', () => {
  assertEquals(detectHint(detection({}), 'inbox'), {
    path: TAKEOUT,
    name: 'Takeout',
    source: 'Google Photos',
    text: 'Looks like Google Photos',
    evidence: ['a Takeout/Google Photos folder'],
    route: newCategoryRoute('Google Photos', TAKEOUT),
  });
  assertEquals(detectHint(detection({ source: 'scans' }), 'inbox')?.route, newCategoryRoute('Scans', TAKEOUT));
  assertEquals(newCategoryRoute('Scans', `${FILES}/inbox/Box 3`), '/staging/categories/new?move=%2Fhome%2Fanna%2Fstaging%2Ffiles%2Finbox%2FBox%203&label=Scans');
});

Deno.test('no hint for an unsure detection, for no source, for a dismissed folder, or for a folder outside the default category', () => {
  assertEquals(detectHint(detection({ dismissed: true }), 'inbox'), undefined);
  assertEquals(detectHint(detection({ confidence: 'low' }), 'inbox'), undefined);
  assertEquals(detectHint(detection({ source: 'generic' }), 'inbox'), undefined);
  assertEquals(detectHint(detection({ path: `${FILES}/export/Takeout` }), 'inbox'), undefined);
  assertEquals(detectHint(detection({ path: '/home/anna/trees/Takeout' }), 'inbox'), undefined);
  assertEquals(detectHint(detection({ confidence: 'medium' }), 'inbox')?.text, 'Looks like Google Photos');
});

Deno.test('the hints of an answer keep its order and leave out the folders that give none', () => {
  const phone = detection({ path: `${FILES}/inbox/Phone dump`, source: 'phone' });
  const plain = detection({ path: `${FILES}/inbox/Summer`, source: 'generic' });
  assertEquals(detectHints([phone, plain, detection({})], 'inbox').map((hint) => [hint.name, hint.text]), [
    ['Phone dump', "Looks like a phone's pictures"],
    ['Takeout', 'Looks like Google Photos'],
  ]);
});
