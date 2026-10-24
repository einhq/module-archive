/**
 * When two files are one picture or recording in other bytes, and when they are two shots
 * (`@archive/media/near-duplicates`): the likeness floor, the capture-time rules that tell a
 * burst's frames apart, the keyframe vote, recordings by chromaprint and length, and ranking with
 * the hub guard.
 */
import {
  cosine,
  displaySize,
  keyframeVote,
  lengthWindow,
  NEAR,
  type NearFacts,
  nearPictures,
  nearRecordings,
  nearVideos,
  parseVector,
  rankPeers,
  sameLength,
} from '@archive/media/near-duplicates';
import { assertAlmostEquals, assertEquals } from '@std/assert';

const photo = (id: string, facts: Partial<NearFacts> = {}): NearFacts => ({
  id,
  mimetype: 'image/jpeg',
  width: 4000,
  height: 3000,
  takenAtUtc: '2021-07-04T10:15:30Z',
  takenAtSource: 'device',
  device: '/devices/camera-a',
  ...facts,
});

Deno.test('a downscaled re-encode is one picture; another photo of the scene is not', () => {
  const original = photo('a');
  const smaller = photo('b', { width: 2000, height: 1500 });
  assertEquals(nearPictures(original, smaller, 0.97), true);
  assertEquals(nearPictures(original, smaller, NEAR.image), true, 'the floor is inclusive');
  assertEquals(nearPictures(original, smaller, 0.74), false);
});

Deno.test('a crop is judged by its likeness, whatever its shape', () => {
  assertEquals(nearPictures(photo('a'), photo('b', { width: 3000, height: 3000 }), 0.88), true);
  assertEquals(nearPictures(photo('a'), photo('b', { width: 1200, height: 1600 }), 0.6), false);
});

Deno.test('capture times a second or more apart from one kind of clock are two shots', () => {
  const later = photo('b', { takenAtUtc: '2021-07-04T10:15:32Z' });
  assertEquals(nearPictures(photo('a'), later, 0.99), false);
  // GPS against the camera's clock: not compared, as two clocks may disagree.
  assertEquals(nearPictures(photo('a'), photo('b', { takenAtUtc: '2021-07-04T10:15:32Z', takenAtSource: 'gps', width: 2000, height: 1500 }), 0.9), true);
  // A copy that lost its time (an app's re-save named by date) is still one picture.
  assertEquals(nearPictures(photo('a'), photo('b', { takenAtSource: 'name', takenAtUtc: '2021-07-04T00:00:00Z', width: 1600, height: 1200 }), 0.9), true);
});

Deno.test('frames of one size from one camera in one second are two shots unless as alike as a re-save', () => {
  const frame = photo('b');
  assertEquals(nearPictures(photo('a'), frame, 0.9), false, 'no sub-second time: only a re-save passes');
  assertEquals(nearPictures(photo('a'), frame, 0.97), true);
  assertEquals(nearPictures(photo('a', { subSecond: '21' }), photo('b', { subSecond: '48' }), 0.99), false, 'different sub-seconds: a burst');
  assertEquals(nearPictures(photo('a', { subSecond: '21' }), photo('b', { subSecond: '21' }), 0.97), true, 'a re-save keeps the sub-second');
  assertEquals(nearPictures(photo('a'), photo('b', { device: '/devices/camera-b' }), 0.9), true, 'two cameras: no burst');
});

Deno.test('a video is alike another when most keyframes match and the lengths agree', () => {
  // Eight keyframes, each unlike the others; the other video has some of them, and the rest turned away.
  const frames = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => (i === j ? 1 : 0)));
  const away = (frame: number[]) => frame.map((value) => -value);
  const seven = [...frames.slice(0, 7), away(frames[7])];
  const five = [...frames.slice(0, 5), ...frames.slice(5).map(away)];
  assertEquals(keyframeVote(frames, seven).share >= NEAR.keyframeShare, true, '7 of 8');
  assertEquals(keyframeVote(frames, five).share >= NEAR.keyframeShare, false, '5 of 8');
  const clip = { id: 'v', mimetype: 'video/mp4', duration: 60 };
  assertEquals(nearVideos(clip, { ...clip, id: 'w', duration: 60.8 }, keyframeVote(frames, seven)), true);
  assertEquals(nearVideos(clip, { ...clip, id: 'w', duration: 67 }, keyframeVote(frames, seven)), false, 'seven seconds more: another cut');
  assertEquals([sameLength(100, 101.9), sameLength(100, 103), sameLength(undefined, 3)], [true, false, true]);
});

Deno.test('a recording is alike another when the chromaprints match and the lengths agree', () => {
  const memo = (id: string, facts: Partial<NearFacts> = {}): NearFacts => ({ id, mimetype: 'audio/mp4', duration: 37, ...facts });
  assertEquals(nearRecordings(memo('a'), memo('b', { duration: 37.6 }), 0.9), true);
  assertEquals(nearRecordings(memo('a'), memo('b'), NEAR.audio), true, 'the floor is inclusive');
  assertEquals(nearRecordings(memo('a'), memo('b'), 0.69), false);
  assertEquals(nearRecordings(memo('a'), memo('b', { duration: 42 }), 0.95), false, 'five seconds more is another recording');
  const timed = { takenAtSource: 'device', takenAtUtc: '2021-07-04T10:15:30Z' };
  assertEquals(nearRecordings(memo('a', timed), memo('b', { ...timed, takenAtUtc: '2021-07-04T10:20:00Z' }), 0.95), false, 'recorded at two moments');
});

Deno.test('the lengths a recording is compared with are those sameLength allows, both ways', () => {
  for (const duration of [3, 37, 50, 600]) {
    const { from, to } = lengthWindow(duration);
    assertEquals([sameLength(duration, from + 1e-9), sameLength(duration, to - 1e-9)], [true, true], `${duration} s`);
    assertEquals([sameLength(duration, from - 0.01), sameLength(duration, to + 0.01)], [false, false], `${duration} s`);
  }
});

Deno.test('look-alikes rank by likeness then id, at most 29; thirty or more make a hub', () => {
  const matches = Array.from({ length: 29 }, (_, i) => ({ id: `id${String(i).padStart(2, '0')}`, score: 0.8 }));
  const ranked = rankPeers([{ id: 'zz', score: 0.99 }, ...matches.slice(0, 28)]);
  assertEquals([ranked.hub, ranked.peers.length, ranked.peers[0].id, ranked.peers[1].id], [false, 29, 'zz', 'id00']);
  assertEquals(rankPeers([...matches, { id: 'last', score: 0.9 }]), { peers: [], hub: true });
});

Deno.test('vectors, cosines and display sizes', () => {
  assertEquals(parseVector(new TextEncoder().encode('[0.5,-0.25,1]')), [0.5, -0.25, 1]);
  assertEquals(parseVector(new TextEncoder().encode('not a vector')), undefined);
  assertAlmostEquals(cosine([1, 0], [1, 1]), Math.SQRT1_2);
  assertEquals(cosine([0, 0], [1, 1]), 0);
  assertEquals(displaySize(4000, 3000, 90), { width: 3000, height: 4000 });
  assertEquals(displaySize(4000, 3000, 0), { width: 4000, height: 3000 });
});
