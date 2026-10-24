import type { PersonFace } from '../hooks/usePersonFaces.ts';

/** A fully successful face mutation that can be reconciled without a refetch. */
export type AppliedFaceChange = {
  removedFaces: PersonFace[];
  created: Array<{
    person: { id: string; path: string; name: string };
    faces: PersonFace[];
  }>;
};
