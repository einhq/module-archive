import { CAMERAS_ROOT } from '@archive/paths';
import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { NodeChildEntry, NodeOwnership, shq } from '@ein/ui/lib';
import type { CameraProposal, RelinkResult, ScanResult } from '@archive/camera/api';
export type { CameraProposal } from '@archive/camera/api';

export { CAMERAS_ROOT };

export type CameraEntry = {
  /** Node name under /cameras — the route parameter. */
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

type UseCamerasResult = {
  cameras: CameraEntry[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  /** Proposals from the last scan this session; null until one has run. */
  scan: ScanResult | null;
  scanning: boolean;
  scanError: string | null;
  runScan: () => Promise<void>;
  /**
   * Give an already-registered camera the fingerprint it was missing, then link
   * the media that fingerprint identifies.
   */
  adopt: (proposal: CameraProposal) => Promise<number>;
};

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * The camera registry, from one listing.
 *
 * `ls -l` already carries each camera's attrs and mode, so nothing here needs a
 * second call per camera.
 *
 * The scan for *unregistered* cameras is deliberately not part of the load: it
 * is a question about the whole media corpus rather than about this directory,
 * and it is asked only when somebody opens that view.
 */
export function useCameras(): UseCamerasResult {
  const [cameras, setCameras] = useState<CameraEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const fetchCameras = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const children = await execCommand<NodeChildEntry[]>(`ls -l ${CAMERAS_ROOT}`);

      setCameras(
        children
          .filter((entry) => entry.node.type === 'camera')
          .map((entry): CameraEntry => {
            const attrs = entry.node.attrs as Record<string, unknown>;
            return {
              id: entry.name,
              path: `${CAMERAS_ROOT}/${entry.name}`,
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
      setCameras([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCameras();
  }, [fetchCameras]);

  const runScan = useCallback(async () => {
    try {
      setScanning(true);
      setScanError(null);
      setScan(await execCommand<ScanResult>('camera-scan'));
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
      setScan(null);
    } finally {
      setScanning(false);
    }
  }, []);

  const adopt = useCallback(async (proposal: CameraProposal): Promise<number> => {
    if (!proposal.existingPath) return 0;
    const path = proposal.existingPath;

    const parts: string[] = [];
    if (proposal.make) parts.push(`--make ${shq(proposal.make)}`);
    if (proposal.model) parts.push(`--model ${shq(proposal.model)}`);
    if (proposal.serialNumber) parts.push(`--serial ${shq(proposal.serialNumber)}`);
    // Writing the fingerprint links the files already in the archive that carry it.
    const result: { relink?: RelinkResult } = parts.length > 0 ? await execCommand<{ relink?: RelinkResult }>(`camera-update ${shq(path)} ${parts.join(' ')}`) : {};
    await Promise.all([fetchCameras(), runScan()]);
    return result.relink?.linked ?? 0;
  }, [fetchCameras, runScan]);

  return { cameras, loading, error, refetch: fetchCameras, scan, scanning, scanError, runScan, adopt };
}
