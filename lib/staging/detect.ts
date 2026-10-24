/**
 * `staging detect`: what a folder of new files looks like it came from (a Google Photos Takeout,
 * scans, a phone, a camera, a messenger, screenshots) and so which kind of category it belongs in,
 * with the evidence and how sure (`StagingDetection`).
 *
 * A folder costs a bounded number of reads however large its tree is (`gather`): one page of
 * folders from each of at most `FOLDERS_PER_LEVEL` folders on each of three levels, one aggregate
 * of the files within by mimetype, one page of `DETECT_SAMPLE` files within, the start of at most
 * `BODY_READS` JSON files (or as many paired sidecars), and the EXIF of at most `EXIF_READS`
 * indexed media. The rules (`classify`) are pure, over what was read (`Seen`).
 */
import type { StagingCategoryKind, StagingDetectAnswer, StagingDetection, StagingDetectionConfidence } from '@archive/staging/api';
import type { Command } from '@ein/client';
import { readSidecar } from '@archive/media/paired-sidecar';
import { type CategoryEntry, readCategories } from '@archive/staging/category';
import { categoryPath, DEFAULT_CATEGORY, isUploadFolder, parseStagedPath, stagedPlace } from '@archive/staging/paths';
import { basename } from '@std/path';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** Files within a folder whose names, mimetypes and sizes are read. */
export const DETECT_SAMPLE = 500;
/** Folders read per listing. */
export const LISTING_PAGE = 200;
/** How deep folders are listed below the one detected. */
export const LISTING_LEVELS = 3;
/** Folders of a level whose own folders are listed: those named like a source's first. */
export const FOLDERS_PER_LEVEL = 4;
/** JSON files (or paired sidecars) read per folder. */
export const BODY_READS = 3;
/** EXIF records read per folder. */
export const EXIF_READS = 8;
/** Folders one call detects at most. */
export const DETECT_MAX = 20;
/** Newly arrived folders looked at without a folder named. */
const ARRIVALS_MAX = 12;

/** The attr that, true on a folder, keeps it out of the arrivals detected. */
const DETECT_DISMISSED = 'detectDismissed';

/** Whether a node's `attrs` dismiss its hint. */
const isDismissed = (attrs: unknown): boolean => (attrs as Record<string, unknown> | undefined)?.[DETECT_DISMISSED] === true;

/** The bytes of a JSON file read: Google's keys come first. */
const BODY_HEAD = 16 * 1024;
/** Upload folders, newest first, whose folders count as arrivals. */
const UPLOAD_FOLDERS_READ = 14;
/** Folders directly in the default category read at most. */
const ARRIVAL_LISTING = 2_000;

/** A kind a folder can be detected as: every kind but the default category's and `generic`. */
type SourceKind = Exclude<StagingCategoryKind, 'inbox' | 'generic'>;

/** The device a medium's EXIF names, or null for an EXIF that names none. */
type Device = { make?: string; model?: string } | null;

/** What was read of a folder, which the rules decide on. */
type Seen = {
  /** The folder's own name. */
  name: string;
  /** Folders within, as paths relative to it: those listed and those the sampled files lie in. */
  folders: string[];
  /** Files within, and how many are of each mimetype. */
  files: number;
  mimetypes: Record<string, number>;
  /** The sampled media files' names. */
  media: string[];
  /** The sampled JSON files' names. */
  json: string[];
  /** JSON files (or paired sidecars) read, and how many of them Google Photos wrote. */
  bodies: { read: number; google: number };
  /** The devices the EXIF of the indexed media read name. */
  devices: Device[];
  /** The sampled indexed images' sizes, `<long>x<short>`. */
  sizes: string[];
};

const MEDIA_MIME = /^(?:image|video|audio)\//;
const MEDIA_EXT = /\.(?:jpe?g|heic|heif|png|gif|webp|tiff?|bmp|dng|nef|cr2|cr3|arw|raf|orf|rw2|pef|srw|mp4|mov|m4v|3gp|avi|mts|mkv|webm|mp3|m4a|wav|opus|ogg|aac)$/i;
const RAW_EXT = /\.(?:nef|cr2|cr3|arw|raf|orf|rw2|pef|srw)$/i;

/** How strongly a sign points at its kind: a mark only that source leaves is 3. */
type Weight = 1 | 2 | 3;
type Sign = { kind: SourceKind; weight: Weight; text: string };

/** The kinds in the order a tie goes. */
const KINDS: SourceKind[] = ['google-photos', 'scans', 'messaging', 'screenshots', 'phone', 'camera'];

/** File names each source writes, anchored at the start. */
const NAME_MARKS: { kind: SourceKind; pattern: RegExp }[] = [
  { kind: 'scans', pattern: /^scan(?:ned)?[ _-]?\d/i },
  { kind: 'scans', pattern: /^FastFoto_\d/i },
  // A scanner's day and running number; a phone's IMG_ name has a six-digit time instead.
  { kind: 'scans', pattern: /^IMG_\d{8}_\d{4}(?!\d)/ },
  { kind: 'phone', pattern: /^PXL_\d{8}_\d{9}/ },
  { kind: 'phone', pattern: /^(?:IMG|VID|PANO|MVIMG)_\d{8}_\d{6}(?!\d)/ },
  { kind: 'phone', pattern: /^\d{8}_\d{6}(?!\d)/ },
  { kind: 'messaging', pattern: /^(?:IMG|VID|AUD|PTT|STK)-\d{8}-WA\d{4}/ },
  { kind: 'messaging', pattern: /^signal-\d{4}-\d{2}-\d{2}-\d{6}/ },
  { kind: 'messaging', pattern: /^photo_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/ },
  { kind: 'screenshots', pattern: /^(?:Screenshot|Screen Shot|Skärmavbild|Skärmbild|Bildschirmfoto)[ _-]/i },
  { kind: 'camera', pattern: /^_?DSC[NF_]?\d{4,5}(?!\d)/ },
  { kind: 'camera', pattern: /^P\d{7}(?!\d)/ },
  { kind: 'camera', pattern: /^(?:GOPR\d{4}|G[HX]\d{6}|DJI_\d{4})(?!\d)/ },
];

/** A camera's or an iPhone's running number: which, the EXIF or the HEIC beside it says. */
const RUNNING_NUMBER = /^(?:IMG|MVI)_\d{4}(?!\d)/;

/**
 * Folder paths (relative, the folder's own name first) each source makes, with how strongly; `what`
 * says it of the last folder of the first path that matched, and how many did.
 */
const FOLDER_MARKS: { kind: SourceKind; weight: Weight; pattern: RegExp; what: (name: string, count: number) => string }[] = [
  { kind: 'google-photos', weight: 3, pattern: /(?:^|\/)Takeout\/Google (?:Photos|Foto)$/i, what: () => 'a Takeout/Google Photos folder' },
  { kind: 'google-photos', weight: 2, pattern: /(?:^|\/)Google (?:Photos|Foto)$/i, what: (name) => `a ${name} folder` },
  { kind: 'google-photos', weight: 2, pattern: /(?:^|\/)(?:Photos from|Foton från|Bilder från) \d{4}$/i, what: (name, count) => `${count} folder(s) like ${name}` },
  { kind: 'phone', weight: 3, pattern: /(?:^|\/)DCIM\/Camera$/i, what: () => 'a DCIM/Camera folder' },
  { kind: 'phone', weight: 3, pattern: /(?:^|\/)DCIM\/\d{3}APPLE$/i, what: (name) => `an iPhone's DCIM/${name} folder` },
  { kind: 'camera', weight: 3, pattern: /(?:^|\/)DCIM\/\d{3}(?!APPLE)[A-Z_]{5}$/i, what: (name) => `a camera's DCIM/${name} folder` },
  { kind: 'phone', weight: 1, pattern: /(?:^|\/)DCIM$/i, what: () => 'a DCIM folder' },
  { kind: 'camera', weight: 1, pattern: /(?:^|\/)DCIM$/i, what: () => 'a DCIM folder' },
  {
    kind: 'messaging',
    weight: 3,
    pattern: /(?:^|\/)WhatsApp (?:Images|Video|Animated Gifs|Stickers|Documents|Audio|Voice Notes)$/i,
    what: (name) => `a ${name} folder`,
  },
  { kind: 'messaging', weight: 2, pattern: /(?:^|\/)(?:WhatsApp|Telegram(?: Images| Video)?|Signal|Messenger)$/i, what: (name) => `a ${name} folder` },
  { kind: 'screenshots', weight: 2, pattern: /(?:^|\/)(?:Screenshots?|Screen ?shots|Skärmbilder|Skärmavbilder|Bildschirmfotos)$/i, what: (name) => `a ${name} folder` },
  { kind: 'scans', weight: 2, pattern: /(?:^|\/)[^/]*\b(?:scan(?:s|ned|ning)?|skann\w*)\b[^/]*$/i, what: (name) => `a folder named ${name}` },
];

/** Folder names listed first: those a source names its folders. */
const SOURCE_FOLDER = /^(?:Takeout|Google (?:Photos|Foto)|DCIM|Camera|WhatsApp.*|Telegram.*|Signal|Screenshots?)$/i;

/** Google Photos' JSON names: a photo's name and `.json`, or the supplemental form, cut or not. */
const SUPPLEMENTAL_JSON = /\.supp[a-z-]*(?:\(\d+\))?\.json$/i;
const PHOTO_JSON = /\.(?:jpe?g|heic|png|gif|webp|mp4|mov|m4v|3gp)(?:\(\d+\))?\.json$/i;
/** A Takeout photo's or album's JSON, by the keys only Google writes. */
const GOOGLE_KEYS = /"(?:photoTakenTime|googlePhotosOrigin|albumData)"\s*:|"date"\s*:\s*\{\s*"timestamp"/;

const SCANNER = /scan|epson|fastfoto|perfection|plustek|reflecta|pacific image|imacon|hasselblad flextight/i;
const PHONE_MAKE = /^(?:apple|samsung|google|huawei|honor|xiaomi|redmi|oneplus|motorola|oppo|vivo|realme|nothing|hmd global|nokia|lg electronics|htc|fairphone)\b/i;
const CAMERA_MAKE =
  /^(?:nikon|canon|sony|fujifilm|olympus|om digital|panasonic|pentax|ricoh|leica|sigma|hasselblad|gopro|dji|kodak|minolta|konica minolta|casio|samsung techwin|insta360)\b/i;

/** What made a device's pictures: a scanner, a phone, a camera, or none that is known. */
const deviceKind = (device: NonNullable<Device>): 'scans' | 'phone' | 'camera' | undefined => {
  const both = `${device.make ?? ''} ${device.model ?? ''}`;
  if (SCANNER.test(both)) return 'scans';
  if (PHONE_MAKE.test(device.make ?? '')) return 'phone';
  if (CAMERA_MAKE.test(device.make ?? '')) return 'camera';
  return undefined;
};

const percent = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;

/** How strongly names of one source point at it, by their share of the sampled media. */
const shareWeight = (count: number, of: number): Weight | 0 => {
  const share = count / of;
  return share >= 0.5 ? 3 : share >= 0.2 ? 2 : count >= 2 && share >= 0.05 ? 1 : 0;
};

/** Every sign what was read gives, of any source. */
const signsOf = (seen: Seen): Sign[] => {
  const signs: Sign[] = [];

  // Folders, the folder's own name among them.
  const paths = [seen.name, ...seen.folders.map((folder) => `${seen.name}/${folder}`)];
  for (const mark of FOLDER_MARKS) {
    const hits = paths.filter((path) => mark.pattern.test(path));
    if (hits.length === 0) continue;
    signs.push({ kind: mark.kind, weight: mark.weight, text: mark.what(basename(hits[0]), hits.length) });
  }

  // Mimetypes of every file within.
  const images = Object.entries(seen.mimetypes).filter(([type]) => type.startsWith('image/')).reduce((sum, [, n]) => sum + n, 0);
  const ofType = (pattern: RegExp) => Object.entries(seen.mimetypes).filter(([type]) => pattern.test(type)).reduce((sum, [, n]) => sum + n, 0);
  const tiff = ofType(/^image\/tiff$/);
  const heic = ofType(/^image\/hei[cf]/);
  const png = ofType(/^image\/png$/);
  if (images >= 3 && tiff / images >= 0.5) signs.push({ kind: 'scans', weight: 2, text: `${percent(tiff, images)} of ${images} images are TIFF` });
  if (images >= 3 && heic / images >= 0.2) signs.push({ kind: 'phone', weight: 2, text: `${percent(heic, images)} of ${images} images are HEIC` });
  if (images >= 3 && png / images >= 0.8) signs.push({ kind: 'screenshots', weight: 1, text: `${percent(png, images)} of ${images} images are PNG` });

  // The devices the EXIF names.
  const named = seen.devices.filter((device): device is NonNullable<Device> => device !== null);
  const byKind = new Map<string, NonNullable<Device>[]>();
  for (const device of named) {
    const kind = deviceKind(device);
    if (kind) byKind.set(kind, [...byKind.get(kind) ?? [], device]);
  }
  const deviceName = (device: NonNullable<Device>) => [device.make, device.model].filter(Boolean).join(' ');
  for (const [kind, devices] of byKind) {
    if (devices.length * 2 < named.length) continue;
    const weight: Weight = kind === 'scans' ? 3 : 2;
    const what = kind === 'scans' ? 'a scanner' : kind === 'phone' ? 'a phone' : 'a camera';
    signs.push({ kind: kind as SourceKind, weight, text: `${what} in the EXIF of ${devices.length} of ${seen.devices.length} files read (${deviceName(devices[0])})` });
  }
  const noDevice = seen.devices.length >= 3 && named.length === 0;
  if (noDevice) signs.push({ kind: 'scans', weight: 1, text: `no device in the EXIF of ${seen.devices.length} files read` });
  if (seen.sizes.length >= 5) {
    const counts = new Map<string, number>();
    for (const size of seen.sizes) counts.set(size, (counts.get(size) ?? 0) + 1);
    const [size, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (count / seen.sizes.length >= 0.8) signs.push({ kind: 'scans', weight: 1, text: `${count} of ${seen.sizes.length} images read are ${size}` });
  }

  // Sampled names.
  if (seen.media.length > 0) {
    const of = seen.media.length;
    for (const kind of KINDS) {
      const hits = seen.media.filter((name) => NAME_MARKS.some((mark) => mark.kind === kind && mark.pattern.test(name)));
      const weight = shareWeight(hits.length, of);
      if (weight !== 0) signs.push({ kind, weight, text: `${hits.length} of ${of} names like ${hits[0]}` });
    }
    const raw = seen.media.filter((name) => RAW_EXT.test(name));
    if (raw.length / of >= 0.1) signs.push({ kind: 'camera', weight: 2, text: `${raw.length} of ${of} files are camera RAW, such as ${raw[0]}` });
    // A running number is a camera's or an iPhone's: the device, or else HEIC, says which.
    const running = seen.media.filter((name) => RUNNING_NUMBER.test(name));
    const weight = shareWeight(running.length, of);
    const owner = (byKind.get('camera')?.length ?? 0) * 2 >= named.length && named.length > 0
      ? 'camera'
      : (byKind.get('phone')?.length ?? 0) * 2 >= named.length && named.length > 0
      ? 'phone'
      : images > 0 && heic / images >= 0.2
      ? 'phone'
      : undefined;
    if (weight !== 0 && owner) signs.push({ kind: owner, weight: weight === 3 ? 2 : weight, text: `${running.length} of ${of} names like ${running[0]}` });
  }

  // Google's JSON.
  const supplemental = seen.json.filter((name) => SUPPLEMENTAL_JSON.test(name));
  const photoJson = seen.json.filter((name) => PHOTO_JSON.test(name) && !SUPPLEMENTAL_JSON.test(name));
  if (supplemental.length > 0) signs.push({ kind: 'google-photos', weight: 3, text: `${supplemental.length} JSON names like ${supplemental[0]}` });
  if (photoJson.length >= 2) signs.push({ kind: 'google-photos', weight: 2, text: `${photoJson.length} JSON names like ${photoJson[0]}` });
  if (seen.bodies.google > 0) signs.push({ kind: 'google-photos', weight: 3, text: `${seen.bodies.google} of ${seen.bodies.read} JSON sidecars read are Google Photos'` });

  return signs;
};

/** What a folder looks like, from what was read of it. */
const classify = (seen: Seen): { kind: StagingCategoryKind; confidence: StagingDetectionConfidence; evidence: string[] } => {
  const signs = signsOf(seen);
  const scores = KINDS.map((kind) => ({ kind, score: signs.filter((sign) => sign.kind === kind).reduce((sum, sign) => sum + sign.weight, 0) }));
  const ranked = scores.toSorted((a, b) => b.score - a.score || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  const [best, next] = ranked;
  if (best.score === 0) {
    const sampled = seen.media.length + seen.json.length;
    return {
      kind: 'generic',
      confidence: sampled >= 50 ? 'medium' : 'low',
      evidence: [seen.files === 0 ? 'no files within' : `no source's marks in ${sampled} names and ${seen.folders.length} folders`],
    };
  }
  const confidence: StagingDetectionConfidence = best.score >= 3 && next.score * 2 <= best.score ? 'high' : best.score >= 2 && next.score < best.score ? 'medium' : 'low';
  const evidence = signs.filter((sign) => sign.kind === best.kind).toSorted((a, b) => b.weight - a.weight).map((sign) => sign.text);
  return { kind: best.kind, confidence, evidence };
};

/** Up to `count` of `items`, spread evenly over them. */
const spread = <T>(items: T[], count: number): T[] => items.length <= count ? items : Array.from({ length: count }, (_, i) => items[Math.floor((i * items.length) / count)]);

/** The first `BODY_HEAD` bytes of the file at `path` as text. */
const readHead = async (vfs: Vfs, access: Access, path: string): Promise<string> => {
  const handle = await vfs.open(access, path, { mode: 'r' });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < BODY_HEAD) {
      const chunk = await handle.read(BODY_HEAD - total);
      if (chunk.length === 0) break;
      chunks.push(chunk);
      total += chunk.length;
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(body);
  } finally {
    await handle.close();
  }
};

/** The folders within `root`, relative to it, listed level by level as the module comment says. */
const listFolders = async (vfs: Vfs, access: Access, root: string): Promise<string[]> => {
  const folders: string[] = [];
  let level = [''];
  for (let depth = 0; depth < LISTING_LEVELS && level.length > 0; depth++) {
    const found: string[] = [];
    for (const relative of level) {
      const page = await vfs.children(access, relative ? `${root}/${relative}` : root, { types: ['directory'], page: { limit: LISTING_PAGE } });
      for (const entry of page) found.push(relative ? `${relative}/${entry.name}` : entry.name);
    }
    folders.push(...found);
    const named = found.filter((folder) => SOURCE_FOLDER.test(basename(folder)));
    level = [...named, ...found.filter((folder) => !SOURCE_FOLDER.test(basename(folder)))].slice(0, FOLDERS_PER_LEVEL);
  }
  return folders;
};

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read what the rules need of the folder at `root`, within the bounds the module comment names. */
export const gather = async (vfs: Vfs, access: Access, root: string): Promise<Seen> => {
  const node = await vfs.get(access, root);
  if (node.type !== 'directory') throw new Error(`not a folder: ${root}`);
  const listed = await listFolders(vfs, access, root);
  const buckets = await vfs.aggregate(access, { within: root, types: ['file'], group: [{ ref: 'mimetype' }] });
  const rows = await vfs.query(access, { within: root, types: ['file'], limit: DETECT_SAMPLE });

  const folders = new Set(listed);
  const media: { name: string; path: string; attrs: Record<string, unknown> }[] = [];
  const json: { name: string; path: string; attrs: Record<string, unknown> }[] = [];
  for (const row of rows) {
    const relative = row.absPath.startsWith(`${root}/`) ? row.absPath.slice(root.length + 1) : basename(row.absPath);
    const segments = relative.split('/');
    for (let i = 1; i < segments.length; i++) folders.add(segments.slice(0, i).join('/'));
    const name = segments[segments.length - 1];
    const attrs = row.node.attrs as Record<string, unknown>;
    const mimetype = typeof attrs.mimetype === 'string' ? attrs.mimetype : '';
    if (/\.json$/i.test(name)) json.push({ name, path: row.absPath, attrs });
    else if (MEDIA_MIME.test(mimetype) || MEDIA_EXT.test(name)) media.push({ name, path: row.absPath, attrs });
  }

  const bodies = { read: 0, google: 0 };
  if (json.length > 0) {
    for (const file of spread(json, BODY_READS)) {
      const sidecar = isObject(file.attrs.sidecar) ? file.attrs.sidecar : undefined;
      if (sidecar) {
        bodies.read++;
        if (String(sidecar.kind).startsWith('takeout')) bodies.google++;
        continue;
      }
      if (typeof file.attrs.size === 'number' && file.attrs.size > 1024 * 1024) continue;
      const head = await readHead(vfs, access, file.path).catch(() => undefined);
      if (head === undefined) continue;
      bodies.read++;
      if (GOOGLE_KEYS.test(head)) bodies.google++;
    }
  } else {
    // Sidecars paired already lie under their photos, out of the sample: a few photos are asked.
    for (const file of spread(media, BODY_READS)) {
      const sidecar = await readSidecar(vfs, access, file.path).catch(() => undefined);
      if (!sidecar) continue;
      bodies.read++;
      if (sidecar.kind.startsWith('takeout')) bodies.google++;
    }
  }

  const devices: Device[] = [];
  for (const file of spread(media.filter((each) => typeof each.attrs.indexedAt === 'string'), EXIF_READS)) {
    const exif = await vfs.get(access, `${file.path}/metadata/exif`).catch(() => undefined);
    if (!exif) continue;
    const info = (exif.attrs as Record<string, unknown>).deviceinfo;
    const make = isObject(info) && typeof info.make === 'string' && info.make.trim() ? info.make.trim() : undefined;
    const model = isObject(info) && typeof info.model === 'string' && info.model.trim() ? info.model.trim() : undefined;
    devices.push(make || model ? { ...(make ? { make } : {}), ...(model ? { model } : {}) } : null);
  }

  const sizes: string[] = [];
  for (const file of media) {
    const { width, height, mimetype } = file.attrs;
    if (typeof width !== 'number' || typeof height !== 'number' || !String(mimetype).startsWith('image/')) continue;
    sizes.push(`${Math.max(width, height)}x${Math.min(width, height)}`);
  }

  const mimetypes: Record<string, number> = {};
  let files = 0;
  for (const bucket of buckets) {
    mimetypes[bucket.key[0]] = (mimetypes[bucket.key[0]] ?? 0) + bucket.count;
    files += bucket.count;
  }
  return {
    name: basename(root),
    folders: [...folders],
    files: Math.max(files, rows.length),
    mimetypes,
    media: media.map((file) => file.name),
    json: json.map((file) => file.name),
    bodies,
    devices,
    sizes,
  };
};

/**
 * The folders newly arrived in `user`'s default category, newest first, at most `ARRIVALS_MAX`:
 * each folder directly in it but an upload folder, and each folder directly in one of its
 * `UPLOAD_FOLDERS_READ` newest upload folders, leaving out those dismissed (`DETECT_DISMISSED`).
 * `more` is true when there were more.
 */
const arrivals = async (vfs: Vfs, access: Access, user: string): Promise<{ paths: string[]; more: boolean }> => {
  const inbox = categoryPath(user, DEFAULT_CATEGORY);
  if (!(await vfs.exists(access, inbox))) return { paths: [], more: false };
  const top: { name: string; at: number; dismissed: boolean }[] = [];
  let after: string | undefined;
  while (top.length < ARRIVAL_LISTING) {
    const page = await vfs.children(access, inbox, { types: ['directory'], page: { limit: 1000, ...(after !== undefined ? { after } : {}) } });
    top.push(...page.map((entry) => ({ name: entry.name, at: entry.node.props.birthtime.timestamp, dismissed: isDismissed(entry.node.attrs) })));
    if (page.length < 1000) break;
    after = page[page.length - 1].name;
  }
  const found = top.filter((entry) => !isUploadFolder(entry.name) && !entry.dismissed).map((entry) => ({ path: `${inbox}/${entry.name}`, at: entry.at }));
  const uploads = top.filter((entry) => isUploadFolder(entry.name)).map((entry) => entry.name).sort().reverse().slice(0, UPLOAD_FOLDERS_READ);
  for (const upload of uploads) {
    const page = await vfs.children(access, `${inbox}/${upload}`, { types: ['directory'], page: { limit: LISTING_PAGE } });
    found.push(
      ...page.filter((entry) => !isDismissed(entry.node.attrs)).map((entry) => ({ path: `${inbox}/${upload}/${entry.name}`, at: entry.node.props.birthtime.timestamp })),
    );
  }
  found.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path));
  return { paths: found.slice(0, ARRIVALS_MAX).map((entry) => entry.path), more: found.length > ARRIVALS_MAX || top.length >= ARRIVAL_LISTING };
};

/**
 * The category of `categories` a folder at `path` detected as `kind` goes to: the one it lies in
 * when that is of the kind, otherwise the first of the kind; null for none, and for `generic`.
 */
const categoryFor = (categories: CategoryEntry[], path: string, kind: StagingCategoryKind): StagingDetection['category'] => {
  if (kind === 'generic' || kind === 'inbox') return null;
  const place = stagedPlace(path);
  const found = categories.find((category) => category.name === place?.category && category.settings.kind === kind) ??
    categories.find((category) => category.settings.kind === kind);
  return found ? { name: found.name, label: found.settings.label, path: found.path } : null;
};

/**
 * `staging detect`: a detection of each of `paths`, or without any of the folders newly arrived
 * in `user`'s default category (`arrivals`). A staged folder's category is looked for among its
 * owner's categories, any other folder's among `user`'s.
 */
export const detectFolders = async (vfs: Vfs, access: Access, user: string, paths: string[]): Promise<StagingDetectAnswer> => {
  if (paths.length > DETECT_MAX) throw new Error(`detect takes at most ${DETECT_MAX} folders`);
  const arrived = paths.length === 0 ? await arrivals(vfs, access, user) : { paths, more: false };
  const categories = new Map<string, CategoryEntry[]>();
  const detections: StagingDetection[] = [];
  for (const path of arrived.paths) {
    const dismissed = paths.length > 0 && isDismissed((await vfs.get(access, path)).attrs);
    const seen = await gather(vfs, access, path);
    const { kind, confidence, evidence } = classify(seen);
    const owner = parseStagedPath(path)?.user ?? user;
    if (!categories.has(owner)) categories.set(owner, await readCategories(vfs, access, owner).catch(() => []));
    detections.push({
      path,
      dismissed,
      kind,
      confidence,
      evidence,
      category: categoryFor(categories.get(owner)!, path, kind),
      seen: { files: seen.files, sampled: seen.media.length + seen.json.length, folders: seen.folders.length },
    });
  }
  return { user, detections, more: arrived.more };
};
