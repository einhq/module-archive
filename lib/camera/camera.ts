/**
 * Camera registry helpers — the shared half of the `camera-*` bins.
 *
 * A camera is a `camera` node under `/cameras` carrying a display name and,
 * where the camera writes one, a serial number. Matching a file to one of them
 * is the whole point of the registry, and the rule is deliberately two-tier:
 * a **serial** identifies one physical body, while **make + model** identifies
 * a model line and can only ever be a guess — two people with the same phone
 * produce the same fingerprint.
 *
 * The matcher, the bulk re-linker and the scan that proposes cameras the
 * archive has seen but nobody has registered all use it.
 *
 * Imported by the #!ts bins via the `@archive/camera/camera` alias — a bin is
 * copied to /tmp before it runs and cannot use relative imports, only the
 * import map.
 */

import { CAMERAS_ROOT } from '@archive/paths';
import type { Command, NodeChildEntry } from '@ein/client';
import type { NodeOwnership } from '@ein/api';
import { nodeOwnership, shq } from '@ein/client';
import type { CameraAttrs } from '@archive/camera/types';
import { isTravelKind, type TravelKind } from '@archive/location/track-profile';

export { CAMERAS_ROOT };
export const NODE_TYPE_CAMERA = 'camera';
export const OWNERS_DIR = 'owners';

/** A registered camera, as every camera command wants to see it. */
export type CameraEntry = {
  /** Node name under `/cameras` — the id the UI routes on. */
  id: string;
  path: string;
  name: string;
  make?: string;
  model?: string;
  serialNumber?: string;
  timezone?: string;
  kind?: TravelKind;
  digitizer?: boolean;
  quicktimeUtc?: boolean;
  description?: string;
  /** Who may change the camera. */
  ownership: NodeOwnership;
};

/** What a file's exif says produced it. The input to every match. */
export type CameraFingerprint = {
  serialNumber?: string;
  make?: string;
  model?: string;
};

type MatchType = 'serial' | 'make-model';

type CameraMatch = {
  path: string;
  matchType: MatchType;
  timezone?: string;
  digitizer?: boolean;
};

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const bool = (value: unknown): boolean | undefined => value === true ? true : undefined;

/**
 * Every registered camera, from one listing.
 *
 * `ls -l` returns each child's type and attrs, where plain `ls` answers with
 * names only.
 */
export const listCameras = async (cmd: Command, root: string = CAMERAS_ROOT): Promise<CameraEntry[]> => {
  const result = await cmd.execute(`JSON_OUTPUT=1 ls -l ${shq(root)}`);
  if (result.code !== 0) {
    throw new Error(`${root}: ${result.stderr.trim() || 'cannot list'}`);
  }

  const entries = JSON.parse(result.stdout) as NodeChildEntry[];

  return entries
    .filter((entry) => entry.node.type === NODE_TYPE_CAMERA)
    .map((entry): CameraEntry => {
      const attrs = entry.node.attrs as CameraAttrs;
      return {
        id: entry.name,
        path: `${root}/${entry.name}`,
        name: str(attrs.name) ?? entry.name,
        make: str(attrs.make),
        model: str(attrs.model),
        serialNumber: str(attrs.serialNumber),
        timezone: str(attrs.timezone),
        kind: isTravelKind(attrs.kind) ? attrs.kind : undefined,
        digitizer: bool(attrs.digitizer),
        quicktimeUtc: bool(attrs.quicktimeUtc),
        description: str((attrs as Record<string, unknown>).description),
        ownership: nodeOwnership(entry.node),
      };
    });
};

/** Whether `timezone` is an IANA time zone this runtime knows, such as `Europe/Stockholm`. */
export const isKnownTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

/**
 * Which registered camera produced a file with this fingerprint, if any.
 *
 * Serial wins outright; make + model is the fallback and only when nothing
 * matched by serial, because the same model line covers many bodies. A
 * fingerprint carrying a serial that matches *no* camera deliberately still
 * falls through to make + model: an unregistered serial does not make the
 * camera model wrong, and the alternative is leaving those files unlinked.
 */
export const matchCamera = (
  cameras: Pick<CameraEntry, 'path' | 'serialNumber' | 'make' | 'model' | 'timezone' | 'digitizer'>[],
  fingerprint: CameraFingerprint,
): CameraMatch | null => {
  const { serialNumber, make, model } = fingerprint;

  if (serialNumber) {
    for (const camera of cameras) {
      if (camera.serialNumber === serialNumber) {
        return {
          path: camera.path,
          matchType: 'serial',
          ...(camera.timezone ? { timezone: camera.timezone } : {}),
          ...(camera.digitizer ? { digitizer: true } : {}),
        };
      }
    }
  }

  if (make && model) {
    for (const camera of cameras) {
      if (camera.make === make && camera.model === model) {
        return {
          path: camera.path,
          matchType: 'make-model',
          ...(camera.timezone ? { timezone: camera.timezone } : {}),
          ...(camera.digitizer ? { digitizer: true } : {}),
        };
      }
    }
  }

  return null;
};

/**
 * Characters a `/cameras` path segment must not carry: the separator itself,
 * and everything that would need shell quoting each time the path is
 * interpolated into a command. Spelled out rather than given as a range, so
 * nothing depends on where these sit in the code-point table.
 */
const UNSAFE_SEGMENT_CHARS = new Set([...'/\\\'"`$*?<>|:;&()[]{}!#%^~,']);

/**
 * Display name → path segment under `/cameras`.
 *
 * The names every camera in an existing archive already has:
 * `Canon EOS 5D Mark III` → `Canon_EOS_5D_Mark_III`. Case is preserved and
 * hyphens survive (`DMC-TZ60`, `PENTAX_K-3_II`) — unlike `slugifyName`, which
 * lowercases and would leave `/cameras` holding two naming conventions.
 */
export const slugifyCameraName = (name: string): string => {
  let out = '';
  for (const character of name.normalize('NFC')) {
    if (UNSAFE_SEGMENT_CHARS.has(character)) continue;
    // Control characters have no business in a node name and no visible
    // replacement; dropping them is the only sane answer.
    if (character.codePointAt(0)! < 0x20) continue;
    out += character;
  }
  return out
    .trim()
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
};

/** Read one camera's attrs. Throws with the command's own error text. */
export const readCamera = async (cmd: Command, path: string): Promise<CameraAttrs> => {
  const result = await cmd.execute(`JSON_OUTPUT=1 attrs ${shq(path)}`);
  if (result.code !== 0) {
    throw new Error(`${path}: ${result.stderr.trim() || 'not found'}`);
  }
  return JSON.parse(result.stdout) as CameraAttrs;
};
