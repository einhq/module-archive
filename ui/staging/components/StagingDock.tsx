import { ShortcutLegend } from '@ein/ui/components';
import { usePersistedState } from '@ein/ui/hooks';
import { useMemo } from 'react';
import { type LegendContext, legendEntries, type TriageAction, type TriageScope } from '../lib/triage-keys.ts';

type Props = {
  scope: TriageScope;
  context: LegendContext;
  /** Leave out what cannot be done now: a merge with no neighbour. */
  available: (action: TriageAction) => boolean;
  act: (action: TriageAction) => void;
  /** What was just done, and what is next, for a screen reader. */
  announce?: string;
};

/**
 * The foot of the Sort stream: the keys of the scope the cursor is in, each named for what it
 * does to the group on screen, each a button too. "hide" folds it to one chip, which is
 * remembered per viewer.
 */
export function StagingDock({ scope, context, available, act, announce }: Props) {
  const [shown, setShown] = usePersistedState<'shown' | 'hidden'>('staging.legend', 'shown');
  const entries = useMemo(
    () =>
      legendEntries(scope, context).filter((entry) => available(entry.action)).map((entry) => ({ keys: entry.keys, label: entry.label, onClick: () => act(entry.action) })),
    [scope, context, available, act],
  );
  return (
    <ShortcutLegend
      entries={entries}
      hidden={shown === 'hidden'}
      onHiddenChange={(hidden) => setShown(hidden ? 'hidden' : 'shown')}
      announce={announce}
    />
  );
}
