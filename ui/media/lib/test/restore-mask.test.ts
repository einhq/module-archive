import { assertEquals } from '@std/assert';
import { pointDisplayToRaw } from '@media/orientation';
import { type Affine, againFlags, crc32, displaySize, displayToStored, grayPng, invertAffine } from '../restore-mask.ts';

const apply = ([a, b, c, d, e, f]: Affine, [x, y]: [number, number]): [number, number] => [a * x + c * y + e, b * x + d * y + f];

Deno.test('a point in the display frame lands where the orientation module puts it in the stored one', () => {
  const [width, height] = [600, 400];
  for (const angle of [0, 90, 180, 270]) {
    for (const mirror of [false, true]) {
      const display = displaySize(width, height, angle);
      const toStored = displayToStored(width, height, angle, mirror);
      for (const point of [[0.1, 0.2], [0.75, 0.5], [0, 1]] as [number, number][]) {
        const [x, y] = apply(toStored, [point[0] * display.width, point[1] * display.height]);
        const [rx, ry] = pointDisplayToRaw(point, angle, mirror);
        assertEquals([Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000], [Math.round(rx * width * 1000) / 1000, Math.round(ry * height * 1000) / 1000]);
      }
    }
  }
});

Deno.test('the inverse turn takes a stored point back to where it was shown', () => {
  for (const angle of [0, 90, 180, 270]) {
    for (const mirror of [false, true]) {
      const toStored = displayToStored(600, 400, angle, mirror);
      const back = apply(invertAffine(toStored), apply(toStored, [123, 45]));
      assertEquals(back.map((n) => Math.round(n * 1000) / 1000), [123, 45]);
    }
  }
});

Deno.test('the mask is a one-channel PNG of the rows given, band by band', async () => {
  const [width, height] = [5, 3];
  const pixels = Uint8Array.from({ length: width * height }, (_, i) => (i % 2 ? 255 : 0));
  const png = new Uint8Array(await (await grayPng(width, height, (top, rows) => pixels.slice(top * width, (top + rows) * width), 2)).arrayBuffer());

  assertEquals([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer);
  const chunks: { type: string; data: Uint8Array }[] = [];
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    assertEquals(view.getUint32(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)));
    chunks.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  assertEquals(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  assertEquals([...chunks[0].data], [0, 0, 0, 5, 0, 0, 0, 3, 8, 0, 0, 0, 0]);

  const raw = new Uint8Array(await new Response(new Blob([chunks[1].data.slice()]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const rows = Array.from({ length: height }, (_, y) => raw.subarray(y * (width + 1), (y + 1) * (width + 1)));
  assertEquals(rows.map((row) => row[0]), [0, 0, 0]);
  assertEquals(rows.flatMap((row) => [...row.subarray(1)]), [...pixels]);
});

Deno.test('a copy is made again with its colours, fill and grain, and no dust finder', () => {
  assertEquals(
    againFlags([
      { op: 'image.unfade', params: {} },
      { op: 'image.defects', params: { dark: true } },
      { op: 'image.inpaint', params: { method: 'lama' } },
      { op: 'image.denoise', params: { strength: 0.4 } },
    ]),
    ['--unfade', '--fill', 'lama', '--grain', '0.4'],
  );
  assertEquals(againFlags([{ op: 'image.defects', params: {} }, { op: 'image.inpaint', params: { method: 'ns' } }]), []);
});
