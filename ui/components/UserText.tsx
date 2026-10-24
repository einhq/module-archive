import { Box, type MantineFontSize } from '@mantine/core';
import { Markdown } from '@ein/ui/components';
import './user-text.css';

/**
 * Text a person wrote — an event, a description — as Markdown with every line break kept, spaced
 * to sit among the page's other text at `size` (the surrounding size without one).
 */
export function UserText({ text, size }: { text: string; size?: MantineFontSize }) {
  return (
    <Box fz={size}>
      <Markdown className='mrx-user-text' content={text} breaks />
    </Box>
  );
}
