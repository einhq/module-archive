import { DEVICES_ROOT } from '@archive/paths';
import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { NodeChildEntry, NodeOwnership, shq } from '@ein/ui/lib';
import type { DeviceProposal, ScanResult } from '@archive/device/api';
export type { DeviceProposal } from '@archive/device/api';

export { DEVICES_ROOT };

export type DeviceEntry = {
  /** Node name under /devices — the route parameter. */
  id: string;
  path: string;
  name: string;
  make?: string;
  model?: string;
  serialNumber?: string;
  timezone?: string;
  digitizer?: boolean;
  quicktimeUtc?: boolean;
  description?: string;
  /** Owner links, cover photo and the configuration log all live as children. */
  ownership: NodeOwnership;
};

type UseDevicesResult = {
  devices: DeviceEntry[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  /** Proposals from the last scan this session; null until one has run. */
  scan: ScanResult | null;
  scanning: boolean;
  scanError: string | null;
  runScan: () => Promise<void>;
  /**
   * Give an already-registered device the fingerprint it was missing, then link
   * the media that fingerprint identifies.
   */
  adopt: (proposal: DeviceProposal) => Promise<number>;
};

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * The device registry, from one listing.
 *
 * `ls -l` already carries each device's attrs and mode, so nothing here needs a
 * second call per device.
 *
 * The scan for *unregistered* devices is deliberately not part of the load: it
 * is a question about the whole media corpus rather than about this directory,
 * and it is asked only when somebody opens that view.
 */
export function useDevices(): UseDevicesResult {
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const children = await execCommand<NodeChildEntry[]>(`ls -l ${DEVICES_ROOT}`);

      setDevices(
        children
          .filter((entry) => entry.node.type === 'device')
          .map((entry): DeviceEntry => {
            const attrs = entry.node.attrs as Record<string, unknown>;
            return {
              id: entry.name,
              path: `${DEVICES_ROOT}/${entry.name}`,
              name: str(attrs.name) ?? entry.name,
              make: str(attrs.make),
              model: str(attrs.model),
              serialNumber: str(attrs.serialNumber),
              timezone: str(attrs.timezone),
              digitizer: attrs.digitizer === true || undefined,
              quicktimeUtc: attrs.quicktimeUtc === true || undefined,
              description: str(attrs.description),
              ownership: {
                mode: entry.node.props.mode,
                uid: entry.node.props.uid,
                gid: entry.node.props.gid,
                ...(entry.node.props.acl?.length ? { acl: entry.node.props.acl } : {}),
              },
            };
          }),
      );
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const runScan = useCallback(async () => {
    try {
      setScanning(true);
      setScanError(null);
      setScan(await execCommand<ScanResult>('device-scan'));
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
      setScan(null);
    } finally {
      setScanning(false);
    }
  }, []);

  const adopt = useCallback(async (proposal: DeviceProposal): Promise<number> => {
    if (!proposal.existingPath) return 0;
    const path = proposal.existingPath;

    const parts: string[] = [];
    if (proposal.make) parts.push(`--make ${shq(proposal.make)}`);
    if (proposal.model) parts.push(`--model ${shq(proposal.model)}`);
    if (proposal.serialNumber) parts.push(`--serial ${shq(proposal.serialNumber)}`);
    if (parts.length > 0) await execCommand(`device-update ${shq(path)} ${parts.join(' ')}`);

    // Writing the fingerprint only decides *future* indexing; the files already
    // in the archive were passed over when they were indexed and stay unlinked
    // until something goes and gets them.
    const result = await execCommand<{ linked: number }>(`device-relink ${shq(path)}`);
    await Promise.all([fetchDevices(), runScan()]);
    return result.linked ?? 0;
  }, [fetchDevices, runScan]);

  return { devices, loading, error, refetch: fetchDevices, scan, scanning, scanError, runScan, adopt };
}
