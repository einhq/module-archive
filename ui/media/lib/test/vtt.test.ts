import { assertEquals } from '@std/assert';
import { cueAt, parseVtt } from '../vtt.ts';

Deno.test('cue markup is dropped and escaped text kept as said', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:03.500',
    '<v Anna Andersson>We took <00:00:02.100>the <i>boat</i> out</v>',
    '',
    '00:00:04.000 --> 00:00:05.000',
    'It said &lt;b&gt; on the sign &amp; nothing&nbsp;else',
  ].join('\n');
  assertEquals(parseVtt(vtt), [
    { start: 1, end: 3.5, text: 'We took the boat out' },
    { start: 4, end: 5, text: 'It said <b> on the sign & nothing else' },
  ]);
});

Deno.test('a cue is said from its start up to, not including, its end', () => {
  const cues = parseVtt([
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:02.000',
    'one',
    '',
    '00:00:05.000 --> 00:00:06.000',
    'two',
  ].join('\n'));
  assertEquals(cueAt(cues, 0.5), undefined);
  assertEquals(cueAt(cues, 1)?.text, 'one');
  assertEquals(cueAt(cues, 1.99)?.text, 'one');
  // The pause between them shows nothing on the picture.
  assertEquals(cueAt(cues, 2), undefined);
  assertEquals(cueAt(cues, 3.5), undefined);
  assertEquals(cueAt(cues, 5.5)?.text, 'two');
  assertEquals(cueAt(cues, 6), undefined);
  assertEquals(cueAt([], 1), undefined);
});
