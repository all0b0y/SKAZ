/** Local invalidation only. No material content or identifiers go into browser storage or events. */
export const TOPICS_CHANGED = 'kb:topics-changed';
export const notifyTopicsChanged = () => window.dispatchEvent(new Event(TOPICS_CHANGED));
