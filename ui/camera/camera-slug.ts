/**
 * Display name -> path segment under `/cameras`, matching what the server
 * would choose: `Canon EOS 5D Mark III` is `Canon_EOS_5D_Mark_III`.
 *
 * The UI needs the answer up front, to propose a path to `camera-create` and to
 * know where to navigate afterwards, so it mirrors the server's
 * `slugifyCameraName`; if the two ever diverge, the server is the authority.
 * Unlike a person slug this preserves case and does not transliterate, which is
 * what the cameras already in the archive are called.
 */

/** Mirrors the server's `UNSAFE_SEGMENT_CHARS`. */
const UNSAFE = new Set([...'/\\\'"`$*?<>|:;&()[]{}!#%^~,']);

export function cameraSlug(name: string): string {
  let out = '';
  for (const character of name.normalize('NFC')) {
    if (UNSAFE.has(character)) continue;
    if (character.codePointAt(0)! < 0x20) continue;
    out += character;
  }
  return out
    .trim()
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
}
