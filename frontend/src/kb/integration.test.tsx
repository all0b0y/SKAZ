// Package 2 put together (I1): the chat side (U2) and the document side (U3) share one document
// navigator, one message field and one fake backend. Each test crosses that seam.
import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from './test/renderKb';
import { chatWorld, docWorld } from './test/fixtures';
import { readSelectionQuote } from './ui/Selection';
import { citationRef, openTarget, pageRef, subjectRef } from './state/document';
import { createUiStore } from './state/ui';

const selectText = (el: Element) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
};

describe('One document navigator for chats and documents', () => {
  it('a source number in a chat answer opens the material screen on the right at the cited fragment', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: chatWorld() });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
    const answer = await screen.findByRole('article', { name: 'Answer' });
    await user.click(within(answer).getAllByRole('button', { name: 'Source 1: Lecture 5' })[0]!);
    await user.click(within(await screen.findByRole('dialog', { name: 'Lecture 5' })).getByRole('button', { name: /^Open at fragment/ }));
    expect(openTarget(services.ui.getState())).toMatchObject({ type: 'material', id: 'm5', seg: 3 });
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    expect(doc).toHaveAttribute('data-view', 'material');
    expect(await within(doc).findByRole('heading', { level: 2, name: 'Lecture 5 — classifiers' })).toBeInTheDocument();
    await waitFor(() => expect(doc.querySelector('[data-seg="3"]')).toHaveClass('is-target'));
    // A page chip replaces it with the wiki page — the same panel, not a second one.
    await user.click(within(answer).getAllByRole('button', { name: 'Wiki page: Entropy' })[0]!);
    expect(await within(screen.getByRole('complementary', { name: 'Document' })).findByRole('heading', { level: 2, name: 'Entropy' })).toBeInTheDocument();
    expect(screen.getAllByRole('complementary', { name: 'Document' })).toHaveLength(1);
  });

  it('U2 helpers build U3 targets: citation with its exact quote, page block, notification subject', () => {
    expect(citationRef({ material_id: 'm1', seg: 4, available: true, material_title: 'L', start_ms: null, end_ms: null, page: null, quote: 'exact words' }))
      .toEqual({ type: 'material', id: 'm1', seg: 4, quote: 'exact words' });
    expect(pageRef({ id: 'p1', kind: 'concept', title: 'Entropy' }, 'b2')).toEqual({ type: 'page', id: 'p1', block_id: 'b2' });
    expect(subjectRef({ type: 'chat', id: 'c1', block_id: null, seg: null })).toBeNull();
    const ui = createUiStore();
    ui.getState().openDocument(subjectRef({ type: 'page', id: 'p1', block_id: 'b1', seg: null })!);
    expect(openTarget(ui.getState())).toEqual({ type: 'page', id: 'p1', block_id: 'b1' });
    ui.getState().openGraph();
    expect(openTarget(ui.getState())).toBeNull();
  });

  it('"All chats" and "All materials" take the centre in turn; the chat field keeps its text underneath', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: chatWorld() });
    const input = await screen.findByTestId('message-input');
    await user.click(input);
    await user.keyboard('half a question');
    act(() => services.ui.getState().showCenter('allChats'));
    expect(await screen.findByRole('heading', { name: /All chats/ })).toBeInTheDocument();
    act(() => services.ui.getState().showCenter('materials'));
    expect(await screen.findByRole('heading', { name: /All materials/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /All chats/ })).not.toBeInTheDocument();
    act(() => services.ui.getState().showCenter('chat'));
    expect(await screen.findByTestId('message-input')).toHaveTextContent('half a question');
  });
});

describe('Documents talk to the message field', () => {
  it('"Ask about page" puts the page into the message field as a token and brings the chat back', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: docWorld() });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => {
      services.ui.getState().openDocument({ type: 'page', id: 'p-entropy' });
      services.ui.getState().toggleDocExpanded();
      services.ui.getState().showCenter('materials');
    });
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    await within(doc).findByRole('heading', { level: 2, name: 'Entropy' });
    await user.click(within(doc).getByRole('button', { name: 'Ask about page' }));
    expect(services.ui.getState().center).toBe('chat');
    expect(services.ui.getState().docExpanded).toBe(false);
    const input = await screen.findByTestId('message-input');
    await waitFor(() => expect(input.querySelector('.kb-token--mention')).toHaveTextContent('Entropy'));
  });

  it('"Ask about material" does the same for a material', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: docWorld() });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => services.ui.getState().openDocument({ type: 'material', id: 'm-tb' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    await within(doc).findByRole('heading', { level: 2, name: 'Textbook: Information theory, ch. 2' });
    await user.click(within(doc).getByRole('button', { name: 'Ask about material' }));
    await waitFor(() => expect(screen.getByTestId('message-input').querySelector('.kb-token--mention')).toHaveTextContent('Textbook'));
  });

  it('text selected in a wiki block or a material fragment is a quote of that place (shared Selection)', async () => {
    const { services } = renderKb({ world: docWorld() });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => services.ui.getState().openDocument({ type: 'page', id: 'p-entropy' }));
    let doc = await screen.findByRole('complementary', { name: 'Document' });
    await within(doc).findByRole('heading', { level: 2, name: 'Entropy' });
    const block = doc.querySelector('[data-quote-source="page"][data-quote-block="b3"]')!;
    expect(block).not.toBeNull();
    expect(readSelectionQuote(selectText(block))).toMatchObject({ source: 'page', id: 'p-entropy', block_id: 'b3', seg: null });

    act(() => services.ui.getState().openDocument({ type: 'material', id: 'm-lec8' }));
    doc = await screen.findByRole('complementary', { name: 'Document' });
    await within(doc).findByRole('heading', { level: 2, name: 'Lecture 8 — entropy' });
    // Original view: the quote is the source text of fragment 2.
    await userEvent.setup().click(within(doc).getByRole('radio', { name: 'Original' }));
    const frag = await waitFor(() => {
      const el = doc.querySelector('[data-quote-source="material"][data-quote-seg="2"]');
      if (!el) throw new Error('no quotable fragment yet');
      return el;
    });
    expect(readSelectionQuote(selectText(frag))).toMatchObject({ source: 'material', id: 'm-lec8', seg: 2, text: expect.stringMatching(/^Why the logarithm\?/) });
  });
});
