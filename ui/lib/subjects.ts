import { subjectArg } from '@ein/ui/lib';

/** A page's one person and one location (its `location` filter), as `search --subject` takes them; undefined for neither. */
export const subjectsOf = (filters?: { person?: string; location?: string }): string[] | undefined => {
  const subjects = [
    ...(filters?.person ? [subjectArg('person', filters.person)] : []),
    ...(filters?.location ? [subjectArg('location', filters.location)] : []),
  ];
  return subjects.length > 0 ? subjects : undefined;
};
