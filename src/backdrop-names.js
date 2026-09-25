/**
 * Backdrop names, kept dependency-free so the router and the link codec can
 * import them without pulling three.js into the entry chunk (the scene side
 * lives in backdrops.js).
 *
 * Append-only: share links bit-pack the index (card-link.js PACK_LAYOUT).
 */
export const BACKDROP_NAMES = Object.freeze(['night', 'blush', 'cream', 'sky', 'mint', 'lavender', 'party']);

/** What a new card starts with (the surprise-party room). Links without the field stay 'night'. */
export const NEW_CARD_BACKDROP = 'party';
