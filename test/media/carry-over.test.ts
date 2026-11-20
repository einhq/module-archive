/**
 * `carryOver`: where what a person decided about the voices goes when a recording is diarized
 * again, and that none of it is lost.
 */

import { assertEquals } from '@std/assert';
import { carryOver, type HeldAssignment, type Span } from '@archive/media/speakers';

const held = (personId: string | null, turns: Span[], assignLocked = false): HeldAssignment => ({
  turns,
  detectedBy: 'old',
  detectedAt: '2026-01-01T00:00:00Z',
  capacity: 4,
  personId,
  personSource: personId ? 'manual' : null,
  personConfidence: 1,
  personAssignedAt: null,
  assignLocked,
});
const voice = (id: string, turns: Span[]) => ({ id, turns, talkSeconds: 0, vector: [0, 0, 0, 0] });

Deno.test('carryOver: each held voice goes to the new voice it shares the most speech with', () => {
  const anna = held('p-anna', [[0, 10]]);
  const edvin = held('p-edvin', [[10, 14]]);
  const { onto, kept } = carryOver([anna, edvin], [voice('speaker_0', [[10, 14]]), voice('speaker_1', [[0, 10]])]);
  assertEquals([onto.get('speaker_0'), onto.get('speaker_1'), kept], [edvin, anna, []]);
});

Deno.test('carryOver: two people heard as one voice, the other goes to the next voice it shares speech with', () => {
  const anna = held('p-anna', [[0, 10]]);
  const edvin = held('p-edvin', [[10, 14], [20, 21]]);
  const { onto, kept } = carryOver([edvin, anna], [voice('speaker_0', [[0, 14]]), voice('speaker_1', [[20, 21]])]);
  assertEquals([onto.get('speaker_0'), onto.get('speaker_1'), kept], [anna, edvin, []]);
});

Deno.test('carryOver: two voices of one person heard as one are carried by it', () => {
  const first = held('p-anna', [[0, 10]]);
  const second = held('p-anna', [[10, 12]]);
  const { onto, kept } = carryOver([first, second], [voice('speaker_0', [[0, 12]]), voice('speaker_1', [[11, 11.5]])]);
  assertEquals([onto.get('speaker_0'), onto.has('speaker_1'), kept], [first, false, []]);
});

Deno.test('carryOver: a held voice no new voice is free to take is kept', () => {
  const anna = held('p-anna', [[0, 10]]);
  const edvin = held('p-edvin', [[10, 12]]);
  const nobody = held(null, [[30, 31]], true);
  const { onto, kept } = carryOver([anna, edvin, nobody], [voice('speaker_0', [[0, 12]])]);
  assertEquals([onto.get('speaker_0'), kept], [anna, [edvin, nobody]]);
  // Nobody heard at all: everything is kept.
  assertEquals(carryOver([anna], []).kept, [anna]);
});
