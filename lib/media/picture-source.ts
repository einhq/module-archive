/**
 * What EMS reads a file's picture from, for its picture vectors (`vision.embed`) and its
 * fingerprints (`fingerprint.compute`): the bytes it is handed, and the turn it owes them.
 */

import type { Command, NodeAttrs } from '@ein/client';
import { normalizeAngle, normalizeMirror } from '@archive/media/orientation';

/** The rendition a photo is embedded from (see `config/sizes.yaml`). */
const EMBED_RENDITION = '800x800.avif';

type PictureSource = {
  path: string;
  opts: { angle: number; mirror: boolean; mimetype: string };
  /** Embedded from the rendition rather than the file itself. */
  rendition: boolean;
};

/**
 * A photo is embedded from its 800px rendition when it has one: the model sees 384 px, the
 * retrieval eval measured exactly this input, and decoding it is ~10x cheaper than a 20-50 Mpx
 * original. A rendition is stored in the display frame already, so it goes with no rotation. A
 * new import may not have one yet, a source smaller than the box never gets one, and a picture
 * put in /tmp only to be searched with has none; those use the file itself with the node's
 * `angle` and `mirror`. A video's keyframes come from the video itself.
 */
export const pictureSource = async (cmd: Command, path: string, attrs: NodeAttrs): Promise<PictureSource> => {
  const mimetype = typeof attrs.mimetype === 'string' ? attrs.mimetype : '';
  const rendition = `${path}/thumbnails/${EMBED_RENDITION}`;
  const fromRendition = mimetype.startsWith('image/') && await cmd.sys.vfs.exists(cmd.access, rendition).catch(() => false);
  return fromRendition
    ? { path: rendition, opts: { angle: 0, mirror: false, mimetype: 'image/avif' }, rendition: true }
    : { path, opts: { angle: normalizeAngle(attrs.angle), mirror: normalizeMirror(attrs.mirror), mimetype }, rendition: false };
};
