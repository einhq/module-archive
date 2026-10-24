import { assertAlmostEquals, assertEquals } from '@std/assert';
import { editFaceBox, faceBoxFromDrag, sameFaceBox } from '../face-draw.ts';

Deno.test('face drawing stores a drag as fractions of the rendered picture', () => {
  assertEquals(faceBoxFromDrag({ x: 80, y: 20 }, { x: 20, y: 70 }, { width: 200, height: 100 }), {
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.5,
  });
});

Deno.test('face drawing clamps a captured pointer when it leaves the picture', () => {
  assertEquals(faceBoxFromDrag({ x: 150, y: 60 }, { x: 240, y: -20 }, { width: 200, height: 100 }), {
    x: 0.75,
    y: 0,
    width: 0.25,
    height: 0.6,
  });
});

Deno.test('face drawing ignores clicks and tiny accidental drags', () => {
  assertEquals(faceBoxFromDrag({ x: 20, y: 20 }, { x: 20, y: 20 }, { width: 200, height: 100 }), null);
  assertEquals(faceBoxFromDrag({ x: 20, y: 20 }, { x: 31, y: 80 }, { width: 200, height: 100 }), null);
});

Deno.test('face box editing moves the whole box and clamps it to the picture', () => {
  assertEquals(
    editFaceBox({ x: 0.2, y: 0.3, width: 0.25, height: 0.2 }, { x: 50, y: 50 }, { x: -50, y: 100 }, { width: 200, height: 100 }, 'move'),
    { x: 0, y: 0.8, width: 0.25, height: 0.2 },
  );
});

Deno.test('face box editing resizes corners without crossing the minimum size', () => {
  const expanded = editFaceBox(
    { x: 0.2, y: 0.2, width: 0.4, height: 0.5 },
    { x: 40, y: 20 },
    { x: 10, y: 5 },
    { width: 200, height: 100 },
    'nw',
  );
  assertAlmostEquals(expanded.x, 0.05);
  assertAlmostEquals(expanded.y, 0.05);
  assertAlmostEquals(expanded.width, 0.55);
  assertAlmostEquals(expanded.height, 0.65);
  assertEquals(
    editFaceBox({ x: 0.2, y: 0.2, width: 0.4, height: 0.5 }, { x: 120, y: 70 }, { x: 45, y: 25 }, { width: 200, height: 100 }, 'se'),
    { x: 0.2, y: 0.2, width: 0.06, height: 0.12 },
  );
});

Deno.test('a box moved by nothing is the same box', () => {
  const box = { x: 0.2, y: 0.3, width: 0.25, height: 0.2 };
  assertEquals(sameFaceBox(box, editFaceBox(box, { x: 50, y: 50 }, { x: 50, y: 50 }, { width: 200, height: 100 }, 'move')), true);
  assertEquals(sameFaceBox(box, editFaceBox(box, { x: 50, y: 50 }, { x: 51, y: 50 }, { width: 200, height: 100 }, 'move')), false);
});
