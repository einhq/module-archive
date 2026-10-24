import { assertEquals } from '@std/assert';
import { tileIndex } from '@ein/ui/lib';
import { type StreamGeometry, streamHits } from '../lasso-hits.ts';

/** A stream at page y 200, 1,000 px wide, closed sections 300 px tall (a 64 px header over a 211 px strip). */
const geometry = (open?: StreamGeometry['open']): StreamGeometry => ({ left: 0, right: 1000, top: 200, inset: 16, header: 64, strip: 211, open });

Deno.test('closed sections are taken by their header or half their strip', () => {
  const crossed = [
    { key: 'a', top: 0, height: 300, open: false },
    { key: 'b', top: 300, height: 300, open: false },
    { key: 'c', top: 600, height: 300, open: false },
  ];
  // From inside a's strip, through b's header and strip, to the top of c's strip.
  const band = { left: 100, top: 200 + 250, right: 900, bottom: 200 + 600 + 70 };
  const hits = streamHits(band, crossed, geometry());
  assertEquals([...hits.sections], ['b', 'c']);
  // The band within the padding at the side takes nothing.
  assertEquals(streamHits({ left: 0, top: 200, right: 10, bottom: 1100 }, crossed, geometry()).sections.size, 0);
});

Deno.test("in the open group, the band takes the pictures it touches, from the grids' boxes", () => {
  // Rows of 4 pictures, 100 px square, 3 px apart, the grids starting 64 px into the open section.
  const boxes = Array.from({ length: 5000 }, (_, at) => ({ left: (at % 4) * 103, top: Math.floor(at / 4) * 103, width: 100, height: 100 }));
  const paths = boxes.map((_, at) => `/s/${at}.jpg`);
  const open = { key: 'o', left: 16, top: 200 + 300 + 64, index: tileIndex(boxes), paths };
  const crossed = [{ key: 'a', top: 0, height: 300, open: false }, { key: 'o', top: 300, height: 128_939, open: true }];
  const band = { left: 16 + 110, top: 200 + 300 + 64 + 10, right: 16 + 210, bottom: 200 + 300 + 64 + 110 };
  const hits = streamHits(band, crossed, geometry(open));
  assertEquals(hits.sections.size, 0);
  assertEquals([...hits.items], [['/s/1.jpg', 'o'], ['/s/2.jpg', 'o'], ['/s/5.jpg', 'o'], ['/s/6.jpg', 'o']]);
});
