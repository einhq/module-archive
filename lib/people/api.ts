/**
 * What the people area's commands answer with under `JSON_OUTPUT=1`, as types.
 *
 * The command API's other half: the UI and other modules import these (`@archive/people/api`) instead of
 * restating the shapes, and each command checks its answer against them. Imports only other
 * type-only files, so a browser can import it without type-checking the module.
 */

import type { TimelineEntry } from '@archive/timeline/api';
import type { NodeOwnership } from '@ein/api';

export type PersonFace = {
  /** The region. Its crop is `<facePath>/image.avif`; a row does not repeat it, since a page is held under a byte budget. */
  facePath: string;
  /** A detected face with a vector; false for a box a human drew or an import carried (a tag). */
  hasFace: boolean;
  /** The photo the face was cut from; absent when the face sits somewhere unexpected. */
  filePath?: string;
  fileId?: string;
  takenAt?: string;
  /** The photo's type and stored size, for opening it in the lightbox. */
  mimetype?: string;
  width?: number;
  height?: number;
  angle?: number;
  /** The crop's own pixel size, so the grid lays it out before it loads. */
  cropWidth?: number;
  cropHeight?: number;
  /** Head pose in degrees: `yaw` left/right, `pitch` up/down, `roll` tilt; all 0 faces the camera. */
  pose?: { pitch: number; yaw: number; roll: number };
  confidence: number;
  personSource?: string;
  /** Set when `face-audit` found another person's named face nearer than this person's own. */
  doubt?: FaceDoubtView;
};

/** Who a doubtful face looks like, and how much more than its own person. */
export type FaceDoubtView = {
  likePersonId: string;
  likeName: string;
  /** Absent when the person cannot be reached. */
  likePath?: string;
  /** Cosine similarity to the other person's nearest named face. */
  similarity: number;
  /** Cosine similarity to this person's nearest named face. */
  ownSimilarity: number;
};

export type FacePerson = {
  id: string;
  path: string;
  name: string;
  unnamed: boolean;
  faceCount: number;
};

export type FaceListResult = {
  person: FacePerson;
  /** Faces in the list asked for: all of the person's, or only the doubtful ones. */
  total: number;
  /** The person's faces that carry a doubt, whichever list was asked for. */
  doubtful: number;
  offset: number;
  /** Where the next page starts; absent on the last one. */
  nextOffset?: number;
  faces: PersonFace[];
};

/** One voice of a recording that is the person: its speaker node, and its longest turn to play. */
export type PersonVoice = {
  voicePath: string;
  /** The recording this was heard in; absent when the node sits somewhere unexpected. */
  filePath?: string;
  fileId?: string;
  start: number;
  end: number;
  /** How long the person speaks in the recording, and in how many turns. */
  talkSeconds: number;
  turnCount: number;
  speaker?: string;
  personSource?: string;
  takenAt?: string;
  /** The recording's kind (`audio/…`, `video/…`), so a player knows which rendition to fetch. */
  mimetype?: string;
};

export type VoicePerson = {
  id: string;
  path: string;
  name: string;
  unnamed: boolean;
  voiceCount: number;
  /** Recordings the person is heard in, which is the number worth showing. */
  recordingCount: number;
};

export type VoiceListResult = { person: VoicePerson; total: number; offset: number; voices: PersonVoice[] };

export type UnknownFaceThumb = {
  /** The region; its crop is the child `image.avif`, and may be absent. */
  facePath: string;
  fileId?: string;
  confidence: number;
};

export type UnknownPerson = {
  id: string;
  path: string;
  name: string;
  faceCount: number;
  /** Recordings the person is heard in: a person found by voice may have no face at all. */
  voiceCount: number;
  createdAt?: string;
  faces: UnknownFaceThumb[];
  /** The recordings they speak longest in, as many as faces were asked for, each with its sample. */
  voices: UnknownVoiceThumb[];
};

/** A voice on a card: the recording, its longest turn to play, and the recording's kind. */
export type UnknownVoiceThumb = { voicePath: string; filePath?: string; start: number; end: number; mimetype?: string };

/** `total` counts every match of the filter; `nextOffset` is absent on the last page. */
export type UnknownListResult = { total: number; offset: number; nextOffset?: number; people: UnknownPerson[] };

/** `person-discard`: the people removed, with how many regions and voices each one let go. */
export type DiscardResult = {
  ok: boolean;
  discarded: { path: string; regions: number; voices: number }[];
  failed: { person: string; error: string }[];
  dryRun: boolean;
};

/** One way of reaching a person — an address, a phone number, a handle. */
export type PersonContact = { type: string; data: string };

/**
 * Completed years, and whether that is the age they reached.
 *
 * `approx` is set when the birth date has no day, where the count can be off by
 * one — a header showing it should say so rather than assert a number it
 * guessed.
 */
type PersonAge = { years: number; approx: boolean; atDeath: boolean };

/** A parent, partner or child. `role` is already gender-resolved by the server. */
type PersonRelation = { role: string; path: string; name?: string; kind?: string; from?: string; to?: string };

/** A location they lived, and when. An open `to` is where they live now. */
export type PersonHome = { path: string; name?: string; from?: string; to?: string };

type PersonEvent = { name: string; eventType: string; date?: string; position?: string; description?: string };

/** `person-add-event`: the event file it wrote, under a name it chose when given none. */
export type PersonAddEventAnswer = { ok: true; path: string };

/** One named person as `person-list` answers: who, and how much of the archive shows them. */
export type PersonListEntry = {
  /** The directory name under `/people` — the route param. */
  id: string;
  path: string;
  name: string;
  fullname?: string;
  born?: string;
  died?: string;
  /** Faces and voice turns assigned to the person: how often the archive shows or hears them. */
  holdings: number;
};

/** Everything `person-info` knows about one person. */
export type PersonInfo = {
  /** The directory name under `/people` — the route param. */
  path: string;
  name: string;
  fullname?: string;
  birthname?: string;
  gender?: string;
  born?: string;
  died?: string;
  age?: PersonAge;
  contact?: PersonContact[];
  allergies?: string;
  description?: string;
  relations: PersonRelation[];
  homes: PersonHome[];
  events: PersonEvent[];
  /** Mode and owner of the person node, for deciding what to offer editing on. */
  ownership: NodeOwnership;
};

export type FamilyNode = {
  path: string;
  name: string;
  fullname?: string;
  gender?: string;
  born?: string;
  died?: string;
  /** Drawn parents — always a subset of `parentCount`. */
  parents: string[];
  children: string[];
  partners: FamilyPartner[];
  /** Every parent, including the ones outside the slice. */
  parentCount: number;
  childCount: number;
};

export type GraphResponse = { root: string; nodes: Record<string, FamilyNode> };

/** One partner tie, as the graph reports it. */
type FamilyPartner = { path: string; kind?: string; from?: string; to?: string };

/** `person-timeline`: one life as the corpus-wide `timeline` would show it. */
export type PersonTimeline = {
  /** The person's path. */
  person: string;
  name: string;
  entries: TimelineEntry[];
};

/** `location-timeline`: what happened at one location, in the same entries. */
export type LocationTimeline = {
  /** The location's path. */
  location: string;
  name: string;
  entries: TimelineEntry[];
};

/** The life events `person-stats` counts, as the stats page names its series. */
export const LIFE_EVENT_KINDS = ['births', 'engagements', 'marriages', 'deaths'] as const;
export type LifeEventKind = typeof LIFE_EVENT_KINDS[number];

/** `person-stats`: life events folded into calendar months across every year. */
export type LifeEventStats = {
  months: Array<{ month: number } & Record<LifeEventKind, number>>;
  totals: Record<LifeEventKind, number>;
  /** Events dated only to the year: counted in the totals, in no month. */
  withoutMonth: Record<LifeEventKind, number>;
};
