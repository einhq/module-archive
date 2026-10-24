import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { mediaTerminalCommand } from '../lightbox-presentation.ts';

Deno.test('mediaTerminalCommand targets the media node itself', () => {
  assertEquals(mediaTerminalCommand(`${ALBUMS_ROOT}/trip/photo.jpg`), `cd '${ALBUMS_ROOT}/trip/photo.jpg'`);
  assertEquals(mediaTerminalCommand(`${ALBUMS_ROOT}/Olof' trip/photo.jpg`), `cd '${ALBUMS_ROOT}/Olof'\\'' trip/photo.jpg'`);
});
