/**
 * Whether an album is somebody's doing or EiN's: the clusterer marks its
 * suggestions `attrs.origin = 'auto'`.
 */
export const isSuggestedAlbum = (origin: string | undefined): boolean => origin === 'auto';
