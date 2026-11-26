import { shq } from '@ein/ui/lib';
import { notify } from '@ein/ui/signals';
import { DETACH_CHUNK } from './person-detach.ts';

/**
 * What `person-merge` and `person-detach --to` say of the faces they left where they were: their
 * photos were taken before the person was born (ein/core#1587).
 */
export type BeforeBirth = { beforeBirth?: string[]; born?: string | null };

/** `execCommand`, taken as a parameter as `person-detach.ts` does. */
type Exec = <T>(command: string) => Promise<T>;

/**
 * Say that faces stayed off a person because their photos are older than the person, and offer to
 * move them all the same: a birth date or a photo's date can be the wrong one. Nothing when every
 * face moved. `onMoved` runs once they have, so the page can show it.
 */
export function noticeBeforeBirth(exec: Exec, stayed: BeforeBirth, person: { path: string; name?: string }, onMoved?: () => void): void {
  const paths = stayed.beforeBirth ?? [];
  if (paths.length === 0) return;
  const who = person.name || 'this person';
  const born = stayed.born ? ` (${stayed.born.split('T')[0]})` : '';
  const what = paths.length === 1 ? '1 face stayed: its photo was' : `${paths.length} faces stayed: their photos were`;
  const moveAnyway = async () => {
    try {
      for (let i = 0; i < paths.length; i += DETACH_CHUNK) {
        await exec(`person-detach --before-birth --to ${shq(person.path)} ${paths.slice(i, i + DETACH_CHUNK).map(shq).join(' ')}`);
      }
      onMoved?.();
    } catch (err) {
      notify({ message: err instanceof Error ? err.message : String(err), color: 'red' });
    }
  };
  notify({
    message: `${what} taken before ${who} was born${born}`,
    color: 'yellow',
    action: { label: 'Move anyway', onClick: () => void moveAnyway() },
  });
}
