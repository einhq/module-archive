import type { StagingStatus } from '@archive/staging/api';
import { DEFAULT_CATEGORY, stagingRoots } from '@archive/staging/paths';
import { useCommand } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { execCommand, uploadBatchDone, uploadSummaryByTarget } from '@ein/ui/signals';
import { signal } from '@preact/signals-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { preparingBaseline, preparingEta, type PreparingSample } from '../lib/overview.ts';

/** While files arrive or are being prepared, status is read again this often, as long as the page is in view. */
const POLL_MS = 30_000;

/**
 * The wait before the next read is at least this many times the last read took. A category's
 * counts cost database time in proportion to its files, seconds for a few hundred thousand.
 */
const POLL_COST_FACTOR = 10;

/** Bumped by whatever changed a staging area from outside the page showing it: a dialog's command. */
const statusStale = signal(0);

/** Every `useStagingStatus` reads its status again: a category was made, changed or removed, or files moved. */
export const refreshStagingStatus = (): void => {
  statusStale.value++;
};

/** The staging layouts set up in this session, by user; one that failed is asked for again. */
const layouts = new Map<string, Promise<void>>();

/** `user`'s staging area set up once per session (`staging init --layout-only`, which moves nothing). */
const ensureStagingLayout = (user: string): Promise<void> => {
  let ready = layouts.get(user);
  if (!ready) {
    ready = execCommand(`staging init --layout-only --user ${shq(user)}`).then(() => {});
    ready.catch(() => layouts.delete(user));
    layouts.set(user, ready);
  }
  return ready;
};

/**
 * `staging status` for `user`: their staging area's categories, and what each holds; set up first
 * when it is not (`initialized: false`). Read again when a dialog changed it
 * (`refreshStagingStatus`), when an upload into it is done, and every 30 s while files are
 * uploading into it or being prepared and the page is in view, less often when a read takes more
 * than a tenth of that. `eta` is how long, in ms, each category's files still being
 * prepared take at the rate they went since this page started watching them, by category name.
 */
export function useStagingStatus(user: string) {
  const status = useCommand<StagingStatus>(`staging status --user ${shq(user)}`);
  const { data, refetch } = status;
  const stagingPath = stagingRoots(user).stagingPath;

  useEffect(() => {
    if (data?.initialized !== false) return;
    let current = true;
    ensureStagingLayout(user).then(() => {
      if (current) void refetch();
    }, () => {});
    return () => {
      current = false;
    };
  }, [data?.initialized, user, refetch]);

  // `subscribe` calls back at once with the value it holds; only a later change is a change.
  useEffect(() => {
    let first = true;
    return statusStale.subscribe(() => {
      if (!first) refetch();
      first = false;
    });
  }, [refetch]);

  useEffect(() => {
    let first = true;
    return uploadBatchDone.subscribe((batch) => {
      if (!first && batch?.dirs.some((dir) => dir.startsWith(`${stagingPath}/`))) refetch();
      first = false;
    });
  }, [refetch, stagingPath]);

  // Whether files are on their way into the area from this browser; a boolean, so the page
  // renders again when uploads start or end rather than on every progress update.
  const [arriving, setArriving] = useState(false);
  useEffect(() =>
    uploadSummaryByTarget.subscribe((targets) => {
      setArriving(Object.entries(targets).some(([root, counts]) => root.startsWith(`${stagingPath}/`) && counts.queued + counts.active > 0));
    }), [stagingPath]);

  const underWay = arriving || (data?.categories.some((category) => category.counts.indexing > 0) ?? false);
  useEffect(() => {
    if (!underWay) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      let wait = POLL_MS;
      if (document.visibilityState === 'visible') {
        const started = performance.now();
        await refetch();
        wait = Math.max(POLL_MS, POLL_COST_FACTOR * (performance.now() - started));
      }
      if (!stopped) timer = globalThis.setTimeout(poll, wait);
    };
    timer = globalThis.setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      globalThis.clearTimeout(timer);
    };
  }, [underWay, refetch]);

  const baselines = useRef(new Map<string, PreparingSample>());
  const eta = useMemo(() => {
    const at = Date.now();
    const estimates: Record<string, number | undefined> = {};
    for (const category of data?.categories ?? []) {
      const sample = { count: category.counts.indexing, at };
      const baseline = preparingBaseline(baselines.current.get(category.name), sample);
      baselines.current.set(category.name, baseline);
      estimates[category.name] = preparingEta(baseline, sample);
    }
    return estimates;
  }, [data]);

  return { ...status, eta };
}

/**
 * Today's upload folder in `user`'s category `category` (the default one unless named), for a page
 * that has not read the staging area: found when files are dropped rather than when the page
 * opens, after the staging directories are set up (`ensureStagingLayout`, which moves nothing), so
 * the folder is as private as the rest of it. It is the folder `staging status` names for today in
 * the archive's time zone; the upload queue makes it. An upload action's `path`.
 */
export const stagingUploadFolder = (user: string, category: string = DEFAULT_CATEGORY) => async (): Promise<string> => {
  await ensureStagingLayout(user);
  const status = await execCommand<StagingStatus>(`staging status --user ${shq(user)}`);
  const target = status.categories.find((entry) => entry.name === category);
  if (!target) throw new Error(`no staging category ${category} for ${user}`);
  return target.uploadPath;
};
