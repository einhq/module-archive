import { TablerIcon } from '@ein/ui/components';
import { Box, Center, Stack, Text, ThemeIcon, Timeline } from '@mantine/core';
import { MoreLoader, PageLoader } from '@ein/ui/components';
import { type CSSProperties, useEffect, useRef } from 'react';
import { useHeaderHeight } from '@ein/ui/hooks';
import type { TimelineGroup, TimelineKind } from '../lib/timeline-entries.ts';
import { KIND_STYLE, spanLabel, TimelineEntryCard } from './TimelineEntryCard.tsx';

/**
 * Row geometry — the date gutter, where the connector line runs, and centring
 * the columns as a group — is in the stylesheet under these classes, because it
 * lands on a ::before that neither the theme object nor a `style` prop can
 * reach.
 */
const TIMELINE_CLASSES = { root: 'mrx-timeline', item: 'mrx-timeline-row' } as const;

/** Published to CSS as `--mrx-bullet` so the geometry has one source, not two. */
const BULLET_SIZE = 26;
const GROUP_VARS = { '--mrx-bullet': `${BULLET_SIZE}px` } as CSSProperties;

function KindBullet({ kind }: { kind: TimelineKind }) {
  const { icon, color } = KIND_STYLE[kind];
  return (
    <ThemeIcon size={22} radius='xl' variant='light' color={color}>
      <TablerIcon name={icon} size={13} />
    </ThemeIcon>
  );
}

type TimelineFeedProps = {
  groups: TimelineGroup[];
  loading: boolean;
  /** Paging: a feed read whole, like one year, passes none of these four. */
  hasMore?: boolean;
  sentinelRef?: (node: HTMLElement | null) => void;
  hasNewer?: boolean;
  topSentinelRef?: (node: HTMLElement | null) => void;
  /** Called with the `YYYY-MM` of the group currently at the top of the viewport. */
  onTopGroupChange?: (key: string) => void;
  /** Exposes loaded group geometry to the shared scrubber without owning it here. */
  onGroupNode?: (key: string, node: HTMLElement | null) => void;
  /** What an empty feed says. The corpus-wide default is wrong for one person's life. */
  emptyMessage?: string;
};

/**
 * The feed itself: month headers, and one Mantine `Timeline` per month.
 *
 * One `Timeline` per group rather than a single long one with headers inside it.
 * Mantine clones every direct child of a `Timeline` with `__align`, `__active`
 * and `__lineActive`, which land on the DOM as unknown attributes for anything
 * that is not a `Timeline.Item` — so a header cannot live there. `active` stays
 * at its default of -1: nothing in a chronology is "the current step".
 */
export function TimelineFeed({ groups, loading, hasMore, sentinelRef, hasNewer, topSentinelRef, onTopGroupChange, onGroupNode, emptyMessage }: TimelineFeedProps) {
  const headersRef = useRef(new Map<string, HTMLElement>());
  const headerHeight = useHeaderHeight();

  // Which month the reader is looking at, for the scrubber's marker. The bottom
  // margin keeps the "topmost visible" answer from flipping to a header that has
  // only just entered from below.
  useEffect(() => {
    if (!onTopGroupChange) return;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      const key = visible?.target.getAttribute('data-month');
      if (key) onTopGroupChange(key);
    }, { rootMargin: `-${headerHeight}px 0px -85% 0px` });

    for (const node of headersRef.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [groups, onTopGroupChange, headerHeight]);

  return (
    <Stack gap='xl' className='mrx-timeline-feed'>
      {
        /* Above the first entry: crossing it loads the page before this one and
          holds the scroll position, so climbing back towards the present works
          the same way as scrolling into the past. */
      }
      {hasNewer && <Box ref={topSentinelRef} h={1} />}

      {groups.map((group) => (
        <Box
          key={group.key}
          className='mrx-timeline-group'
          style={GROUP_VARS}
          ref={(node: HTMLDivElement | null) => onGroupNode?.(group.key, node)}
        >
          <Box
            className='mrx-timeline-heading'
            data-month={group.key}
            ref={(node: HTMLDivElement | null) => {
              if (node) headersRef.current.set(group.key, node);
              else headersRef.current.delete(group.key);
            }}
            mb='sm'
            py={4}
            style={{
              position: 'sticky',
              top: headerHeight,
              zIndex: 2,
              backgroundColor: 'var(--mrx-surface-base)',
            }}
          >
            <Text fw={600} size='sm' c='dimmed' tt='uppercase' lts={0.5}>
              {group.label}
            </Text>
          </Box>

          <Timeline bulletSize={BULLET_SIZE} lineWidth={2} color='marine' classNames={TIMELINE_CLASSES}>
            {group.entries.map((entry) => (
              <Timeline.Item
                key={entry.key}
                // Read back by the hook after a prepend: it holds the reader's
                // location by re-finding the row that was at the top.
                data-entry-key={entry.key}
                opposite={<Text size='xs' c='dimmed'>{spanLabel(entry)}</Text>}
                bullet={<KindBullet kind={entry.kind} />}
              >
                <TimelineEntryCard entry={entry} />
              </Timeline.Item>
            ))}
          </Timeline>
        </Box>
      ))}

      {hasMore && <Box ref={sentinelRef} h={1} />}

      {loading && (groups.length === 0 ? <PageLoader /> : <MoreLoader />)}

      {!loading && groups.length === 0 && (
        <Center py='xl'>
          <Text c='dimmed' size='sm'>{emptyMessage ?? 'Nothing here yet. Albums appear once their media has been indexed.'}</Text>
        </Center>
      )}
    </Stack>
  );
}
