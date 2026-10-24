/**
 * Fingerprints for finding copies, from EMS.
 *
 * An SSCD descriptor for a picture and for each of a video's keyframes, a chromaprint for sound;
 * the model and the tools live in the media service. A descriptor comes back as `type`,
 * `dimension`, `vector`, `label`, what its embedding node carries; a chromaprint as `type`,
 * `fingerprint` (the recording's values) and `label`.
 *
 * A picture is described from what its picture vector is embedded from (`pictureSource`): the
 * display-frame rendition when it has one, else the file turned as the node says. Either way the
 * descriptor is of the picture as it is shown, so a copy saved rotated still matches.
 *
 * An audio too short to fingerprint comes back as no entries rather than an error; a file EMS
 * cannot decode is an `EmsError` with `permanent: true`, which the pipeline should not retry.
 */

import type { Command, NodeAttrs } from '@ein/client';
import { fingerprint, type FingerprintResult } from '@ems/client';
import { pictureSource } from '@archive/media/picture-source';

export type { FingerprintResult };

export async function computeFingerprints(cmd: Command, path: string, attrs: NodeAttrs): Promise<FingerprintResult> {
  const source = await pictureSource(cmd, path, attrs);
  return await fingerprint(cmd, source.path, source.opts);
}
