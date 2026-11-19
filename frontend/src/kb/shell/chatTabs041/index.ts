import './chatTabs.css';

export {
  DEFAULT_BOTTOM_THRESHOLD,
  DEFAULT_MESSAGE_ID_ATTR,
  DEFAULT_MESSAGE_SELECTOR,
  DEFAULT_READING_LINE_PX,
  captureReadingAnchor,
  clampScrollTop,
  createAnchorScope,
  isAtBottom,
  maxScrollTop,
  restoreReadingAnchor,
  type AnchorCaptureOptions,
  type AnchorRestoreOptions,
  type AnchorRestoreResult,
  type AnchorScope,
  type ReadingAnchor,
} from './readingAnchor';

export {
  adjacentSelection,
  createChatTabsStore,
  type AdjacentSelection,
  type ChatTabsActions,
  type ChatTabsData,
  type ChatTabsInitial,
  type ChatTabsStore,
  type CloseResult,
} from './tabsStore';

export {
  useScopedReadingAnchor,
  type ScopedReadingAnchorHandle,
  type UseScopedReadingAnchorOptions,
} from './useScopedReadingAnchor';

export {
  ChatTabStrip,
  ensureTabVisible,
  measureTabOverflow,
  type ChatTabItem,
  type ChatTabStripProps,
  type TabOverflowState,
} from './ChatTabStrip';

export {
  ChatTabsEmptyState,
  type ChatTabsEmptyStateProps,
} from './ChatTabsEmptyState';
