import { Anchor, Badge, Group, TagsInput } from '@mantine/core';
import { signal } from '@preact/signals-react';
import { useSignals } from '@preact/signals-react/runtime';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLabels } from '@ein/ui/hooks';
import { paramsFromFilters, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';

/** Bumped by whatever labels nodes, so a shown node's labels are read again. */
const labelsVersion = signal(0);

/** Say that labels changed outside a `NodeLabels`, such as a selection labeled from its bar. */
export const labelsChanged = () => {
  labelsVersion.value++;
};

/** A label is one word: `label` refuses whitespace and slashes, so typed text splits into words. */
export const labelWords = (raw: string): string[] => raw.split(/[\s,]+/).map((word) => word.replace(/\//g, '-')).filter(Boolean);

/** A node's labels, read again whenever `labelsChanged` is said. */
function useNodeLabels(path: string): string[] {
  useSignals();
  const version = labelsVersion.value;
  const [labels, setLabels] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    execCommand<string[]>(`label list ${shq(path)}`)
      .then((list) => !cancelled && setLabels(list ?? []))
      .catch(() => !cancelled && setLabels([]));
    return () => {
      cancelled = true;
    };
  }, [path, version]);

  return labels;
}

type Props = {
  /** The labeled node: an album, a person, a location, a device or a file. */
  path: string;
  /** Space above the row, as the other lines of a header's meta keep. */
  mt?: number;
};

/**
 * A node's labels as tags, each opening the label's page. They are changed in the node's edit
 * dialog, through `LabelsField`. The tags are opaque and outlined, so they read on a header's
 * coloured pattern. Nothing is drawn for a node without labels.
 */
export function NodeLabels({ path, mt }: Props) {
  const labels = useNodeLabels(path);
  if (labels.length === 0) return null;

  return (
    <Group gap={6} mt={mt} wrap='wrap' style={{ minWidth: 0 }} aria-label='Labels'>
      {labels.map((label) => (
        <Badge key={label} variant='default' tt='none' fw={500}>
          <Anchor component={Link} to={`/search?${paramsFromFilters({ tags: [label] })}`} size='xs' fw={500} c='inherit' underline='hover'>
            {label}
          </Anchor>
        </Badge>
      ))}
    </Group>
  );
}

type LabelsDraft = {
  value: string[];
  /** Whether the draft differs from the node's labels. */
  changed: boolean;
  onChange: (labels: string[]) => void;
  /** Adds and removes what the draft changed, with `label`, and says so through `labelsChanged`. */
  save: () => Promise<void>;
};

/**
 * A node's labels as an edit dialog's draft: read each time the dialog opens, written by `save`
 * as the dialog's other fields are.
 */
export function useLabelsDraft(path: string, opened: boolean): LabelsDraft {
  const [saved, setSaved] = useState<string[]>([]);
  const [value, setValue] = useState<string[]>([]);

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    setSaved([]);
    setValue([]);
    execCommand<string[]>(`label list ${shq(path)}`)
      .then((list) => {
        if (cancelled) return;
        setSaved(list ?? []);
        setValue(list ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, opened]);

  const added = value.filter((label) => !saved.includes(label));
  const removed = saved.filter((label) => !value.includes(label));
  const save = async () => {
    if (added.length > 0) await execCommand(`label add ${shq(path)} ${added.map(shq).join(' ')}`);
    if (removed.length > 0) await execCommand(`label remove ${shq(path)} ${removed.map(shq).join(' ')}`);
    if (added.length > 0 || removed.length > 0) labelsChanged();
  };

  const onChange = useCallback((next: string[]) => setValue([...new Set(next.flatMap(labelWords))]), []);

  return { value, changed: added.length > 0 || removed.length > 0, onChange, save };
}

/** An edit dialog's labels field, with the labels already in use offered as completions. */
export function LabelsField({ draft }: { draft: LabelsDraft }) {
  const { labels: known } = useLabels();
  return (
    <TagsInput
      label='Labels'
      description='Pick a label in use or type a new one. A space starts the next label.'
      placeholder='e.g. sailing'
      data={known.map((entry) => entry.label)}
      value={draft.value}
      onChange={draft.onChange}
      splitChars={[',', ' ']}
      clearable
    />
  );
}
