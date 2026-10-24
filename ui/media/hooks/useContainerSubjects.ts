import { useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { ContainerSubjects } from '@archive/media/api';

/** Who and what the media in an album or folder have (`subjects-in`); null while it is asked, or when it could not be. */
export function useContainerSubjects(path: string): { subjects: ContainerSubjects | null; loading: boolean } {
  const [subjects, setSubjects] = useState<ContainerSubjects | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setSubjects(null);
    setLoading(true);
    execCommand<ContainerSubjects>(`subjects-in ${shq(path)}`)
      .then((answer) => !cancelled && setSubjects(answer))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path]);

  return { subjects, loading };
}
