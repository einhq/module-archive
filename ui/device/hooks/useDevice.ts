import { PEOPLE_ROOT } from '@archive/paths';
import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { NodeChildEntry, NodeOwnership, shq } from '@ein/ui/lib';
import { DEVICES_ROOT } from './useDevices.ts';
import type { RelinkResult } from '@archive/device/api';

/** The settings a device carries, and the only fields the form writes. */
export type DeviceFields = {
  name: string;
  make: string;
  model: string;
  serial: string;
  timezone: string;
  description: string;
  digitizer: boolean;
  quicktimeUtc: boolean;
};

export type DeviceDetail = DeviceFields & {
  id: string;
  path: string;
  ownership: NodeOwnership;
};

export type DeviceOwner = {
  /** Person slug — the owner link's name, and the person's node name. */
  id: string;
  name: string;
  path: string;
  from?: string;
  to?: string;
};

type UseDeviceResult = {
  device: DeviceDetail | null;
  owners: DeviceOwner[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  /** Write the changed fields. An empty string clears the attr. */
  save: (fields: DeviceFields) => Promise<RelinkResult | null>;
  /** Add an owner, or with `update` rewrite an existing owner's dates (an omitted one is cleared). */
  addOwner: (personPath: string, span: { from?: string; to?: string }, update?: boolean) => Promise<void>;
  removeOwner: (personId: string) => Promise<void>;
  /** Link media this device produced but was registered too late to claim. */
  relink: () => Promise<RelinkResult>;
};

type OwnerLinkAttrs = { relation?: { from?: string; to?: string } };

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const EMPTY: DeviceFields = { name: '', make: '', model: '', serial: '', timezone: '', description: '', digitizer: false, quicktimeUtc: false };

/** Flag name for each field, as `device-update` spells it. */
type TextDeviceField = Exclude<keyof DeviceFields, 'digitizer' | 'quicktimeUtc'>;
const FLAGS: Record<TextDeviceField, string> = {
  name: 'name',
  make: 'make',
  model: 'model',
  serial: 'serial',
  timezone: 'timezone',
  description: 'description',
};

/**
 * One device: its settings, who owns it, and the writes the page can make.
 *
 * The parent listing carries attrs and mode, so the device itself costs no
 * extra call. Written through the `device-*` commands
 * rather than through `attrs`, so the rules about what a device may hold (a
 * real IANA timezone, `serialNumber` rather than `serial`) live on the server
 * where every caller gets them.
 */
export function useDevice(id: string | undefined): UseDeviceResult {
  const [device, setDevice] = useState<DeviceDetail | null>(null);
  const [owners, setOwners] = useState<DeviceOwner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const path = id ? `${DEVICES_ROOT}/${id}` : null;

  const fetchDevice = useCallback(async () => {
    if (!id || !path) return;

    try {
      setLoading(true);
      setError(null);

      const siblings = await execCommand<NodeChildEntry[]>(`ls -l ${DEVICES_ROOT}`);
      const entry = siblings.find((sibling) => sibling.name === id && sibling.node.type === 'device');

      if (!entry) {
        setDevice(null);
        setOwners([]);
        return;
      }

      const attrs = entry.node.attrs as Record<string, unknown>;
      setDevice({
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
        ownership: { mode: entry.node.props.mode, uid: entry.node.props.uid, gid: entry.node.props.gid },
      });

      // The device itself is enough to draw the page, so stop blocking here. What
      // follows resolves owner slugs against `ls -l /people`, a listing of the
      // whole archive's people, and there is no reason for the settings, the
      // header and the media list to wait on a two-line sidebar card.
      setLoading(false);

      // A device registered by hand may have no owners directory yet, which is
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
          .map((link): DeviceOwner => {
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
      setDevice(null);
      setOwners([]);
    } finally {
      setLoading(false);
    }
  }, [id, path]);

  useEffect(() => {
    fetchDevice();
  }, [fetchDevice]);

  const save = useCallback(async (fields: DeviceFields): Promise<RelinkResult | null> => {
    if (!path) return null;
    const current = device ?? EMPTY;

    // Only what actually changed, and an emptied field is a *clear* rather than
    // an empty string: `attrs -s serialNumber=` would leave the device carrying
    // a serial that matches nothing, and `device-match` compares by equality.
    const parts: string[] = [];
    for (const key of Object.keys(FLAGS) as TextDeviceField[]) {
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

    let relink: RelinkResult | null = null;
    if (parts.length > 0) {
      const result = await execCommand<{ relink?: RelinkResult }>(`device-update ${shq(path)} ${parts.join(' ')}`);
      relink = result.relink ?? null;
    }
    await fetchDevice();
    return relink;
  }, [path, device, fetchDevice]);

  const addOwner = useCallback(async (personPath: string, span: { from?: string; to?: string }, update = false) => {
    if (!path) return;
    const dates = [
      span.from ? `--from ${shq(span.from)}` : '',
      span.to ? `--to ${shq(span.to)}` : '',
      update ? '--update' : '',
    ].filter(Boolean).join(' ');
    await execCommand(`device-set-owner ${shq(path)} ${shq(personPath)} ${dates}`.trim());
    await fetchDevice();
  }, [path, fetchDevice]);

  const removeOwner = useCallback(async (personId: string) => {
    if (!path) return;
    await execCommand(`device-remove-owner ${shq(path)} ${shq(personId)}`);
    await fetchDevice();
  }, [path, fetchDevice]);

  const relink = useCallback(async (): Promise<RelinkResult> => {
    if (!path) return { device: '', scanned: 0, linked: 0, retimed: 0, skipped: 0 };
    return await execCommand<RelinkResult>(`device-relink ${shq(path)}`);
  }, [path]);

  return { device, owners, loading, error, refetch: fetchDevice, save, addOwner, removeOwner, relink };
}
