import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { KbApp } from '../../KbApp';
import { createServices } from '../../state/context';
import { PREFS_KEY } from '../../state/prefs';
import { createFakeBridge } from '../../test/fakeBridge';
import { agent, chatWorld } from '../../test/fixtures';
import { fragment, materialWiki, type FakeWorld } from '../../test/fakeKb';
import type { JsonResponse } from '../../../api/bridge';
import type {
  KbVisualPreflightRequest,
  KbVisualPreflightResponse,
} from '../../../api/kb/types.gen';

const editor = () => screen.getByRole('textbox', { name: 'Message' });
const conversation = () => screen.getByRole('log', { name: 'Conversation' });
const sendButton = () => screen.getByRole('button', { name: 'Send' });

function visualTestWorld(): FakeWorld {
  const base = chatWorld();
  base.materials = [
    ...base.materials,
    {
      id: 'm-pdf-text',
      title: 'Inflation Report',
      kind: 'pdf',
      status: 'ready',
      folder_id: 'f-econ',
      languages: ['en'],
      created_at: '2026-10-15T08:00:00Z',
      fragment_count: 1,
      wiki_state: 'not_in_wiki',
      folder_name: 'Economics',
      origin: null,
      fragments: [
        fragment('m-pdf-text', 1, 'Headline inflation slowed on page 2 while services stayed elevated.', { page: 2 }),
      ],
      correction_counts: { applied: 0, doubtful: 0 },
      translation: null,
      wiki: materialWiki('not_in_wiki'),
      excluded_count: 0,
    },
    {
      id: 'm-photo-notext',
      title: 'Chart Screenshot.png',
      kind: 'image',
      status: 'ready',
      folder_id: 'f-econ',
      languages: [],
      created_at: '2026-10-15T08:05:00Z',
      fragment_count: 0,
      wiki_state: 'not_in_wiki',
      folder_name: 'Economics',
      origin: null,
      fragments: [],
      correction_counts: { applied: 0, doubtful: 0 },
      translation: null,
      wiki: materialWiki('not_in_wiki'),
      excluded_count: 0,
    },
  ];
  base.agents = {
    default: 'claude_code',
    favorites: [],
    agents: [
      agent('opencode', 'OpenCode', 'ready', {
        current_model: 'opencode/big-pickle',
        visual_transport: true,
        models: [
          {
            id: 'opencode/big-pickle',
            label: 'Big Pickle',
            efforts: [],
            default_effort: null,
            provider: 'opencode',
            provider_label: 'OpenCode',
            name: 'Big Pickle',
            tag: null,
            visible: true,
            default_visible: true,
            favorite: false,
            supports_image: false,
            input_modalities: ['text'],
          },
          {
            id: 'anthropic/claude-sonnet-4-5',
            label: 'Claude Sonnet 4.5',
            efforts: [],
            default_effort: null,
            provider: 'anthropic',
            provider_label: 'Anthropic',
            name: 'Claude Sonnet 4.5',
            tag: null,
            visible: true,
            default_visible: true,
            favorite: false,
            supports_image: true,
            input_modalities: ['text', 'image'],
          },
        ],
      }),
      agent('claude_code', 'Claude Code', 'ready', {
        current_model: 'claude-sonnet-5-5',
        visual_transport: true,
        models: [
          {
            id: 'claude-sonnet-5-5',
            label: 'Sonnet 5.5',
            efforts: ['medium', 'high'],
            default_effort: 'medium',
            provider: 'claude_code',
            provider_label: 'Claude Code',
            name: 'Sonnet 5.5',
            tag: null,
            visible: true,
            default_visible: true,
            favorite: false,
            supports_image: true,
            input_modalities: ['text', 'image'],
          },
        ],
      }),
    ],
  };
  base.chats = base.chats.map((c) => (
    c.id === 'c1'
      ? { ...c, engine: 'opencode', model: 'opencode/big-pickle', effort: null }
      : { ...c, engine: 'claude_code', model: 'claude-sonnet-5-5', effort: 'medium' }
  ));
  return base;
}

function renderVisualHost({ rejectNextSend, beforePreflight, beforeSend }: {
  rejectNextSend?: boolean;
  beforePreflight?: (body: KbVisualPreflightRequest) => Promise<void> | undefined;
  beforeSend?: (path: string) => Promise<void> | undefined;
} = {}) {
  localStorage.clear();
  localStorage.setItem(PREFS_KEY, JSON.stringify({ onboardingDone: true }));
  const world = visualTestWorld();
  const fake = createFakeBridge(world);
  const preflightCalls: KbVisualPreflightRequest[] = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  let shouldRejectOnce = Boolean(rejectNextSend);
  let raceBlockedAfterReject = false;

  const origRequest = fake.bridge.request.bind(fake.bridge);
  fake.bridge.request = async <T = unknown>(req: Parameters<typeof origRequest>[0]): Promise<JsonResponse<T>> => {
    if (req.method === 'POST' && req.path === '/kb/chats/visual-preflight') {
      const body = req.body as KbVisualPreflightRequest;
      preflightCalls.push(body);
      const held = beforePreflight?.(body);
      if (held) await held;
      const chat = body.chat_id ? world.chats.find((c) => c.id === body.chat_id) : null;
      const engine = body.engine ?? chat?.engine ?? 'opencode';
      const modelId = body.model ?? chat?.model ?? 'opencode/big-pickle';
      const modelObj = world.agents.agents
        .find((a) => a.id === engine)
        ?.models.find((m) => m.id === modelId);
      const attachments = body.attachments ?? [];
      const text = body.text ?? '';
      const hasPdf = attachments.includes('m-pdf-text');
      const hasImg = attachments.includes('m-photo-notext');
      const visualCue = /chart|image|page|photo|diagram|graph/i.test(text) || hasImg;
      const requiresVisual = (hasImg || (hasPdf && visualCue));
      const supportsImage = !raceBlockedAfterReject && modelObj?.supports_image === true;

      if (!requiresVisual) {
        const res: KbVisualPreflightResponse = {
          requires_visual: false,
          supported: true,
          engine,
          model_id: modelId,
          state: 'supported',
          reason_code: null,
          title: null,
          detail: null,
          text_only_available: false,
          draft_preserved: true,
          locator: null,
          compatible_models: [],
        };
        return { ok: true, status: 200, data: res as T };
      }

      if (supportsImage) {
        const res: KbVisualPreflightResponse = {
          requires_visual: true,
          supported: true,
          engine,
          model_id: modelId,
          state: 'supported',
          reason_code: null,
          title: null,
          detail: null,
          text_only_available: hasPdf && !hasImg,
          draft_preserved: true,
          locator: {
            material_id: hasImg ? 'm-photo-notext' : 'm-pdf-text',
            source_kind: hasImg ? 'image' : 'pdf',
            page: hasPdf ? 2 : null,
            timestamp_ms: null,
            label: hasImg ? 'Chart Screenshot.png' : 'Inflation Report · Page 2',
          },
          compatible_models: [],
        };
        return { ok: true, status: 200, data: res as T };
      }

      const res: KbVisualPreflightResponse = {
        requires_visual: true,
        supported: false,
        engine,
        model_id: modelId,
        state: 'unsupported',
        reason_code: 'model_no_image_input',
        title: 'This model can’t read images',
        detail: hasPdf ? 'The PDF text is still available.' : 'This attachment has no text to use instead.',
        text_only_available: hasPdf && !hasImg,
        draft_preserved: true,
        locator: {
          material_id: hasImg ? 'm-photo-notext' : 'm-pdf-text',
          source_kind: hasImg ? 'image' : 'pdf',
          page: hasPdf ? 2 : null,
          timestamp_ms: null,
          label: hasImg ? 'Chart Screenshot.png' : 'Inflation Report · Page 2',
        },
        compatible_models: [
          { engine: 'claude_code', model_id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', provider: 'claude_code' },
        ],
      };
      return { ok: true, status: 200, data: res as T };
    }

    if (req.method === 'POST' && /^\/kb\/chats\/[^/]+\/messages$/.test(req.path)) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const held = beforeSend?.(req.path);
      if (held) await held;
      if (shouldRejectOnce && !body.text_only) {
        shouldRejectOnce = false;
        raceBlockedAfterReject = true;
        return {
          ok: false,
          status: 422,
          detail: 'This model can’t read images. The PDF text is still available.',
          code: 'VISUAL_UNSUPPORTED',
        };
      }
      sentBodies.push(body);
      const result = await origRequest<T>(req);
      if (result.ok && body.text_only) {
        const data = result.data as {
          user: unknown;
          assistant: { parts: Array<Record<string, unknown>> };
        };
        data.assistant.parts = [
          { type: 'text_only', label: 'Text only · Image not analysed' },
          ...data.assistant.parts,
        ];
        const chatId = req.path.split('/')[3]!;
        const storedChat = world.chats.find((c) => c.id === chatId);
        const msg = storedChat?.messages.at(-1);
        if (msg) {
          msg.parts = [
            { type: 'text_only', label: 'Text only · Image not analysed' },
            ...msg.parts,
          ];
        }
      }
      return result;
    }

    return origRequest<T>(req);
  };

  const services = createServices(fake.bridge, localStorage, { capture: null });
  const view = render(<KbApp services={services} />);
  return { ...view, fake, services, world, preflightCalls, sentBodies };
}

async function openChat(user: ReturnType<typeof userEvent.setup>, titlePattern: RegExp) {
  const side = screen.getByRole('region', { name: 'Chats' });
  await user.click(await within(side).findByRole('button', { name: titlePattern }));
}

describe('VisualFallbackHost production wiring', () => {
  it('mounts UI-B above composer on unsupported PDF, preserves draft across model switch without auto-send, and sends images after switch', async () => {
    const user = userEvent.setup();
    const { services, sentBodies } = renderVisualHost();

    await openChat(user, /Why is there a logarithm/);
    services.composer.getState().attachmentDrafts.getState().update('c1', (items) => [
      ...items,
      {
        key: 'att-pdf',
        name: 'Inflation Report',
        kind: 'pdf',
        source: 'existing',
        state: 'ready',
        materialId: 'm-pdf-text',
        materialReady: true,
        inWiki: false,
        alreadyInLibrary: true,
        error: null,
      },
    ]);

    await user.click(editor());
    await user.keyboard('Explain the chart on page 2');

    const card = await screen.findByRole('group', { name: 'Image unavailable' });
    expect(within(card).getByText('This model can’t read images')).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Choose a model' })).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Continue with text only' })).toBeVisible();

    // Card is NOT rendered inside conversation history
    expect(within(conversation()).queryByRole('group', { name: 'Image unavailable' })).toBeNull();

    // Attempting submit while unsupported stays blocked, focuses Choose a model, preserves draft
    await user.click(sendButton());
    expect(sentBodies).toHaveLength(0);
    expect(editor()).toHaveTextContent('Explain the chart on page 2');
    expect(within(card).getByRole('button', { name: 'Choose a model' })).toHaveFocus();

    // Click Choose a model -> opens AgentPicker without sending; switch to Sonnet 5.5 -> draft kept, no auto-submit
    await user.click(within(card).getByRole('button', { name: 'Choose a model' }));
    const menu = await screen.findByRole('menu', { name: 'Agent and model' });
    await user.click(within(menu).getByRole('menuitemradio', { name: /Sonnet 5\.5/ }));

    await waitFor(() => expect(screen.queryByRole('group', { name: 'Image unavailable' })).toBeNull());
    expect(sentBodies).toHaveLength(0);
    expect(editor()).toHaveTextContent('Explain the chart on page 2');
    expect(screen.getByRole('list', { name: 'Draft attachments' })).toHaveTextContent('Inflation Report');

    // Now explicit Send submits once (and NOT as text_only)
    await user.click(sendButton());
    await waitFor(() => expect(sentBodies).toHaveLength(1));
    expect(sentBodies[0]?.text_only).toBeFalsy();
  });

  it('offers Continue with text only for PDF with text, hides it for image without text, and shows TextOnlyDisclosure on reply', async () => {
    const user = userEvent.setup();
    const { services, sentBodies } = renderVisualHost();

    await openChat(user, /Why is there a logarithm/);
    services.composer.getState().attachmentDrafts.getState().update('c1', (items) => [
      ...items,
      {
        key: 'att-img',
        name: 'Chart Screenshot.png',
        kind: 'image',
        source: 'existing',
        state: 'ready',
        materialId: 'm-photo-notext',
        materialReady: true,
        inWiki: false,
        alreadyInLibrary: true,
        error: null,
      },
    ]);
    await user.click(editor());
    await user.keyboard('What does this photo show?');

    const photoCard = await screen.findByRole('group', { name: 'Image unavailable' });
    expect(within(photoCard).getByRole('button', { name: 'Choose a model' })).toBeVisible();
    expect(within(photoCard).queryByRole('button', { name: 'Continue with text only' })).toBeNull();

    // Switch attachment to PDF with text layer
    services.composer.getState().attachmentDrafts.getState().update('c1', () => [{
      key: 'att-pdf',
      name: 'Inflation Report',
      kind: 'pdf',
      source: 'existing',
      state: 'ready',
      materialId: 'm-pdf-text',
      materialReady: true,
      inWiki: false,
      alreadyInLibrary: true,
      error: null,
    }]);
    fireEvent.input(editor());

    const pdfCard = await screen.findByRole('group', { name: 'Image unavailable' });
    const textOnlyBtn = await within(pdfCard).findByRole('button', { name: 'Continue with text only' });
    await user.click(textOnlyBtn);

    await waitFor(() => expect(sentBodies).toHaveLength(1));
    expect(sentBodies[0]?.text_only).toBe(true);
    expect(
      await within(conversation()).findByRole('note', { name: 'Text only · Image not analysed' }),
    ).toBeVisible();
  });

  it('isolates UI-B card per draft when switching between chat tabs and handles 422 recovery without duplicate sends', async () => {
    const user = userEvent.setup();
    const { services, sentBodies } = renderVisualHost({ rejectNextSend: true });

    await openChat(user, /Why is there a logarithm/);
    services.composer.getState().attachmentDrafts.getState().update('c1', (items) => [
      ...items,
      {
        key: 'att-pdf',
        name: 'Inflation Report',
        kind: 'pdf',
        source: 'existing',
        state: 'ready',
        materialId: 'm-pdf-text',
        materialReady: true,
        inWiki: false,
        alreadyInLibrary: true,
        error: null,
      },
    ]);
    await user.click(editor());
    await user.keyboard('Explain chart in chat 1');

    expect(await screen.findByRole('group', { name: 'Image unavailable' })).toBeVisible();

    // Switch to chat 2 (clean draft) -> UI-B must vanish immediately
    await openChat(user, /Transformer paper review/);
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Image unavailable' })).toBeNull());
    expect(editor()).toHaveTextContent('');

    // Switch back to chat 1 -> UI-B and draft both return intact
    await user.click(screen.getByRole('tab', { name: /Why is there a logarithm/ }));
    expect(await screen.findByRole('group', { name: 'Image unavailable' })).toBeVisible();
    expect(editor()).toHaveTextContent('Explain chart in chat 1');
    expect(sentBodies).toHaveLength(0);
  });

  it('recovers draft intact and surfaces UI-B without duplicate send on server 422 VISUAL_UNSUPPORTED race', async () => {
    const user = userEvent.setup();
    const { services, sentBodies } = renderVisualHost({ rejectNextSend: true });

    await openChat(user, /Transformer paper review/);
    services.composer.getState().attachmentDrafts.getState().update('c6', (items) => [
      ...items,
      {
        key: 'att-pdf-2',
        name: 'Inflation Report',
        kind: 'pdf',
        source: 'existing',
        state: 'ready',
        materialId: 'm-pdf-text',
        materialReady: true,
        inWiki: false,
        alreadyInLibrary: true,
        error: null,
      },
    ]);
    await user.click(editor());
    await user.keyboard('Explain chart race condition');

    // c2 uses sonnet 5.5 (preflight supported), so send fires, hits mocked 422 VISUAL_UNSUPPORTED
    await user.click(sendButton());
    await waitFor(() => expect(editor()).toHaveTextContent('Explain chart race condition'));
    expect(await screen.findByRole('group', { name: 'Image unavailable' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Draft attachments' })).toHaveTextContent('Inflation Report');
    expect(sentBodies).toHaveLength(0);
  });
});

function pauseOnce() {
  let entered = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return {
    wait: () => {
      if (entered) return undefined;
      entered = true;
      return pending;
    },
    entered: () => entered,
    release: () => act(async () => { release(); }),
  };
}

async function prepareVisualDraft(user: ReturnType<typeof userEvent.setup>, services: ReturnType<typeof createServices>) {
  await openChat(user, /Transformer paper review/);
  act(() => services.composer.getState().attachmentDrafts.getState().update('c6', () => [{
    key: 'chart', name: 'Chart Screenshot.png', source: 'existing', kind: 'image', state: 'ready',
    materialId: 'm-photo-notext', materialReady: true, inWiki: false, error: null,
  }]));
  await user.click(editor());
  await user.keyboard('Describe the chart');
}

describe('Visual admission ownership', () => {
  it('coalesces click and Enter through the pending check and sends the captured target once', async () => {
    const pause = pauseOnce();
    let armed = false;
    const user = userEvent.setup();
    const { services, sentBodies } = renderVisualHost({
      beforePreflight: (body) => armed && body.chat_id === 'c6' ? pause.wait() : undefined,
    });
    await prepareVisualDraft(user, services);
    armed = true;
    fireEvent.click(sendButton());
    await waitFor(() => expect(pause.entered()).toBe(true));
    expect(editor()).toHaveTextContent('Describe the chart');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    fireEvent.click(sendButton());
    await pause.release();
    await waitFor(() => expect(sentBodies).toHaveLength(1));
    expect(sentBodies[0]).toMatchObject({
      text: 'Describe the chart',
      attachments: ['m-photo-notext'],
      expected_target: { engine: 'claude_code', model: 'claude-sonnet-5-5', effort: 'medium' },
    });
  });

  it('cancels an earlier A activation across A → B → A and lets B send while A waits', async () => {
    const pause = pauseOnce();
    let armed = false;
    const user = userEvent.setup();
    const { services, sentBodies } = renderVisualHost({
      beforePreflight: (body) => armed && body.chat_id === 'c6' ? pause.wait() : undefined,
    });
    await prepareVisualDraft(user, services);
    armed = true;
    fireEvent.click(sendButton());
    await waitFor(() => expect(pause.entered()).toBe(true));
    await openChat(user, /Why is there a logarithm/);
    await user.click(editor());
    await user.keyboard('Send this from B');
    await user.click(sendButton());
    await waitFor(() => expect(sentBodies).toHaveLength(1));
    expect(sentBodies[0]).toMatchObject({ text: 'Send this from B', attachments: [] });

    await user.click(screen.getByRole('tab', { name: /Transformer paper review/ }));
    expect(editor()).toHaveTextContent('Describe the chart');
    await pause.release();
    await waitFor(() => expect(sendButton()).not.toHaveAttribute('aria-disabled', 'true'));
    expect(sentBodies).toHaveLength(1);
    expect(editor()).toHaveTextContent('Describe the chart');
    expect(screen.getByRole('list', { name: 'Draft attachments' })).toHaveTextContent('Chart Screenshot.png');
    await user.click(sendButton());
    await waitFor(() => expect(sentBodies).toHaveLength(2));
  });

  it('requires a new explicit send after the user changes model during preflight', async () => {
    const pause = pauseOnce();
    let armed = false;
    const user = userEvent.setup();
    const { services, sentBodies } = renderVisualHost({
      beforePreflight: (body) => armed && body.chat_id === 'c6' ? pause.wait() : undefined,
    });
    await prepareVisualDraft(user, services);
    armed = true;
    fireEvent.click(sendButton());
    await waitFor(() => expect(pause.entered()).toBe(true));

    await user.click(screen.getByRole('button', { name: /Agent and model:/ }));
    const menu = screen.getByRole('menu', { name: 'Agent and model' });
    await user.click(within(menu).getByRole('menuitemradio', { name: /Claude Sonnet 4\.5/ }));
    await waitFor(() => expect(services.chats.getState().list.find((c) => c.id === 'c6')?.model)
      .toBe('anthropic/claude-sonnet-4-5'));
    await pause.release();
    await waitFor(() => expect(sendButton()).not.toHaveAttribute('aria-disabled', 'true'));
    expect(sentBodies).toHaveLength(0);
    expect(editor()).toHaveTextContent('Describe the chart');
    await user.click(sendButton());
    await waitFor(() => expect(sentBodies).toHaveLength(1));
    expect(sentBodies[0]).toMatchObject({
      expected_target: { engine: 'opencode', model: 'anthropic/claude-sonnet-4-5' },
    });
  });

  it('restores a refused send only to the owning draft after switching tabs', async () => {
    const pause = pauseOnce();
    const user = userEvent.setup();
    const { services } = renderVisualHost({
      rejectNextSend: true,
      beforeSend: (path) => path === '/kb/chats/c6/messages' ? pause.wait() : undefined,
    });
    await prepareVisualDraft(user, services);
    await user.click(sendButton());
    await waitFor(() => expect(pause.entered()).toBe(true));
    await openChat(user, /Why is there a logarithm/);
    await user.click(editor());
    await user.keyboard('Keep the newer draft in B');
    await pause.release();
    expect(editor()).toHaveTextContent('Keep the newer draft in B');
    await user.click(screen.getByRole('tab', { name: /Transformer paper review/ }));
    expect(editor()).toHaveTextContent('Describe the chart');
    expect(screen.getByRole('list', { name: 'Draft attachments' })).toHaveTextContent('Chart Screenshot.png');
    expect(services.composer.getState().attachmentDrafts.getState().getDraft('c6').sending).toBe(false);
  });

  it('keeps text handed to the owner after the preflight snapshot', async () => {
    const pause = pauseOnce();
    let armed = false;
    const user = userEvent.setup();
    const { services, sentBodies } = renderVisualHost({
      beforePreflight: (body) => armed && body.chat_id === 'c6' ? pause.wait() : undefined,
    });
    await prepareVisualDraft(user, services);
    armed = true;
    fireEvent.click(sendButton());
    await waitFor(() => expect(pause.entered()).toBe(true));
    act(() => services.composer.getState().push([{ kind: 'text', text: ' New context' }], { focus: false }));
    await pause.release();
    expect(sentBodies).toHaveLength(0);
    expect(editor()).toHaveTextContent('Describe the chart New context');
    expect(sendButton()).not.toHaveAttribute('aria-disabled', 'true');
  });
});
