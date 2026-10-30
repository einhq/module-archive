import { assertEquals } from '@std/assert';
import {
  addCueAt,
  cueProblem,
  cuesToVtt,
  draftFrom,
  endCueAt,
  formatCueTime,
  joinWithNext,
  parseCueTime,
  removeCue,
  splitCue,
  startCueAt,
  updateCue,
} from '../subtitle-edit.ts';
import { parseVtt } from '../vtt.ts';

const lines = () =>
  draftFrom([
    { start: 1, end: 3, text: 'We took the boat out' },
    { start: 4, end: 6, text: 'to the island' },
  ]);

Deno.test('a time is shown to the tenth and read back in every way it may be typed', () => {
  assertEquals([formatCueTime(0), formatCueTime(83.25), formatCueTime(3723.04)], ['0:00.0', '1:23.3', '1:02:03.0']);
  assertEquals(['83', '83.25', '1:23,5', '01:02:03.040', '0:05'].map(parseCueTime), [83, 83.25, 83.5, 3723.04, 5]);
  assertEquals(['', '1:75', 'a', '1:2:3:4', '-1', '1.2.3'].map(parseCueTime), [null, null, null, null, null, null]);
});

Deno.test('a retimed line moves to where it now starts', () => {
  const [first, second] = lines();
  assertEquals(updateCue(lines(), first.id, { start: 5 }).map((cue) => cue.id), [second.id, first.id]);
  assertEquals(removeCue(lines(), first.id).map((cue) => cue.text), ['to the island']);
});

Deno.test('a line started or ended at the playhead keeps its length when that edge would cross the other', () => {
  const [first] = lines();
  const times = (cues: ReturnType<typeof lines>) => cues.filter((cue) => cue.id === first.id).map((cue) => [cue.start, cue.end])[0];
  assertEquals(times(startCueAt(lines(), first.id, 2)), [2, 3]);
  assertEquals(times(startCueAt(lines(), first.id, 10)), [10, 12]);
  assertEquals(times(endCueAt(lines(), first.id, 2.5)), [1, 2.5]);
  assertEquals(times(endCueAt(lines(), first.id, 0.5)), [0, 0.5]);
});

Deno.test('a line added at the playhead runs two seconds, up to the next line, or ends at the end', () => {
  const added = addCueAt(lines(), 3.5, 60);
  assertEquals(added.cues.map((cue) => [cue.start, cue.end, cue.text]), [[1, 3, 'We took the boat out'], [3.5, 4, ''], [4, 6, 'to the island']]);
  assertEquals(added.cues[1].id, added.id);
  assertEquals(addCueAt(lines(), 10, 60).cues.at(-1)!.end, 12);
  const atEnd = addCueAt([], 60, 60).cues[0];
  assertEquals([atEnd.start, atEnd.end], [58, 60]);
});

Deno.test('a split cuts the words at the caret and the time at the playhead inside the line, or in proportion', () => {
  const [first] = lines();
  const atPlayhead = splitCue(lines(), first.id, 'We took'.length, 2)!;
  assertEquals(atPlayhead.cues.slice(0, 2).map((cue) => [cue.start, cue.end, cue.text]), [[1, 2, 'We took'], [2, 3, 'the boat out']]);
  assertEquals(atPlayhead.cues[1].id, atPlayhead.id);
  const proportional = splitCue(lines(), first.id, 10, 30)!;
  assertEquals(proportional.cues[0].end, 2);
  assertEquals(splitCue(lines(), first.id, 0, 30), null);
});

Deno.test('a line joined with the next runs over both and says both', () => {
  const [first, second] = lines();
  assertEquals(joinWithNext(lines(), first.id)!.map((cue) => [cue.start, cue.end, cue.text]), [[1, 6, 'We took the boat out to the island']]);
  assertEquals(joinWithNext(lines(), second.id), null);
});

Deno.test('a backwards line blocks saving and an empty one is left out', () => {
  assertEquals(cueProblem({ start: 3, end: 3, text: 'x' })?.blocking, true);
  assertEquals(cueProblem({ start: 1, end: 3, text: '  ' })?.blocking, false);
  assertEquals(cueProblem({ start: 1, end: 3, text: 'x' }), null);
});

Deno.test('the written WebVTT reads back as the lines, markup typed into them kept as text', () => {
  const draft = [...lines(), { id: 9, start: 7, end: 8, text: 'a <b> & --> c\nd' }, { id: 10, start: 9, end: 10, text: ' ' }];
  assertEquals(parseVtt(cuesToVtt(draft)), [
    { start: 1, end: 3, text: 'We took the boat out' },
    { start: 4, end: 6, text: 'to the island' },
    { start: 7, end: 8, text: 'a <b> & --> c d' },
  ]);
  assertEquals(cuesToVtt([]), 'WEBVTT\n\n');
});
