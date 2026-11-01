/**
 * Answer types of the source commands, for the bins that write them and the pages that read
 * them. Import-free.
 */

/** One file a node was read from, as `source-list` answers: a link of the node's `sources/`. */
export type SourceFile = {
  /** The link's name in the node's `sources/`. */
  name: string;
  /** The file the link names. */
  path: string;
  /** Set when the file is gone: a link outlives a file deleted by hand. */
  missing?: true;
  size?: number;
  mimetype?: string;
  /** When the file's bytes were written. */
  writtenAt?: string;
  /** The record of a GEDCOM file the node came from, such as `@I12@`. */
  xref?: string;
};
