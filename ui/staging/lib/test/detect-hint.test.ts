import type { StagingCategoryKind, StagingCategoryStatus, StagingDetection } from '@archive/staging/api';
import { assertEquals } from '@std/assert';
import { detectHint, detectHints, newCategoryRoute } from '../detect-hint.ts';

const FILES = '/home/anna/staging/files';
const TAKEOUT = `${FILES}/inbox/upload-2026-10-18/Takeout`;

const category = (name: string, kind: StagingCategoryKind, label: string) => ({ name, kind, label }) as StagingCategoryStatus;
const categories = [category('inbox', 'inbox', 'Inbox'), category('export', 'google-photos', 'Family export')];

const detection = (over: Partial<StagingDetection>): StagingDetection => ({
  path: TAKEOUT,
  dismissed: false,
  kind: 'google-photos',
  confidence: 'high',
  evidence: ['a Takeout/Google Photos folder'],
  category: { name: 'export', label: 'Family export', path: `${FILES}/export` },
  seen: { files: 10, sampled: 10, folders: 3 },
  ...over,
});

Deno.test('a folder of the default category that looks like Google Photos is offered its category', () => {
  assertEquals(detectHint(detection({}), categories, 'inbox'), {
    path: TAKEOUT,
    name: 'Takeout',
    kind: 'google-photos',
    source: 'Google Photos',
    text: 'Looks like Google Photos',
    evidence: ['a Takeout/Google Photos folder'],
    action: { type: 'move', category: 'export', label: 'Move to Family export…' },
  });
});

Deno.test('with no category of the kind, the hint makes one and moves the folder there', () => {
  const hint = detectHint(detection({ category: null }), categories, 'inbox');
  assertEquals(hint?.action, { type: 'create', kind: 'google-photos', label: 'Make a Google Photos export category…', route: newCategoryRoute('google-photos', TAKEOUT) });
  assertEquals(newCategoryRoute('scans', `${FILES}/inbox/Box 3`), '/staging/categories/new?kind=scans&move=%2Fhome%2Fanna%2Fstaging%2Ffiles%2Finbox%2FBox%203');
  // A category the page no longer knows, or one since given another kind, is no way to go.
  assertEquals(detectHint(detection({ category: { name: 'gone', label: 'Gone', path: `${FILES}/gone` } }), categories, 'inbox')?.action.type, 'create');
  assertEquals(detectHint(detection({ kind: 'scans' }), categories, 'inbox')?.action.type, 'create');
});

Deno.test('no hint for an unsure detection, for no source, for a dismissed folder, or for a folder outside the default category', () => {
  assertEquals(detectHint(detection({ dismissed: true }), categories, 'inbox'), undefined);
  assertEquals(detectHint(detection({ confidence: 'low' }), categories, 'inbox'), undefined);
  assertEquals(detectHint(detection({ kind: 'generic', category: null }), categories, 'inbox'), undefined);
  assertEquals(detectHint(detection({ path: `${FILES}/export/Takeout` }), categories, 'inbox'), undefined);
  assertEquals(detectHint(detection({ path: '/home/anna/trees/Takeout' }), categories, 'inbox'), undefined);
  assertEquals(detectHint(detection({ confidence: 'medium' }), categories, 'inbox')?.text, 'Looks like Google Photos');
});

Deno.test('the hints of an answer keep its order and leave out the folders that give none', () => {
  const phone = detection({ path: `${FILES}/inbox/Phone dump`, kind: 'phone', category: null });
  const plain = detection({ path: `${FILES}/inbox/Summer`, kind: 'generic', category: null });
  assertEquals(detectHints([phone, plain, detection({})], categories, 'inbox').map((hint) => [hint.name, hint.text]), [
    ['Phone dump', "Looks like a phone's pictures"],
    ['Takeout', 'Looks like Google Photos'],
  ]);
});
