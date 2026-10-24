/**
 * The incremental organizer gives the groups a full build would. A random category (an invented
 * family's photos over two years: busy days, quiet days, trips away, a named folder, screenshots, a
 * scan dated to a year, an undated picture, boxes of scans) is built in full; then random changes
 * are made one at a time, each followed by an incremental run, and after each a full build, as a
 * dry run, finds nothing to create, rewrite or remove. The changes: photos arriving, deleted, retimed, moved to
 * another folder, read at last, given a GPS fix or a person; a folder renamed; and a person's
 * edits (split, merge, not a group, regroup, pin, undo). Then the same with the category grouped by
 * folder, and in monthly lanes.
 *
 * Also: a record of the trail whose write commits after a later one is read is still applied, as
 * the watermark lags; a category whose settings change, or that a person asks for, is planned whole.
 */
import type { OrganizeResult, StagingEditResult, StagingJournalPage, StagingOrganizeReport, StagingQueueReport } from '@archive/staging/api';
import { type AutoAlbumMeta, COVER_LINK_NAME } from '@archive/staging/auto-album';
import { LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import type { AuditRecord } from '@ein/api';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type NodeVFS, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const FILES = '/home/admin/staging/files/inbox';
const BATCH = `${FILES}/upload-2019-06-14`;
const SEED = `${BATCH}/Lake weekend`;
const OTHER = `${FILES}/upload-2019-09-01`;
const GROUPS = '/home/admin/staging/albums/inbox';
const BOXES = [`${FILES}/box-1`, `${FILES}/box-2/sleeve-a`, `${FILES}/box-2/sleeve-b`];
const HOME = { lat: 59.85, lng: 17.64 };
const AWAY = { lat: 57.7, lng: 11.97 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A seeded generator (mulberry32), so a failing sequence can be run again. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Photo = { name: string; at?: number; wall?: string; mimetype?: string; indexed?: boolean; device?: string };

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** Staged files in `dir`, as the media pipeline leaves them once indexed. */
const stage = async (vfs: NodeVFS, dir: string, photos: Photo[], owner: { uid: number; gid: number }): Promise<string[]> => {
  await vfs.createTree(
    ADMIN_ACCESS,
    dir,
    photos.map((photo) => ({
      type: 'file',
      name: photo.name,
      props: { uid: owner.uid, gid: owner.gid, mode: 0o640 },
      attrs: {
        mimetype: photo.mimetype ?? 'image/jpeg',
        size: 1000,
        ...(photo.at !== undefined ? { takenAtUtc: iso(photo.at), takenAt: photo.wall ?? iso(photo.at).replace('Z', '') } : {}),
        ...(photo.device ? { devicePath: photo.device } : {}),
        ...(photo.indexed === false ? {} : { indexedAt: '2026-10-18T00:00:00Z', facesAt: '2026-10-18T00:00:00Z' }),
      },
    })),
  );
  return photos.map((photo) => `${dir}/${photo.name}`);
};

type Group = { slug: string; name?: string; cover?: string; meta: AutoAlbumMeta; members: string[] };

/** Every group of the inbox with its members. */
const groups = async (vfs: NodeVFS): Promise<Group[]> => {
  const entries = await vfs.children<{ name?: string; autoAlbum?: AutoAlbumMeta }>(ADMIN_ACCESS, GROUPS);
  const out: Group[] = [];
  for (const entry of entries.filter((each) => each.node.type === 'album')) {
    const links = await vfs.children(ADMIN_ACCESS, `${GROUPS}/${entry.name}`, { follow: false });
    out.push({
      slug: entry.name,
      name: entry.node.attrs.name,
      cover: links.find((link) => link.name === COVER_LINK_NAME)?.node.props.softlink,
      meta: entry.node.attrs.autoAlbum!,
      members: links.filter((link) => link.name !== COVER_LINK_NAME).map((link) => link.node.props.softlink!).sort(),
    });
  }
  return out;
};

Deno.test({ name: 'the incremental organizer gives the groups a full build would', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const run = async (flags = ''): Promise<OrganizeResult> => {
    const result = (await client.execJson<StagingOrganizeReport>(`staging organize inbox --user admin ${flags}`)).results[0];
    assertEquals(result.error, undefined, result.error);
    return result;
  };
  const log: string[] = [];
  /** A full build as a dry run: it must find the groups as it would make them. What it would change fails the test, as a full build then changes it. */
  const assertSettled = async (what: string) => {
    const full = await run('--full --dry-run');
    if (full.groups.every((group) => group.action === 'unchanged' || group.action === 'pinned')) return;
    const before = new Map((await groups(vfs)).map((group) => [group.slug, group]));
    const checkpoint = async () => JSON.parse(await new Response((await vfs.open(ADMIN_ACCESS, `${GROUPS}/.organizer`, { mode: 'r' })).readable).text());
    const ckBefore = Deno.env.get('ORGANIZER_DEBUG_CK') ? await checkpoint() : undefined;
    await run('--full');
    const after = new Map((await groups(vfs)).map((group) => [group.slug, group]));
    if (ckBefore) {
      const ckAfter = await checkpoint();
      const days = [...new Set([...Object.keys(ckBefore.dayShots), ...Object.keys(ckAfter.dayShots)])].filter((day) => ckBefore.dayShots[day] !== ckAfter.dayShots[day]);
      console.log(
        'CK baselines',
        JSON.stringify(ckBefore.baselines),
        JSON.stringify(ckAfter.baselines),
        'days differ',
        JSON.stringify(days.map((day) => [day, ckBefore.dayShots[day], ckAfter.dayShots[day]])),
      );
      console.log(
        'CK segments',
        ckBefore.segments.length,
        ckAfter.segments.length,
        JSON.stringify(
          ckAfter.segments.filter((x: { start: number }) => !ckBefore.segments.some((y: { start: number }) => y.start === x.start)).map((
            x: { start: number; end: number },
          ) => [new Date(x.start).toISOString(), new Date(x.end).toISOString()]),
        ),
      );
    }
    const changed = [...new Set([...before.keys(), ...after.keys()])].flatMap((slug) => {
      const [was, is] = [before.get(slug), after.get(slug)];
      if (JSON.stringify(was) === JSON.stringify(is)) return [];
      const { generatedAt: _a, ...wasMeta } = was?.meta ?? {} as AutoAlbumMeta;
      const { generatedAt: _b, ...isMeta } = is?.meta ?? {} as AutoAlbumMeta;
      const meta = Object.keys({ ...wasMeta, ...isMeta }).filter((key) =>
        JSON.stringify(wasMeta[key as keyof typeof wasMeta]) !== JSON.stringify(isMeta[key as keyof typeof isMeta])
      );
      return [{
        slug,
        ...(was?.name !== is?.name ? { name: [was?.name, is?.name] } : {}),
        ...(was?.cover !== is?.cover ? { cover: [was?.cover, is?.cover] } : {}),
        left: was?.members.filter((member) => !is?.members.includes(member)),
        joined: is?.members.filter((member) => !was?.members.includes(member)),
        meta: Object.fromEntries(meta.map((key) => [key, [wasMeta[key as keyof typeof wasMeta], isMeta[key as keyof typeof isMeta]]])),
      }];
    });
    throw new Error(`after ${what}, a full build changes ${JSON.stringify(changed, null, 1)}\n${log.join('\n')}`);
  };

  try {
    await cmd.shouldSucceed('staging init --user admin');
    await cmd.shouldSucceed(`mkdir -p "${SEED}" ${OTHER} ${PEOPLE_ROOT} ${LOCATIONS_ROOT}`);
    // The owner, Anna Andersson, has lived in the town all along: home is there every year.
    await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/town`);
    await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/town/position --lat=${HOME.lat} --lng=${HOME.lng}`);
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/anna-andersson --name 'Anna Andersson'`);
    await cmd.shouldSucceed(`person-set-home --from 2010 ${PEOPLE_ROOT}/anna-andersson ${LOCATIONS_ROOT}/town`);
    await cmd.shouldSucceed(`ln -s ${PEOPLE_ROOT}/anna-andersson /etc/users/admin/person`);
    const home = await vfs.get(ADMIN_ACCESS, '/home/admin');
    const owner = { uid: home.props.uid, gid: home.props.gid };
    const next = random(Number(Deno.env.get('ORGANIZER_SEED') ?? 20261018));
    const pick = <T>(list: T[]): T => list[Math.floor(next() * list.length)];
    const devices = ['/dcim/a', '/dcim/b'];
    let counter = 0;
    const name = (prefix = 'IMG') => `${prefix}_${String(++counter).padStart(5, '0')}.jpg`;
    const files: string[] = [];
    const pending: string[] = [];
    /** The named folder, which a change may rename. */
    let seedDir = SEED;
    const start = Date.UTC(2018, 0, 1);

    /** A session of photos: a busy few hours, a quiet one or two, or a few days away. */
    const session = (at: number): Photo[] => {
      const kind = next();
      if (kind < 0.4) {
        return Array.from({ length: 4 + Math.floor(next() * 10) }, (_, i) => ({ name: name(), at: at + i * 9 * 60_000 + Math.floor(next() * 60_000), device: pick(devices) }));
      }
      if (kind < 0.85) return Array.from({ length: 1 + Math.floor(next() * 2) }, (_, i) => ({ name: name(), at: at + i * HOUR, device: pick(devices) }));
      return Array.from({ length: 3 * 4 }, (_, i) => ({ name: name('TRIP'), at: at + Math.floor(i / 4) * DAY + (i % 4) * HOUR, device: devices[0] }));
    };

    await t.step('a full build of a random category', async () => {
      for (let i = 0; i < 45; i++) {
        const photos = session(start + Math.floor(next() * 700) * DAY + 9 * HOUR);
        const staged = await stage(vfs, pick([BATCH, BATCH, OTHER]), photos, owner);
        files.push(...staged);
        // Trips away carry GPS far from home.
        for (const path of staged.filter((each) => each.includes('TRIP_'))) {
          await cmd.shouldSucceed(`position-set ${path}/position --lat=${AWAY.lat + next() * 0.01} --lng=${AWAY.lng + next() * 0.01}`);
        }
      }
      files.push(...await stage(vfs, SEED, Array.from({ length: 4 }, (_, i) => ({ name: name('LAKE'), at: Date.UTC(2019, 5, 15, 10 + i) })), owner));
      files.push(
        ...await stage(vfs, BATCH, [
          { name: 'Screenshot_20190601-101500.png', at: Date.UTC(2019, 5, 1, 10), mimetype: 'image/png' },
          { name: 'scan-1975.jpg', at: Date.UTC(1974, 11, 31, 23), wall: '1975' },
          { name: 'no-date.jpg' },
        ], owner),
      );
      pending.push(...await stage(vfs, OTHER, [{ name: name(), at: Date.UTC(2019, 8, 2, 12), indexed: false }], owner));
      // Boxes of scans, numbered as a scanner numbers them, some dated by hand.
      for (const box of BOXES) {
        await cmd.shouldSucceed(`mkdir -p ${box}`);
        files.push(...await stage(vfs, box, Array.from({ length: 12 }, () => ({ name: name('SCAN'), at: start + Math.floor(next() * 700) * DAY })), owner));
      }
      const result = await run();
      assertEquals([result.mode, result.why], ['full', 'first']);
      await assertSettled('the first build');
    });

    /** The groups of one kind, those a person keeps aside. */
    const groupsOf = async (kinds: string[]) => (await groups(vfs)).filter((group) => kinds.includes(group.meta.kind ?? 'event') && !group.meta.pinned);
    const timed = () => files.filter((path) => !path.endsWith('no-date.jpg') && !path.endsWith('scan-1975.jpg'));

    const changes: [string, () => Promise<string | undefined>][] = [
      ['arrive', async () => {
        const photos = session(start + Math.floor(next() * 720) * DAY + Math.floor(next() * 14) * HOUR);
        const staged = await stage(vfs, pick([BATCH, OTHER, seedDir, ...BOXES]), photos, owner);
        files.push(...staged);
        return `${staged.length} arrive at ${photos[0].at && iso(photos[0].at)}`;
      }],
      ['delete', async () => {
        const path = pick(files);
        await vfs.unlink(ADMIN_ACCESS, path, path.slice(0, path.lastIndexOf('/')), { recursive: true });
        files.splice(files.indexOf(path), 1);
        return `delete ${path}`;
      }],
      ['retime', async () => {
        const path = pick(timed());
        const node = await vfs.get<{ takenAtUtc: string }>(ADMIN_ACCESS, path);
        const at = Date.parse(node.attrs.takenAtUtc) + Math.floor((next() - 0.5) * 6 * DAY);
        await vfs.update(ADMIN_ACCESS, path, { attrs: { takenAtUtc: iso(at), takenAt: iso(at).replace('Z', '') } });
        return `retime ${path} to ${iso(at)}`;
      }],
      ['move', async () => {
        const path = pick(files);
        const to = pick([BATCH, OTHER, seedDir, ...BOXES].filter((dir) => !path.startsWith(`${dir}/`) || path.slice(dir.length + 1).includes('/')));
        const leaf = path.slice(path.lastIndexOf('/') + 1);
        if (files.includes(`${to}/${leaf}`)) return undefined;
        await cmd.shouldSucceed(`mv "${path}" "${to}/"`);
        files.splice(files.indexOf(path), 1, `${to}/${leaf}`);
        return `move ${path} to ${to}`;
      }],
      ['read', async () => {
        const path = pending.shift();
        if (!path) return undefined;
        await vfs.update(ADMIN_ACCESS, path, { attrs: { indexedAt: '2026-10-18T02:00:00Z', facesAt: '2026-10-18T02:00:00Z' } });
        files.push(path);
        pending.push(...await stage(vfs, OTHER, [{ name: name(), at: start + Math.floor(next() * 700) * DAY, indexed: false }], owner));
        return `read ${path}`;
      }],
      ['gps', async () => {
        const path = pick(timed());
        if (await vfs.exists(ADMIN_ACCESS, `${path}/position`)) return undefined;
        const at = next() < 0.5 ? HOME : AWAY;
        await cmd.shouldSucceed(`position-set "${path}/position" --lat=${at.lat + next() * 0.01} --lng=${at.lng + next() * 0.01}`);
        return `gps ${path} ${at === HOME ? 'home' : 'away'}`;
      }],
      ['person', async () => {
        const path = pick(timed());
        if (await vfs.exists(ADMIN_ACCESS, `${path}/regions`)) return undefined;
        await vfs.createTree(ADMIN_ACCESS, path, [{
          type: 'directory',
          name: 'regions',
          children: [{ type: 'media-region', name: 'face-1', attrs: { personId: pick(['p-anna', 'p-bo']) } }],
        }]);
        return `person on ${path}`;
      }],
      ['rename folder', async () => {
        const [at, to] = [seedDir, `${BATCH}/Lake weekend ${++counter}`];
        await cmd.shouldSucceed(`mv "${at}" "${to}"`);
        seedDir = to;
        for (let i = 0; i < files.length; i++) if (files[i].startsWith(`${at}/`)) files[i] = `${to}${files[i].slice(at.length)}`;
        return `rename ${at} to ${to}`;
      }],
      ['split', async () => {
        const group = pick(await groupsOf(['event', 'trip']));
        if (!group || group.members.length < 4) return undefined;
        // Members are listed by path, so the one picked may be the group's first, which a split refuses.
        const at = group.members[Math.floor(group.members.length / 2)];
        const split = await client.execJson<StagingEditResult>(`staging split ${group.slug} --at "${at}"`).catch(() => undefined);
        return split && `split ${group.slug} at ${at}`;
      }],
      ['merge', async () => {
        const events = (await groupsOf(['event'])).sort((a, b) => (a.meta.timeStart ?? '').localeCompare(b.meta.timeStart ?? ''));
        if (events.length < 2) return undefined;
        const i = Math.floor(next() * (events.length - 1));
        await client.execJson<StagingEditResult>(`staging merge ${events[i].slug} ${events[i + 1].slug}`);
        return `merge ${events[i].slug} ${events[i + 1].slug}`;
      }],
      ['not a group', async () => {
        const group = pick(await groupsOf(['event']));
        if (!group) return undefined;
        await client.execJson<StagingEditResult>(`staging delete ${group.slug}`);
        return `delete ${group.slug}`;
      }],
      ['regroup', async () => {
        const [into, from] = [pick(await groupsOf(['event', 'trip'])), pick(await groupsOf(['loose']))];
        if (!into || !from) return undefined;
        const file = pick(from.members);
        await client.execJson<StagingEditResult>(`staging regroup ${into.slug} "${file}"`);
        return `regroup ${file} into ${into.slug}`;
      }],
      ['pin', async () => {
        const group = pick(await groups(vfs));
        if (!group) return undefined;
        await cmd.shouldSucceed(`staging pin ${group.slug}${group.meta.pinned ? ' --off' : ''}`);
        return `pin ${group.slug}${group.meta.pinned ? ' --off' : ''}`;
      }],
      ['undo', async () => {
        const page = await client.execJson<StagingJournalPage>('staging journal inbox --limit 20');
        const entry = page.entries.find((each) => each.undoable && each.action === 'edit');
        if (!entry) return undefined;
        await cmd.shouldSucceed(`staging undo ${entry.id}`);
        return `undo ${entry.id} (${entry.summary})`;
      }],
    ];

    /**
     * `count` random changes, each followed by a run, after which a full build changes nothing; at
     * least `incremental` of the runs plan only what changed (a change in a big folder grouped by
     * folder is most of the category, which is planned whole).
     */
    const randomChanges = async (count: number, incremental: number) => {
      const before = log.length;
      for (let i = 0; i < count; i++) {
        const [kind, change] = pick(changes);
        const what = await change();
        if (!what) continue;
        log.push(`${i}: ${what}`);
        const result = await run();
        log.push(
          `   ${result.mode}${result.why ? ` (${result.why})` : ''}: ${result.records} records, ${result.items} planned, ${result.windows} spans; ` +
            `${result.created}+ ${result.updated}~ ${result.removed}-`,
        );
        await assertSettled(`${kind} (${what})`);
      }
      assert(log.slice(before).filter((line) => line.includes('incremental')).length >= incremental, log.join('\n'));
    };

    const steps = Number(Deno.env.get('ORGANIZER_STEPS') ?? 100);
    await t.step(`${steps} random changes, each planned incrementally as a full build would`, async () => {
      await randomChanges(steps, steps / 3);
    });

    await t.step('in a category grouped by folder, and in one of monthly lanes, too', async () => {
      for (const strategy of ['folders', 'none']) {
        await cmd.shouldSucceed(`staging category inbox --strategy ${strategy}`);
        const result = await run();
        assertEquals([result.mode, result.why], ['full', 'settings']);
        await assertSettled(`grouping by ${strategy}`);
        log.push(`grouping by ${strategy}`);
        await randomChanges(Math.ceil(steps / 3), 1);
      }
      await cmd.shouldSucceed('staging category inbox --strategy events');
      await run();
    });

    await t.step('a write whose record commits after a later one was read is still applied', async () => {
      // The store holding the data, whose trail the test holds records back from, as a transaction
      // still open would.
      const data = (vfs.mounts(ADMIN_ACCESS).find((mount) => mount.point.vfsAbsPath === '/')?.vfs ?? vfs) as unknown as { store: { audit: AuditRecord[] } };
      const late = await stage(vfs, OTHER, [{ name: 'late.jpg', at: Date.UTC(2016, 2, 3, 12), indexed: false }], owner);
      await vfs.update(ADMIN_ACCESS, late[0], { attrs: { indexedAt: '2026-10-18T03:00:00Z', facesAt: '2026-10-18T03:00:00Z' } });
      const held = data.store.audit.filter((record) => record.path === late[0]);
      data.store.audit = data.store.audit.filter((record) => record.path !== late[0]);
      // A later write, read by the next run, which moves the watermark past nothing it has not seen.
      const other = await stage(vfs, OTHER, [{ name: 'later.jpg', at: Date.UTC(2017, 6, 3, 12) }], owner);
      assert(held.every((record) => record.id < data.store.audit.at(-1)!.id));
      await run();
      assert(!(await groups(vfs)).some((group) => group.members.includes(late[0])));
      // The held records commit now, their ids older than the one already read.
      data.store.audit.push(...held);
      await run();
      assert((await groups(vfs)).some((group) => group.members.includes(late[0])));
      files.push(late[0], other[0]);
      await assertSettled('a late commit');
    });

    await t.step('a change of the category’s grouping settings plans it whole', async () => {
      await cmd.shouldSucceed('staging category inbox --significance more');
      const result = await run();
      assertEquals([result.mode, result.why], ['full', 'settings']);
      await assertSettled('the settings change');
    });

    await t.step('a run asked for is written as a request; with nothing waiting, --if-pending asks for none', async () => {
      const asked = await client.execJson<StagingQueueReport>('staging organize inbox --queue');
      assertEquals(asked.results.map((each) => [each.category, each.queued]), [['inbox', true]]);
      const request = await vfs.get<{ stagingRequest?: { at: string } }>(ADMIN_ACCESS, `${GROUPS}/.request`, { follow: false });
      assertEquals(request.attrs.stagingRequest?.at, asked.results[0].requestedAt);
      assertEquals((request.props.mode ?? 0) & 0o777, 0o600);
      await run();
      const idle = await client.execJson<StagingQueueReport>('staging organize inbox --user admin --queue --if-pending');
      assertEquals(idle.results.map((each) => [each.queued, each.why]), [[false, undefined]]);
      await stage(vfs, OTHER, [{ name: 'one-more.jpg', at: Date.UTC(2019, 1, 2, 12) }], owner);
      const waiting = await client.execJson<StagingQueueReport>('staging organize inbox --user admin --queue --if-pending');
      assertEquals(waiting.results.map((each) => [each.queued, each.why]), [[true, 'changes']]);
      // As the pipeline runs it: the category by path, which names its user.
      const [byPath] = (await client.execJson<StagingOrganizeReport>(`staging organize ${FILES}`)).results;
      assertEquals([byPath.user, byPath.category, byPath.mode, byPath.created + byPath.updated > 0], ['admin', 'inbox', 'incremental', true]);
    });

    await t.step('a person asks for a run of their own category, and of no one else’s', async () => {
      await cmd.shouldSucceed('user-create bo --uid 3500');
      await cmd.shouldSucceed('user-passwd bo --new-password secret1');
      await cmd.shouldSucceed('staging init --user bo');
      const bo = await testCtx.server.createShellClient({ username: 'bo', password: 'secret1' });
      try {
        const asked = await bo.execJson<StagingQueueReport>('staging organize inbox --queue');
        assertEquals(asked.results.map((each) => [each.user, each.category, each.queued]), [['bo', 'inbox', true]]);
        const request = await vfs.get(ADMIN_ACCESS, '/home/bo/staging/albums/inbox/.request', { follow: false });
        assertEquals([request.props.uid, (request.props.mode ?? 0) & 0o777], [3500, 0o600]);
        // Another's category, and the safety net's look at the trail, are not theirs to ask for.
        assertEquals((await bo.exec('staging organize inbox --user admin --queue')).success, false);
        assertEquals((await bo.exec('staging organize inbox --queue --if-pending')).success, false);
        assertEquals((await bo.exec(`staging organize ${FILES} --queue`)).success, false);
      } finally {
        bo.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
