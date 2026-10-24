/**
 * Where a file's fingerprints live and when its fingerprinting is done.
 *
 * Under `<file>/metadata/`: `sscd-image` for a picture, `sscd-video-keyframe-<n>` for each of a
 * video's keyframes (embedding nodes holding SSCD descriptors), and `chromaprint` for a recording
 * (a db-tier file of its values).
 */

/** The fingerprint type a file of each kind gets, which is also its embedding type. */
export const FINGERPRINT_TYPES = { image: 'sscd-image', video: 'sscd-video', audio: 'chromaprint' } as const;

/** Whether `name` under a file's `metadata/` is one of its fingerprints. */
export const isFingerprintName = (name: string): boolean => name === FINGERPRINT_TYPES.audio || name.startsWith('sscd-');

/**
 * Whether a file needs no more fingerprinting. A picture or a video always gets a print; a
 * recording too short for a chromaprint gets none and never will, which the `fingerprintedAt`
 * that `compute-fingerprint` writes on every finished run records.
 */
export const fingerprintDone = (mimetype: string, fingerprintedAt: unknown, metadataNames: readonly string[]): boolean =>
  metadataNames.some(isFingerprintName) || (typeof fingerprintedAt === 'string' && !/^(image|video)\//.test(mimetype));
