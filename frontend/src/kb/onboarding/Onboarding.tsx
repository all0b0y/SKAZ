import { useEffect, useId, useState, type ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Button, Icon, Modal, PathText } from '../ui';
import { EXIT, SPRING_LARGE } from '../ui/motion';
import { useAgents, useLibrary, useServices, useSettings } from '../state/context';
import type { KbAgents, KbKeys, KbSpeechSettings } from '../../api/kb/types.gen';
import { AgentCards } from '../settings/AgentCard';
import { AsrRow, KeyRow, LocalWhisperRow, SpeechLanguagesRow, TranslationRow } from '../settings/LiveRows';
import { LibraryPlace, useLibraryChoice } from './LibraryStep';
import { StepArt, type SummaryTone } from './StepArt';

export const STEPS = ['lang', 'agent', 'speech', 'library', 'summary'] as const;
export type Step = (typeof STEPS)[number];
const LABELS: Record<Exclude<Step, 'summary'>, string> = {
  lang: 'Languages', agent: 'Agent', speech: 'Speech', library: 'Library',
};
const SKIPPABLE: ReadonlySet<Step> = new Set(['agent', 'speech', 'library']);

function Heading({ id, children }: { id: string; children: ReactNode }) {
  return <h2 id={id} className="kb-ob__title">{children}</h2>;
}

export interface StatusLine {
  label: string;
  tone: SummaryTone;
  text: string;
}

/** Honest first-launch summary: only what real answers say is ready gets a check. */
export function summaryLines(
  library: { state: string; root: string | null } | null,
  agents: KbAgents | null = null,
  speech: { settings: KbSpeechSettings | null; keys: KbKeys | null } = { settings: null, keys: null },
): StatusLine[] {
  const lib: StatusLine = library?.state === 'ready'
    ? { label: 'Library', tone: 'ok', text: library.root ?? 'Connected' }
    : library?.state === 'unavailable'
      ? { label: 'Library', tone: 'err', text: 'Folder unavailable — see Settings → Storage' }
      : { label: 'Library', tone: 'warn', text: 'Not connected — choose a place in Settings → Storage' };
  const ready = agents?.agents.filter((a) => a.state === 'ready') ?? [];
  const chosen = agents?.agents.find((a) => a.id === agents.default);
  const agent: StatusLine = !agents
    ? { label: 'Chat and wiki', tone: 'warn', text: 'Agents couldn’t be checked — see Settings → Accounts & keys' }
    : chosen?.state === 'ready'
      ? { label: 'Chat and wiki', tone: 'ok', text: `${chosen.name}${chosen.version ? ` ${chosen.version}` : ''}` }
      : ready.length
        ? { label: 'Chat and wiki', tone: 'ok', text: ready.map((a) => a.name).join(', ') }
        : { label: 'Chat and wiki', tone: 'warn', text: 'No agent is connected — chat and wiki wait for one' };
  const sp = speech.settings;
  const soniox = speech.keys?.providers.find((p) => p.id === 'soniox');
  const rec: StatusLine = !sp
    ? { label: 'Speech recognition', tone: 'warn', text: 'Not checked' }
    : sp.provider === 'soniox'
      ? soniox?.configured && soniox.valid !== false
        ? { label: 'Speech recognition', tone: 'ok', text: 'Soniox' }
        : { label: 'Speech recognition', tone: 'warn', text: 'Soniox — no working key yet' }
      : sp.local_model.state === 'ready'
        ? { label: 'Speech recognition', tone: 'ok', text: 'On this computer' }
        : { label: 'Speech recognition', tone: 'warn', text: 'On this computer — the model isn’t downloaded yet' };
  return [rec, agent, lib];
}

/**
 * First launch (decisions 32/33): steps one by one — Languages → Agent → Speech → Library → Summary.
 * Agent and Speech show the real state from the backend and fix it in place.
 */
export function Onboarding({ open, onFinish }: { open: boolean; onFinish: () => void }) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index] ?? 'summary';
  const library = useLibrary((s) => s.library);
  const choice = useLibraryChoice();
  const titleId = useId();
  const agents = useAgents((s) => s.agents);
  const speechSettings = useSettings((s) => s.speech.value);
  const keys = useSettings((s) => s.keys.value);
  const { settings } = useServices();
  useEffect(() => {
    if (!open) return;
    void settings.getState().loadSpeech();
    void settings.getState().loadKeys();
  }, [open, settings]);

  const next = () => setIndex((i) => Math.min(STEPS.length - 1, i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));
  const lines = summaryLines(library, agents, { settings: speechSettings, keys });
  const tones = lines.map((l) => l.tone) as [SummaryTone, SummaryTone, SummaryTone];
  const libReady = library?.state === 'ready';

  const primary = async () => {
    if (step === 'summary') { onFinish(); return; }
    if (step === 'library' && !libReady) {
      if (await choice.connect()) next();
      return;
    }
    next();
  };
  const primaryLabel = step === 'summary' ? 'Open SKAZ' : step === 'library' && !libReady ? 'Create library' : 'Next';

  return (
    <Modal open={open} onClose={() => undefined} title="Welcome to SKAZ" bare scrim="strong" dismissOnScrim={false}
      dismissOnEscape={false} className="kb-ob" testId="onboarding" pane="onboarding" initialFocus="dialog">
      <ol className="kb-ob__steps" aria-label="Setup steps">
        {STEPS.filter((s) => s !== 'summary').map((s, i) => {
          const done = i < index;
          const current = i === index;
          return (
            <li key={s} className={`kb-ob__step${current ? ' is-current' : ''}${done ? ' is-done' : ''}`}
              aria-current={current ? 'step' : undefined} data-step={s}>
              <span className="kb-ob__num" aria-hidden="true">{done ? <Icon name="check" size={11} /> : i + 1}</span>
              <span>{LABELS[s as Exclude<Step, 'summary'>]}</span>
              {done && <span className="kb-visually-hidden"> (done)</span>}
            </li>
          );
        })}
      </ol>
      <div className="kb-ob__body" role="group" aria-labelledby={titleId} data-step={step}>
        <AnimatePresence mode="popLayout" initial={false}>
          <m.div key={step} className="kb-ob__pane"
            initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0, transition: SPRING_LARGE }}
            exit={{ opacity: 0, transition: EXIT }}>
            <StepArt step={step} tones={tones} />
            {step === 'lang' && (
              <>
                <Heading id={titleId}>Which languages do you hear?</Heading>
                <p className="kb-ob__lead">A hint for speech recognition. You can change it in Settings.</p>
                <SpeechLanguagesRow labelledBy={titleId} />
                <div className="kb-srow">
                  <div className="kb-srow__text"><div className="kb-srow__label">Default translation</div></div>
                  <div className="kb-srow__control"><TranslationRow optionPrefix="into " /></div>
                </div>
              </>
            )}
            {step === 'agent' && (
              <>
                <Heading id={titleId}>Choose an agent</Heading>
                <p className="kb-ob__lead">
                  The agent answers in chat and builds the wiki. It works through your own account; you can change it in Settings.
                </p>
                <AgentCards />
                <p className="kb-ob__small">Without an agent, recording and materials work; chat and wiki wait for one.</p>
              </>
            )}
            {step === 'speech' && (
              <>
                <Heading id={titleId}>How should speech be recognised?</Heading>
                <p className="kb-ob__lead">Soniox: live recording with translation, needs a key, audio goes to Soniox. On this computer: no internet, slower, no live translation.</p>
                <div className="kb-srow">
                  <div className="kb-srow__text"><div className="kb-srow__label">Service</div></div>
                  <div className="kb-srow__control"><AsrRow label="Service" /></div>
                </div>
                {speechSettings?.provider === 'local_whisper' ? (
                  <div className="kb-srow">
                    <div className="kb-srow__text"><div className="kb-srow__label">Speech model</div></div>
                    <div className="kb-srow__control"><LocalWhisperRow /></div>
                  </div>
                ) : (
                  <div className="kb-srow">
                    <div className="kb-srow__text"><div className="kb-srow__label">Soniox key</div></div>
                    <div className="kb-srow__control"><KeyRow provider="soniox" /></div>
                  </div>
                )}
              </>
            )}
            {step === 'library' && (
              <>
                <Heading id={titleId}>Where should the library live?</Heading>
                <p className="kb-ob__lead">Materials and wiki are plain .md files. The folder can be opened in Obsidian.</p>
                <LibraryPlace base={choice.base} setBase={choice.setBase} error={choice.error} />
              </>
            )}
            {step === 'summary' && (
              <>
                <Heading id={titleId}>Ready to start</Heading>
                <ul className="kb-ob__summary">
                  {lines.map((line) => (
                    <li key={line.label} className="kb-srow" data-tone={line.tone}>
                      <div className="kb-srow__text"><div className="kb-srow__label">{line.label}</div></div>
                      <div className="kb-srow__control">
                        <span className={`kb-status kb-status--${line.tone}`}>
                          <Icon name={line.tone === 'ok' ? 'check' : line.tone === 'err' ? 'error' : 'warning'} size={13} />
                          {line.label === 'Library' && line.tone === 'ok' ? <PathText path={line.text} /> : line.text}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="kb-ob__small">What isn’t connected can be set up later in Settings.</p>
              </>
            )}
          </m.div>
        </AnimatePresence>
      </div>
      <footer className="kb-ob__foot">
        {index > 0 && step !== 'summary' && <Button onClick={back}>Back</Button>}
        <span className="kb-ob__spacer" />
        {SKIPPABLE.has(step) && <Button variant="quiet" onClick={next}>Skip</Button>}
        <Button variant="fill" busy={choice.busy} onClick={() => void primary()}>{primaryLabel}</Button>
      </footer>
    </Modal>
  );
}

/** "Library isn't connected" → the library step of first launch, on its own. */
export function LibrarySetupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const choice = useLibraryChoice();
  const library = useLibrary((s) => s.library);
  const titleId = useId();
  const ready = library?.state === 'ready';
  return (
    <Modal open={open} onClose={onClose} title="Library" bare className="kb-ob kb-ob--single" testId="library-setup" pane="library-setup">
      <div className="kb-ob__body" role="group" aria-labelledby={titleId}>
        <StepArt step="library" />
        <h2 id={titleId} className="kb-ob__title">Where should the library live?</h2>
        <p className="kb-ob__lead">Materials and wiki are plain .md files. The folder can be opened in Obsidian.</p>
        {ready && (
          <p className="kb-ob__small">A new place starts a new, empty library. The current one stays where it is.</p>
        )}
        <LibraryPlace base={choice.base} setBase={choice.setBase} error={choice.error} allowChange />
      </div>
      <footer className="kb-ob__foot">
        <Button onClick={onClose}>Cancel</Button>
        <span className="kb-ob__spacer" />
        <Button variant="fill" busy={choice.busy} disabled={ready && !choice.base}
          onClick={async () => { if (await choice.connect()) onClose(); }}>
          {ready ? 'Use this place' : 'Create library'}
        </Button>
      </footer>
    </Modal>
  );
}
