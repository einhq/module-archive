export const PERSON_GENDERS = ['male', 'female', 'other', 'unknown'] as const;
export type PersonGender = typeof PERSON_GENDERS[number];

export type PersonContact = {
  type: string;
  data: string;
};

export type PersonAttrs = {
  name: string;
  fullname?: string | null;
  birthname?: string | null;
  description?: string | null;
  gender?: PersonGender | null;
  /** ISO date YYYY[-MM[-DD]] */
  born?: string | null;
  /** ISO date YYYY[-MM[-DD]] */
  died?: string | null;
  contact?: PersonContact[] | null;
  /** free-text allergy notes */
  allergies?: string | null;
};

export const NODE_TYPE_PERSON = 'person';
