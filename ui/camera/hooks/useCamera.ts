import { PEOPLE_ROOT } from '@archive/paths';
import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import type { StatNode } from '@ein/ui/hooks';
import type { LogReadEntries } from '@ein/api';
import { NodeChildEntry, NodeOwnership, shq } from '@ein/ui/lib';
import { CAMERAS_ROOT } from './useCameras.ts';
import type { RelinkResult } from '@archive/camera/api';
import { formatClockOffset } from '@archive/camera/clock-offset';

/** The settings a camera carries, and the only fields the form writes. */
export type CameraFields = {
  name: string;
  make: string;
  model: string;
  serial: string;
  timezone: string;
  description: string;
  digitizer: boolean;
  quicktimeUtc: boolean;
  /** For a camera linking a device with a stream: what opens a clip of it, and how many days clips are kept; empty for the default. */
  clips: string;
  clipDays: string;
  /**
   * How far its clock ran ahead (`+23h 2m`), and from which date (`YYYY-MM-DD`, empty for all its
   * pictures): the latest of its `configuration` log's clock offsets, empty when it has none.
   * Saving a change adds a setting rather than replacing this one.
   */
  clockOffset: string;
  clockFrom: string;
};

export type CameraDetail = CameraFields & {
  id: string;
  path: string;
  ownership: NodeOwnership;
  /** The path of the device it is part of (its child softlink `device`), when it links one, and its label. */
  device?: string;
  deviceName?: string;
  /** Whether that device has a stream, whose clips the camera's `clips` and `clipDays` are about. */
  streams?: boolean;
};

export type CameraOwner = {
  /** Person slug — the owner link's name, and the person's node name. */
  id: string;
  name: string;
  path: string;
  from?: string;
  to?: string;
};

type UseCameraResult = {
  camera: CameraDetail | null;
  owners: CameraOwner[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  /** Write the changed fields. An empty string clears the attr. */
  save: (fields: CameraFields) => Promise<RelinkResult | null>;
  /** Add an owner, or with `update` rewrite an existing owner's dates (an omitted one is cleared). */
  addOwner: (personPath: string, span: { from?: string; to?: string }, update?: boolean) => Promise<void>;
  removeOwner: (personId: string) => Promise<void>;
  /** Link media this camera produced but was registered too late to claim. */
  relink: () => Promise<RelinkResult>;
  /** Link the camera to the device at `device` (`camera-device`), or with null take the link away. */
  setDevice: (device: string | null) => Promise<void>;
};

type OwnerLinkAttrs = { relation?: { from?: string; to?: string } };

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const EMPTY: CameraFields = {
  name: '',
  make: '',
  model: '',
  serial: '',
  timezone: '',
  description: '',
  digitizer: false,
  quicktimeUtc: false,
  clips: '',
  clipDays: '',
  clockOffset: '',
  clockFrom: '',
};

/** The latest clock offset in a camera's `configuration` log, as the form shows it. */
const latestClockOffset = (log: LogReadEntries): Pick<CameraFields, 'clockOffset' | 'clockFrom'> => {
  let latest: { at: string; seconds: number } | undefined;
  for (const entry of log.entries) {
    const seconds = (entry.data as { clockOffset?: unknown } | null)?.clockOffset;
    if (typeof seconds === 'number' && (!latest || entry.at >= latest.at)) latest = { at: entry.at, seconds };
  }
  if (!latest) return { clockOffset: '', clockFrom: '' };
  return { clockOffset: formatClockOffset(latest.seconds), clockFrom: Date.parse(latest.at) > 0 ? latest.at.slice(0, 10) : '' };
};

/** Flag name for each field, as `camera-update` spells it. */
type TextCameraField = Exclude<keyof CameraFields, 'digitizer' | 'quicktimeUtc' | 'clockOffset' | 'clockFrom'>;
const FLAGS: Record<TextCameraField, string> = {
  name: 'name',
  make: 'make',
  model: 'model',
  serial: 'serial',
  timezone: 'timezone',
  description: 'description',
  clips: 'clips',
  clipDays: 'clip-days',
};

/**
 * One camera: its settings, who owns it, and the writes the page can make.
 *
 * The parent listing carries attrs and mode, so the camera itself costs no
 * extra call. Written through the `camera-*` commands
 * rather than through `attrs`, so the rules about what a camera may hold (a
 * real IANA timezone, `serialNumber` rather than `serial`) live on the server
 * where every caller gets them.
 */
export function useCamera(id: string | undefined): UseCameraResult {
  const [camera, setCamera] = useState<CameraDetail | null>(null);
  const [owners, setOwners] = useState<CameraOwner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const path = id ? `${CAMERAS_ROOT}/${id}` : null;

  const fetchCamera = useCallback(async () => {
    if (!id || !path) return;

    try {
      setLoading(true);
      setError(null);

      const siblings = await execCommand<NodeChildEntry[]>(`ls -l ${CAMERAS_ROOT}`);
      const entry = siblings.find((sibling) => sibling.name === id && sibling.node.type === 'camera');

      if (!entry) {
        setCamera(null);
        setOwners([]);
        return;
      }

      const attrs = entry.node.attrs as Record<string, unknown>;
      // A camera that is part of no device has no `device` link, which is not an error.
      const device = await execCommand<{ softlink?: string }>(`props -L ${shq(`${path}/device`)}`).then((props) => props.softlink, () => undefined);
      const deviceName = device && await execCommand<StatNode>(`stat ${shq(device)}`).then((node) => str(node.attrs.label) || undefined, () => undefined);
      const streams = device &&
        await execCommand<NodeChildEntry[]>(`ls -l ${shq(device)}`).then((endpoints) => endpoints.some((each) => each.node.type === 'stream'), () => false);
      // A camera whose clock nothing was ever said about has no `configuration` log.
      const clock = await execCommand<LogReadEntries>(`log-read ${shq(`${path}/configuration`)}`).then(latestClockOffset, () => latestClockOffset({ entries: [] }));
      setCamera({
        id,
        path,
        name: str(attrs.name) || id,
        make: str(attrs.make),
        model: str(attrs.model),
        serial: str(attrs.serialNumber),
        timezone: str(attrs.timezone),
        description: str(attrs.description),
        digitizer: attrs.digitizer === true,
        quicktimeUtc: attrs.quicktimeUtc === true,
        clips: str(attrs.clips),
        clipDays: typeof attrs.clipDays === 'number' ? String(attrs.clipDays) : '',
        ...clock,
        ownership: { mode: entry.node.props.mode, uid: entry.node.props.uid, gid: entry.node.props.gid },
        ...(device ? { device } : {}),
        ...(deviceName ? { deviceName } : {}),
        ...(streams ? { streams } : {}),
      });

      // The camera itself is enough to draw the page, so stop blocking here. What
      // follows resolves owner slugs against `ls -l /people`, a listing of the
      // whole archive's people, and there is no reason for the settings, the
      // header and the media list to wait on a two-line sidebar card.
      setLoading(false);

      // A camera registered by hand may have no owners directory yet, which is
      // "nobody owns it", not an error.
      let links: NodeChildEntry[] = [];
      let people: NodeChildEntry[] = [];
      try {
        [links, people] = await Promise.all([
          execCommand<NodeChildEntry[]>(`ls -l ${shq(`${path}/owners`)}`),
          execCommand<NodeChildEntry[]>(`ls -l ${PEOPLE_ROOT}`),
        ]);
      } catch {
        links = [];
      }

      const names = new Map(people.map((person) => [person.name, str(person.node.attrs.name) || person.name]));

      setOwners(
        links
          .filter((link) => link.node.type === 'softlink')
          .map((link): CameraOwner => {
            const relation = (link.node.attrs as OwnerLinkAttrs).relation;
            return {
              id: link.name,
              name: names.get(link.name) ?? link.name,
              path: link.node.props.softlink ?? `/people/${link.name}`,
              from: relation?.from,
              to: relation?.to,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setCamera(null);
      setOwners([]);
    } finally {
      setLoading(false);
    }
  }, [id, path]);

  useEffect(() => {
    fetchCamera();
  }, [fetchCamera]);

  const save = useCallback(async (fields: CameraFields): Promise<RelinkResult | null> => {
    if (!path) return null;
    const current = camera ?? EMPTY;

    // Only what actually changed, and an emptied field is a *clear* rather than
    // an empty string: `attrs -s serialNumber=` would leave the camera carrying
    // a serial that matches nothing, and `camera-match` compares by equality.
    const parts: string[] = [];
    for (const key of Object.keys(FLAGS) as TextCameraField[]) {
      const next = fields[key].trim();
      if (next === (current[key] ?? '').trim()) continue;
      parts.push(next === '' ? `--clear ${FLAGS[key]}` : `--${FLAGS[key]} ${shq(next)}`);
    }

    if (fields.digitizer !== current.digitizer) {
      parts.push(fields.digitizer ? '--digitizer' : '--clear digitizer');
    }
    if (fields.quicktimeUtc !== current.quicktimeUtc) {
      parts.push(fields.quicktimeUtc ? '--quicktime-utc' : '--clear quicktime-utc');
    }
    // A clock offset is a setting from a date, added to the ones before it; emptied, the clock was
    // right from that date. Joined with `=`, since the offset may be negative.
    const clockOffset = fields.clockOffset.trim();
    const clockFrom = fields.clockFrom.trim();
    if (clockOffset !== current.clockOffset || clockFrom !== current.clockFrom) {
      parts.push(`--clock-offset=${shq(clockOffset || '0')}`);
      if (clockFrom) parts.push(`--clock-from=${shq(clockFrom)}`);
    }

    let relink: RelinkResult | null = null;
    if (parts.length > 0) {
      const result = await execCommand<{ relink?: RelinkResult }>(`camera-update ${shq(path)} ${parts.join(' ')}`);
      relink = result.relink ?? null;
    }
    await fetchCamera();
    return relink;
  }, [path, camera, fetchCamera]);

  const addOwner = useCallback(async (personPath: string, span: { from?: string; to?: string }, update = false) => {
    if (!path) return;
    const dates = [
      span.from ? `--from ${shq(span.from)}` : '',
      span.to ? `--to ${shq(span.to)}` : '',
      update ? '--update' : '',
    ].filter(Boolean).join(' ');
    await execCommand(`camera-set-owner ${shq(path)} ${shq(personPath)} ${dates}`.trim());
    await fetchCamera();
  }, [path, fetchCamera]);

  const removeOwner = useCallback(async (personId: string) => {
    if (!path) return;
    await execCommand(`camera-remove-owner ${shq(path)} ${shq(personId)}`);
    await fetchCamera();
  }, [path, fetchCamera]);

  const relink = useCallback(async (): Promise<RelinkResult> => {
    if (!path) return { camera: '', scanned: 0, linked: 0, retimed: 0, skipped: 0 };
    return await execCommand<RelinkResult>(`camera-relink ${shq(path)}`);
  }, [path]);

  const setDevice = useCallback(async (device: string | null) => {
    if (!path) return;
    await execCommand(`camera-device ${shq(path)} ${device ? shq(device) : '--off'}`);
    await fetchCamera();
  }, [path, fetchCamera]);

  return { camera, owners, loading, error, refetch: fetchCamera, save, addOwner, removeOwner, relink, setDevice };
}
