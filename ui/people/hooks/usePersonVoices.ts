import { useCallback, useEffect, useRef, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { PersonVoice, VoiceListResult, VoicePerson } from '@archive/people/api';
export type { PersonVoice } from '@archive/people/api';

type UsePersonVoicesResult = {
  person: VoicePerson | null;
  voices: PersonVoice[];
  total: number;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  /** Remove turns after a confirmed mutation without replacing the scroll box. */
  removeVoices: (paths: string[]) => void;
};

/**
 * Every speech turn assigned to one person.
 *
 * All of them, because the question being asked is whether a cluster really is one person,
 * and a preview cannot answer it. A null path is the idle state and runs nothing, so a modal
 * driven by this only reads while it is open.
 *
 * Sorted longest-first rather than by date: a voice has to be listened to, so the turns worth
 * spending that time on come first.
 */
export function usePersonVoices(personPath: string | null): UsePersonVoicesResult {
  const [person, setPerson] = useState<VoicePerson | null>(null);
  const [voices, setVoices] = useState<PersonVoice[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const loadedPathRef = useRef<string | null>(null);

  const fetchVoices = useCallback(async () => {
    if (!personPath) {
      setPerson(null);
      setVoices([]);
      setTotal(0);
      setError(null);
      loadedPathRef.current = null;
      return;
    }
    const initial = loadedPathRef.current !== personPath;
    try {
      if (initial) setLoading(true);
      setError(null);
      const result = await execCommand<VoiceListResult>(`person-voices ${shq(personPath)}`);
      setPerson(result.person ?? null);
      setVoices(result.voices ?? []);
      setTotal(result.total ?? 0);
      loadedPathRef.current = personPath;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      if (initial) {
        setVoices([]);
        setTotal(0);
      }
    } finally {
      if (initial) setLoading(false);
    }
  }, [personPath]);

  useEffect(() => {
    fetchVoices();
  }, [fetchVoices]);

  const removeVoices = useCallback((paths: string[]) => {
    const removed = new Set(paths);
    setVoices((current) => current.filter((voice) => !removed.has(voice.voicePath)));
    setTotal((current) => Math.max(0, current - removed.size));
    setPerson((value) => value ? { ...value, voiceCount: Math.max(0, value.voiceCount - removed.size) } : value);
  }, []);

  return { person, voices, total, loading, error, refetch: fetchVoices, removeVoices };
}
