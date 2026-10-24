// `@archive/media/face-crop`'s FACE_CROP_NAME is the authority.
export const FACE_CROP_NAME = 'image.avif';

/**
 * "3 faces", "1 tag", "2 faces and 1 tag": a region is a face only when it has a vector, and the
 * UI says so — a tag is a box a human drew, or a face too poor to take part in recognition.
 */
export const regionCount = (faces: number, tags: number): string => {
  const part = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (tags === 0) return part(faces, 'face', 'faces');
  if (faces === 0) return part(tags, 'tag', 'tags');
  return `${part(faces, 'face', 'faces')} and ${part(tags, 'tag', 'tags')}`;
};
