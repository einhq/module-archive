/**
 * Album node type: a collection of media.
 *
 * Behaves as a directory: it holds its files, and links the ones added to it
 * from elsewhere (`album add`) as softlink children, beside its cover and its neighbours in a
 * series (`album set <path> previous|next <album>`).
 */

type NodeType = string;

export const NODE_TYPE_ALBUM: NodeType = 'album';

/**
 * The cover image is a softlink child by this name pointing at a media node, not a string attr; the
 * albums before and after it in a series are softlink children too. None of them is a member.
 */
export { COVER_LINK_NAME, NEXT_LINK_NAME, NON_MEMBER_LINK_NAMES, PREVIOUS_LINK_NAME } from '@ein/paths';
