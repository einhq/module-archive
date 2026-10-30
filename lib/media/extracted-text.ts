/**
 * A file's extracted text: `<file>/metadata/content`, a text/plain node holding what a document says
 * or what is written in a picture, with its vector beside it (`storeCurrentContent`). The same shape
 * as a transcript's, so search resolves both the same way. Deliberately not the file's
 * `description` attr: that is the human one the lightbox renders, and a reader has no business
 * overwriting it.
 *
 * `index-document` writes it for documents, `read-text` for pictures; both mark the file with
 * `textIndexedAt` whether there was text or not, since a file with no text has no node to probe for.
 */

import type { Command } from '@ein/client';
import { shq } from '@ein/client';
import { storeCurrentContent, type StoreOptions } from '@ems/text-embedding';

/** The extracted text's node under a file. */
const contentPath = (file: string): string => `${file}/metadata/content`;

/**
 * Keep `text` as `file`'s extracted text with `attrs` on its node, and embed it. Answers why the
 * vector could not be stored, or undefined: the text is kept either way, and `media-reembed`
 * embeds it later.
 */
export const storeExtractedText = async (
  cmd: Command,
  file: string,
  text: string,
  attrs: Record<string, unknown>,
  vectorAttrs: Record<string, unknown> = {},
  opts: StoreOptions = {},
): Promise<string | undefined> => {
  const path = contentPath(file);
  await cmd.execute(`mkdir -p ${shq(`${file}/metadata`)}`);
  if (!await cmd.sys.vfs.exists(cmd.access, path)) {
    const made = await cmd.execute(`mknode -t file ${shq(path)} --as "mimetype=text/plain" --tier db`);
    if (made.code !== 0) throw new Error(`cannot create ${path}: ${made.stderr.trim()}`);
  }
  // Through the VFS rather than a shell, so the text's spaces and newlines arrive as they are.
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode(text));
  } finally {
    await handle.close();
  }
  if (Object.keys(attrs).length > 0) await cmd.sys.vfs.update(cmd.access, path, { attrs });
  return await storeCurrentContent(cmd, path, text, vectorAttrs, opts);
};

/** Remove `file`'s extracted text and its vectors, for a file read again that holds no text now. */
export const clearExtractedText = async (cmd: Command, file: string): Promise<void> => {
  const path = contentPath(file);
  if (await cmd.sys.vfs.exists(cmd.access, path)) await cmd.sys.vfs.unlink(cmd.access, path, `${file}/metadata`, { recursive: true });
};
