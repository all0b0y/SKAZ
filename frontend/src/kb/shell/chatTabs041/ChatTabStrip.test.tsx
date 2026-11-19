import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from 'zustand';
import { auditCss } from '../../board/audit';
import { ChatTabStrip, type ChatTabItem } from './ChatTabStrip';
import { ChatTabsEmptyState } from './ChatTabsEmptyState';
import { createChatTabsStore } from './tabsStore';

const SAMPLE_TABS: ChatTabItem[] = [
  { id: 'notes', title: 'Lecture notes · Karpathy' },
  { id: 'gqa', title: 'GQA discussion', working: true },
  { id: 'papers', title: 'ML papers — comparison', unread: true },
];

describe('ChatTabStrip', () => {
  it('renders tabs with non-nested permanently visible close buttons and working/unread marks', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ChatTabStrip tabs={SAMPLE_TABS} activeId="gqa" onSelect={onSelect} onClose={onClose} />);

    const tablist = screen.getByRole('tablist', { name: 'Open chats' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[0]).toHaveAttribute('tabindex', '-1');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('tabindex', '0');

    // Working indicator stays on the working chat tab.
    expect(within(tabs[1]!).getByLabelText('Working')).toBeInTheDocument();
    // Unread indicator shows on inactive unread tab.
    expect(within(tabs[2]!).getByLabelText('New answer')).toBeInTheDocument();

    // Every tab has a separate sibling close button, never nested inside role="tab".
    for (const tab of SAMPLE_TABS) {
      const closeBtn = screen.getByRole('button', { name: `Close tab: ${tab.title}` });
      expect(closeBtn).toHaveAttribute('title', 'Close tab — chat stays in the list');
      expect(closeBtn.closest('[role="tab"]')).toBeNull();
    }
  });

  it('supports keyboard ArrowLeft, ArrowRight, Home and End navigation with wrap-around', async () => {
    const user = userEvent.setup();
    function Wrapper() {
      const [activeId, setActiveId] = useState<string | null>('notes');
      return (
        <ChatTabStrip
          tabs={SAMPLE_TABS}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={() => {}}
        />
      );
    }
    render(<Wrapper />);

    const first = screen.getByRole('tab', { name: /Lecture notes/ });
    const second = screen.getByRole('tab', { name: /GQA discussion/ });
    const third = screen.getByRole('tab', { name: /ML papers/ });

    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(second).toHaveFocus();

    await user.keyboard('{End}');
    expect(third).toHaveAttribute('aria-selected', 'true');
    expect(third).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveFocus();

    await user.keyboard('{ArrowLeft}');
    expect(third).toHaveAttribute('aria-selected', 'true');
    expect(third).toHaveFocus();

    await user.keyboard('{Home}');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveFocus();
  });

  it('handles closing inactive, active, and last tabs and reopens even with hidden sidebar', async () => {
    const user = userEvent.setup();
    const stopBackend = vi.fn();
    const store = createChatTabsStore({
      openIds: ['notes', 'gqa', 'papers'],
      activeId: 'gqa',
      anchors: {
        notes: { messageId: 'm1', offsetPx: -10, scrollTop: 120, stickToBottom: false, updatedAt: 1 },
        gqa: { messageId: 'm4', offsetPx: -20, scrollTop: 340, stickToBottom: false, updatedAt: 2 },
        papers: { messageId: null, offsetPx: 0, scrollTop: 0, stickToBottom: true, updatedAt: 3 },
      },
    });
    const titles: Record<string, string> = {
      notes: 'Lecture notes · Karpathy',
      gqa: 'GQA discussion',
      papers: 'ML papers — comparison',
    };

    function IntegratedStrip() {
      const openIds = useStore(store, (s) => s.openIds);
      const activeId = useStore(store, (s) => s.activeId);
      const allClosed = useStore(store, (s) => s.allClosed);
      const lastClosedId = useStore(store, (s) => s.lastClosedId);
      const reopenRef = useRef<HTMLButtonElement | null>(null);
      const [focusSeq, setFocusSeq] = useState(0);
      const [focusTabId, setFocusTabId] = useState<string | null>(null);

      const items: ChatTabItem[] = openIds.map((id) => ({
        id,
        title: titles[id]!,
        working: id === 'gqa',
      }));

      return (
        <div>
          <ChatTabStrip
            tabs={items}
            activeId={activeId}
            onSelect={(id) => store.getState().select(id)}
            onClose={(id) => store.getState().close(id)}
            onEmptyFocus={() => reopenRef.current?.focus({ preventScroll: true })}
            focusTabId={focusTabId}
            focusSeq={focusSeq}
          />
          {allClosed && (
            <ChatTabsEmptyState
              ref={reopenRef}
              canReopen={lastClosedId !== null}
              lastClosedTitle={lastClosedId ? titles[lastClosedId] : null}
              sidebarHidden
              onReopenLast={() => {
                const reopened = store.getState().reopenLast();
                if (reopened) {
                  setFocusTabId(reopened);
                  setFocusSeq((n) => n + 1);
                }
              }}
            />
          )}
        </div>
      );
    }

    render(<IntegratedStrip />);

    // 1. Close inactive tab 'notes': active 'gqa' stays selected.
    await user.click(screen.getByRole('button', { name: 'Close tab: Lecture notes · Karpathy' }));
    expect(store.getState().activeId).toBe('gqa');
    expect(store.getState().openIds).toEqual(['gqa', 'papers']);
    expect(stopBackend).not.toHaveBeenCalled();

    // 2. Close active tab 'gqa': right neighbour 'papers' becomes active & focused; anchor preserved.
    await user.click(screen.getByRole('button', { name: 'Close tab: GQA discussion' }));
    expect(store.getState().activeId).toBe('papers');
    expect(screen.getByRole('tab', { name: /ML papers/ })).toHaveFocus();
    expect(store.getState().getAnchor('gqa')?.scrollTop).toBe(340);

    // 3. Close last tab 'papers': empty state + Reopen last chat receives focus, even with hidden sidebar.
    await user.click(screen.getByRole('button', { name: 'Close tab: ML papers — comparison' }));
    expect(screen.getByTestId('chat-tab-strip')).toHaveTextContent('No open chats');
    expect(screen.getByRole('region', { name: 'No open chats' })).toBeInTheDocument();
    const reopenBtn = screen.getByRole('button', { name: 'Reopen last chat' });
    expect(reopenBtn).toHaveFocus();

    // 4. Reopen last chat ('papers'), then check 'gqa' still keeps its working status & anchor if reopened.
    await user.click(reopenBtn);
    expect(store.getState().activeId).toBe('papers');
    expect(screen.getByRole('tab', { name: /ML papers/ })).toHaveFocus();

    act(() => store.getState().open('gqa'));
    expect(within(screen.getByRole('tab', { name: /GQA discussion/ })).getByLabelText('Working')).toBeInTheDocument();
    expect(store.getState().getAnchor('gqa')?.scrollTop).toBe(340);
  });

  it('detects real horizontal tab overflow for many tabs and scrolls/opens the overflow menu', async () => {
    const user = userEvent.setup();
    const manyTabs: ChatTabItem[] = Array.from({ length: 16 }, (_, i) => ({
      id: `c${i + 1}`,
      title: `Chat topic ${i + 1}`,
      working: i === 12,
    }));

    function OverflowHarness() {
      const [activeId, setActiveId] = useState<string | null>('c1');
      return (
        <ChatTabStrip
          tabs={manyTabs}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={() => {}}
        />
      );
    }

    render(<OverflowHarness />);
    const track = screen.getByRole('tablist', { name: 'Open chats' });

    // Stub horizontal geometry to simulate 16 tabs at 140px each in a 420px viewport.
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 420 });
    Object.defineProperty(track, 'scrollWidth', { configurable: true, value: 16 * 140 });
    track.scrollLeft = 0;

    const items = track.querySelectorAll<HTMLElement>('.kb-chattabs__item');
    items.forEach((item, index) => {
      Object.defineProperty(item, 'offsetLeft', { configurable: true, value: index * 140 });
      Object.defineProperty(item, 'offsetWidth', { configurable: true, value: 140 });
    });

    // Trigger resize/scroll re-measure.
    fireEvent.scroll(track);

    const overflowControls = await screen.findByTestId('chat-tabs-overflow');
    const leftBtn = within(overflowControls).getByRole('button', { name: 'Scroll tabs left' });
    const rightBtn = within(overflowControls).getByRole('button', { name: 'Scroll tabs right' });
    const menuBtn = within(overflowControls).getByRole('button', { name: 'Open tabs' });

    expect(leftBtn).toBeDisabled();
    expect(rightBtn).toBeEnabled();
    expect(menuBtn).toHaveTextContent('16');

    await user.click(rightBtn);
    expect(track.scrollLeft).toBeGreaterThan(0);
    expect(leftBtn).toBeEnabled();

    // Open the real overflow menu and pick off-screen working tab #13 ('Chat topic 13').
    await user.click(menuBtn);
    const menu = screen.getByRole('menu', { name: 'Open tabs' });
    const item13 = within(menu).getByRole('menuitem', { name: /Chat topic 13/ });
    expect(within(item13).getByText('Working')).toBeInTheDocument();

    await user.click(item13);
    const tab13 = screen.getByRole('tab', { name: /Chat topic 13/ });
    expect(tab13).toHaveAttribute('aria-selected', 'true');
    // Track scrolled so tab #13 (left: 12*140=1680, right: 1820) fits inside 420px viewport.
    expect(track.scrollLeft).toBe(1820 - 420);
  });

  it('prioritizes waiting over working in both tab indicator and overflow menu', async () => {
    const user = userEvent.setup();
    const tabs: ChatTabItem[] = [
      { id: 'c1', title: 'Idle chat' },
      { id: 'c2', title: 'Waiting permission chat', working: true, waiting: true, unread: true },
      { id: 'c3', title: 'Unread chat', unread: true },
    ];
    render(<ChatTabStrip tabs={tabs} activeId="c1" onSelect={() => {}} onClose={() => {}} />);

    const tab2 = screen.getByRole('tab', { name: /Waiting permission chat/ });
    expect(within(tab2).getByLabelText('Waiting for you')).toBeInTheDocument();
    expect(within(tab2).queryByLabelText('Working')).not.toBeInTheDocument();

    const track = screen.getByRole('tablist', { name: 'Open chats' });
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 220 });
    Object.defineProperty(track, 'scrollWidth', { configurable: true, value: 600 });
    fireEvent.scroll(track);

    const overflow = await screen.findByTestId('chat-tabs-overflow');
    await user.click(within(overflow).getByRole('button', { name: 'Open tabs' }));
    const menu = screen.getByRole('menu', { name: 'Open tabs' });
    expect(within(within(menu).getByRole('menuitem', { name: /Waiting permission chat/ })).getByText('Waiting')).toBeInTheDocument();
    expect(within(within(menu).getByRole('menuitem', { name: /Unread chat/ })).getByText('New')).toBeInTheDocument();
  });

  it('chatTabs.css conforms to the SKAZ design token lint rules', () => {
    const css = readFileSync(resolve(__dirname, 'chatTabs.css'), 'utf8');
    const audit = auditCss({ 'kb/shell/chatTabs041/chatTabs.css': css });
    expect(audit.colors).toEqual([]);
    expect(audit.fontSizes).toEqual([]);
    expect(audit.radii).toEqual([]);
    expect(audit.spacing.filter((s) => s.value !== '1px' && parseFloat(s.value) > 34)).toEqual([]);
    expect(audit.shadows).toBe(0);
  });
});
