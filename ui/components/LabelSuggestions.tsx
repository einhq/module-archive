import { Alert, Box, Button, Collapse, Group, Loader, Paper, Text } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LabelModelSummary, LabelTrainResult } from '@archive/labels/api';
import { TAGS_ROOT } from '@ein/paths';
import { execCommand } from '@ein/ui/signals';
import { type MediaSelection, useCommand, useLabels, useSearch } from '@ein/ui/hooks';
import { countOf, paramsFromFilters, type SearchKind, shq } from '@ein/ui/lib';
import { SearchResults, SelectionActionButton, TablerIcon } from '@ein/ui/components';
import { labelsChanged } from './NodeLabels.tsx';

type Props = {
  label: string;
  /** The kinds the page shows; undefined for all. */
  kinds?: SearchKind[];
  /** After pictures were given the label, so the page's own list of them can refresh. */
  onLabeled?: () => void;
};

/** How many files one shell call labels or rejects. */
const CHUNK = 50;

/** A training answer that has a model, rather than a reason there is none. */
const hasModel = (result: LabelTrainResult | null): result is LabelModelSummary & { trained: boolean } => result !== null && 'pictures' in result;

/** What the model says about itself, as one line. */
const qualityLine = (model: LabelModelSummary): string => {
  if (model.source === 'vocabulary') return `Suggested from what "${model.prompt}" looks like. Label pictures of it and it learns from them instead.`;
  const from = `Learned from ${countOf(model.pictures, 'picture', 'pictures')} in ${countOf(model.groups, 'labeled file or album', 'labeled files and albums')}`;
  if (!model.measured) return `${from}. Label a few more for it to measure how well it finds them.`;
  return `${from}. Of the labeled pictures held back, it finds ${Math.round(model.measured.recall * 100)}% again.`;
};

/**
 * "Looks like <label>": the pictures and albums the label's model ranks highest that do not carry
 * it yet, from `search --like /archive/tags/<label>`, under a one-line bar that says how many the
 * kept model would add (`label-model show`), when it is a word's or measured as learnable. The bar opens on its own for a label nothing carries
 * yet, a vocabulary word, since then the suggestions are all there is; otherwise it waits to be
 * opened. Opening retrains the model when the label changed since (`label-model train
 * --if-stale`). Selected pictures, and each album from its card, can be given the label, or marked
 * as not it, which the next training learns from.
 */
export function LabelSuggestions({ label, kinds, onLabeled }: Props) {
  const navigate = useNavigate();
  const { labels, loading: labelsLoading } = useLabels();
  const kept = useCommand<LabelModelSummary>(`label-model show ${shq(label)}`);
  const [chosenOpen, setChosenOpen] = useState<boolean | null>(null);
  const open = chosenOpen ?? (!labelsLoading && !labels.some((entry) => entry.label === label));
  const [model, setModel] = useState<LabelTrainResult | null>(null);
  const [training, setTraining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAnyway, setShowAnyway] = useState(false);
  const like = `${TAGS_ROOT}/${label}`;

  const retrain = useCallback(async () => {
    setTraining(true);
    setError(null);
    try {
      const [result] = await execCommand<LabelTrainResult[]>(`label-model train ${shq(label)} --if-stale`);
      setModel(result ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTraining(false);
    }
  }, [label]);

  useEffect(() => {
    setModel(null);
    setShowAnyway(false);
    if (open) void retrain();
  }, [retrain, open]);

  const known = hasModel(model) ? model : null;
  const summary = known ?? kept.data;
  // Counted only for a model whose suggestions are offered on their own: a word's, or one that measured as learnable.
  const counted = summary && summary.matches > 0 && (summary.learnable || summary.source === 'vocabulary');
  const adds = counted ? `${summary.matches}${summary.matchesCapped ? '+' : ''} more look like it` : null;
  const offered = known !== null && (known.learnable || known.reason === 'too-few-examples' || showAnyway);
  const results = useSearch({ like, kinds, limit: 60, enabled: offered && !training });

  /**
   * Runs `command` over `paths` a chunk at a time, then refreshes the suggestions and the model.
   * Resolves false, with the error shown, when a chunk fails.
   */
  const act = async (paths: string[], command: (paths: string[]) => string): Promise<boolean> => {
    setError(null);
    try {
      for (let i = 0; i < paths.length; i += CHUNK) await execCommand(command(paths.slice(i, i + CHUNK)));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      results.reload();
      void retrain();
    }
  };
  const labelPaths = async (paths: string[]) => {
    if (!await act(paths, (chunk) => chunk.map((path) => `label add ${shq(path)} ${shq(label)}`).join(' && '))) return;
    labelsChanged();
    onLabeled?.();
  };
  const rejectPaths = async (paths: string[]) => {
    await act(paths, (chunk) => `label-model reject ${shq(label)} ${chunk.map(shq).join(' ')}`);
  };
  const onSelection = (selection: MediaSelection, run: (paths: string[]) => Promise<void>) => run(selection.paths).then(() => selection.clear());

  return (
    <Paper withBorder radius='md' p='sm'>
      <Group justify='space-between' align='center' wrap='nowrap'>
        <Group gap='xs' wrap='nowrap' style={{ minWidth: 0 }}>
          <TablerIcon name='sparkles' size={16} color='var(--mantine-color-dimmed)' style={{ flexShrink: 0 }} />
          <Text size='sm' fw={600} truncate>Looks like {label}</Text>
          {adds && <Text size='sm' c='dimmed' truncate>{adds}</Text>}
        </Group>
        <Group gap='xs' wrap='nowrap'>
          {open && offered && (
            <Button
              variant='subtle'
              size='xs'
              rightSection={<TablerIcon name='arrow-right' size={14} />}
              onClick={() => navigate(`/media?${paramsFromFilters({ like })}`)}
            >
              Show all
            </Button>
          )}
          <Button
            variant='light'
            size='xs'
            rightSection={<TablerIcon name={open ? 'chevron-up' : 'chevron-down'} size={14} />}
            onClick={() => setChosenOpen(!open)}
          >
            {open ? 'Hide' : 'Show'}
          </Button>
        </Group>
      </Group>

      <Collapse expanded={open}>
        <Box pt='sm'>
          {error && <Alert color='red' mb='md'>{error}</Alert>}
          {training && !known && (
            <Group gap='xs' mb='md'>
              <Loader size='xs' />
              <Text size='sm' c='dimmed'>Learning what {label} looks like…</Text>
            </Group>
          )}
          {model && !known && <Text size='sm' c='dimmed'>Nothing with this label has a picture to learn from.</Text>}
          {known && (
            <Text size='sm' c='dimmed' mb='md'>
              {qualityLine(known)}
              {training && ' Relearning…'}
            </Text>
          )}
          {known?.reason === 'not-visual' && !showAnyway && (
            <Alert color='gray' mb='md'>
              <Text size='sm' mb='xs'>
                The pictures held back were not found again, so what this label names does not seem to show in the pictures: a person, a trip or a time rather than something
                seen.
              </Text>
              <Button size='xs' variant='light' onClick={() => setShowAnyway(true)}>Show what it would suggest</Button>
            </Alert>
          )}

          {offered && (
            <SearchResults
              search={results}
              emptyMessage={`Nothing else looks like ${label}`}
              selectionActions={({ selection }) => (
                <>
                  <SelectionActionButton icon={<TablerIcon name='tag' size={14} />} onClick={() => onSelection(selection, labelPaths)}>
                    Label {label}
                  </SelectionActionButton>
                  <SelectionActionButton icon={<TablerIcon name='tag-off' size={14} />} onClick={() => onSelection(selection, rejectPaths)}>
                    Not {label}
                  </SelectionActionButton>
                </>
              )}
              cardActions={(result) =>
                result.kind === 'album' && <AlbumActions label={label} onLabel={() => labelPaths([result.path])} onReject={() => rejectPaths([result.path])} />}
            />
          )}
        </Box>
      </Collapse>
    </Paper>
  );
}

/** A suggested album's own Label and Not, busy while its command runs. */
function AlbumActions({ label, onLabel, onReject }: { label: string; onLabel: () => Promise<void>; onReject: () => Promise<void> }) {
  const [busy, setBusy] = useState<'label' | 'reject' | null>(null);
  const run = (which: 'label' | 'reject', action: () => Promise<void>) => {
    setBusy(which);
    void action().then(() => setBusy(null));
  };

  return (
    <>
      <Button
        size='compact-xs'
        variant='light'
        leftSection={<TablerIcon name='tag' size={12} />}
        loading={busy === 'label'}
        disabled={busy !== null}
        onClick={() => run('label', onLabel)}
      >
        Label
      </Button>
      <Button
        size='compact-xs'
        variant='subtle'
        color='gray'
        leftSection={<TablerIcon name='tag-off' size={12} />}
        loading={busy === 'reject'}
        disabled={busy !== null}
        onClick={() => run('reject', onReject)}
      >
        Not {label}
      </Button>
    </>
  );
}
