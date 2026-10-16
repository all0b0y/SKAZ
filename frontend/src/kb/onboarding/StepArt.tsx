import type { ReactNode } from 'react';
import { m, useReducedMotion, type Transition } from 'motion/react';

/**
 * First-launch illustrations (decisions 32/33): 118px, "lines" style (outline), drawn with
 * SVG + Motion (`pathLength`), no Lottie. No bubble tails, no sound arcs. Step art loops calmly;
 * the summary plays once and stays still. With reduced motion every art is a still frame.
 */
export type ArtStep = 'lang' | 'agent' | 'speech' | 'library' | 'summary';
export type SummaryTone = 'ok' | 'warn' | 'err';

const LOOP = (duration: number, times: number[], delay = 0): Transition => ({
  duration, times, delay, repeat: Infinity, ease: 'easeInOut',
});

function Frame({ step, still, children }: { step: ArtStep; still: boolean; children: ReactNode }) {
  return (
    <div className="kb-art" data-art={step} data-still={still ? 'true' : 'false'} aria-hidden="true">
      <svg viewBox="0 0 520 120" preserveAspectRatio="xMidYMid meet">{children}</svg>
    </div>
  );
}

function LangArt({ still }: { still: boolean }) {
  const swap = (delay: number) => ({
    a: still ? { opacity: 1 } : { opacity: [1, 1, 0, 0, 1] },
    b: still ? { opacity: 0 } : { opacity: [0, 0, 1, 1, 0] },
    t: LOOP(4, [0, 0.42, 0.5, 0.92, 1], delay),
  });
  const one = swap(0);
  const two = swap(0.6);
  return (
    <>
      <rect className="kb-art__shape" x="140" y="22" width="120" height="46" rx="16" />
      <m.text className="kb-art__text" x="200" y="51" animate={one.a} transition={one.t}>Привет</m.text>
      <m.text className="kb-art__text" x="200" y="51" initial={{ opacity: 0 }} animate={one.b} transition={one.t}>Hello</m.text>
      <rect className="kb-art__shape" x="270" y="52" width="120" height="46" rx="16" />
      <m.text className="kb-art__text" x="330" y="81" animate={two.a} transition={two.t}>Hallo</m.text>
      <m.text className="kb-art__text" x="330" y="81" initial={{ opacity: 0 }} animate={two.b} transition={two.t}>Hola</m.text>
    </>
  );
}

function AgentArt({ still }: { still: boolean }) {
  const draw = (delay: number) => (still ? { initial: false as const, animate: { pathLength: 1 } } : {
    initial: { pathLength: 0 },
    animate: { pathLength: [0, 1, 1, 1], opacity: [1, 1, 1, 0] },
    transition: LOOP(3.6, [0, 0.35, 0.85, 1], delay),
  });
  const pop = (delay: number) => (still ? { initial: false as const, animate: { scale: 1, opacity: 1 } } : {
    initial: { scale: 0, opacity: 0 },
    animate: { scale: [0, 1, 1, 1], opacity: [0, 1, 1, 0] },
    transition: LOOP(3.6, [0, 0.15, 0.88, 1], delay),
  });
  const pages: Array<[number, number, number]> = [[300, 14, 0.5], [300, 64, 0.8], [360, 39, 1.1]];
  return (
    <>
      <rect className="kb-art__shape" x="110" y="30" width="110" height="50" rx="16" />
      {[145, 165, 185].map((cx, i) => (
        <m.circle key={cx} className="kb-art__fill" cx={cx} cy="55" r="4"
          animate={still ? { y: 0, opacity: 1 } : { y: [0, -4, 0, 0], opacity: [0.5, 1, 0.5, 0.5] }}
          transition={LOOP(1.2, [0, 0.3, 0.6, 1], i * 0.15)} />
      ))}
      <m.path className="kb-art__line" d="M226 55 C 260 55, 270 30, 300 30" {...draw(0)} />
      <m.path className="kb-art__line" d="M226 55 C 260 55, 270 80, 300 80" {...draw(0.3)} />
      {pages.map(([x, y, t]) => (
        <m.g key={`${x}-${y}`} style={{ transformBox: 'fill-box', transformOrigin: 'center' }} {...pop(t)}>
          <rect className="kb-art__shape" x={x} y={y} width="44" height="34" rx="6" />
          <rect className="kb-art__fill" x={x + 8} y={y + 9} width="22" height="3" rx="1.5" />
          <rect className="kb-art__fill kb-art__fill--soft" x={x + 8} y={y + 17} width="28" height="3" rx="1.5" />
        </m.g>
      ))}
      <m.path className="kb-art__line" d="M344 31 L360 50" {...draw(1.3)} />
      <m.path className="kb-art__line" d="M344 81 L360 62" {...draw(1.4)} />
    </>
  );
}

function SpeechArt({ still }: { still: boolean }) {
  const heights = [10, 22, 34, 18, 40, 28, 14, 32, 20];
  return (
    <>
      {heights.map((h, i) => (
        <m.rect key={i} className="kb-art__fill" x={110 + i * 12} y={60 - h / 2} width="6" height={h} rx="3"
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          animate={still ? { scaleY: 1 } : { scaleY: [0.35, 1, 0.35] }}
          transition={LOOP(1.1, [0, 0.5, 1], i * 0.09)} />
      ))}
      <path className="kb-art__line" d="M232 60h36M260 52l8 8-8 8" />
      {([[86, 1], [70, 0.4], [96, 0.8]] as const).map(([w, t], i) => (
        <m.rect key={i} className="kb-art__shape" x="290" y={38 + i * 16} width={w} height="8" rx="4"
          style={{ transformBox: 'fill-box', transformOrigin: 'left center' }}
          initial={still ? false : { scaleX: 0, opacity: 0 }}
          animate={still ? { scaleX: 1, opacity: 1 } : { scaleX: [0, 1, 1, 1], opacity: [0, 1, 1, 0] }}
          transition={LOOP(3.6, [0, 0.25, 0.88, 1], t)} />
      ))}
      <m.text className="kb-art__text kb-art__text--small" x="290" y="104" textAnchor="start"
        initial={still ? false : { opacity: 0 }}
        animate={still ? { opacity: 1 } : { opacity: [0, 1, 1, 0] }}
        transition={LOOP(3.6, [0, 0.25, 0.88, 1], 1.2)}>08:12</m.text>
    </>
  );
}

function LibraryArt({ still }: { still: boolean }) {
  return (
    <>
      <m.g animate={still ? { opacity: 1 } : { opacity: [0.25, 0.25, 1, 1, 0.25] }} transition={LOOP(3, [0, 0.5, 0.65, 0.95, 1])}>
        <circle className="kb-art__fill" cx="200" cy="22" r="4" />
        <circle className="kb-art__fill" cx="260" cy="12" r="4" />
        <circle className="kb-art__fill" cx="320" cy="22" r="4" />
        <path className="kb-art__line" d="M204 21L256 13M264 13L316 21" />
      </m.g>
      {([[226, 0], [250, 0.5], [274, 1]] as const).map(([x, t]) => (
        <m.g key={x}
          initial={still ? false : { y: -34, opacity: 0 }}
          animate={still ? { y: 0, opacity: 1 } : { y: [-34, -34, 22, 22, 22], opacity: [0, 1, 1, 0, 0] }}
          transition={LOOP(3, [0, 0.2, 0.55, 0.7, 1], t)}>
          <rect className="kb-art__shape kb-art__shape--page" x={x} y="40" width="22" height="28" rx="4" />
          <rect className="kb-art__fill kb-art__fill--soft" x={x + 5} y="48" width="12" height="2.5" rx="1" />
        </m.g>
      ))}
      <path className="kb-art__shape" d="M200 62h40l8 8h72a6 6 0 0 1 6 6v28a6 6 0 0 1-6 6H200a6 6 0 0 1-6-6V68a6 6 0 0 1 6-6z" />
    </>
  );
}

function Glyph({ tone, x, delay, still }: { tone: SummaryTone; x: number; delay: number; still: boolean }) {
  if (tone === 'ok') {
    return (
      <m.path className="kb-art__line kb-art__line--bold" d={`M${x - 10} 60l7 7 13-14`}
        initial={still ? false : { pathLength: 0 }} animate={{ pathLength: 1 }}
        transition={still ? { duration: 0 } : { duration: 0.5, delay: delay + 0.25, ease: 'easeOut' }} />
    );
  }
  return <path className={`kb-art__line kb-art__line--bold is-${tone}`} d={`M${x} 49v13M${x} 70v.5`} />;
}

function SummaryArt({ still, tones }: { still: boolean; tones: [SummaryTone, SummaryTone, SummaryTone] }) {
  const xs = [190, 260, 330];
  const labels = ['speech', 'chat & wiki', 'library'];
  return (
    <>
      {xs.map((x, i) => {
        const tone = tones[i] ?? 'warn';
        const delay = i * 0.35;
        return (
          <m.g key={x} className={`kb-art__status is-${tone}`} data-tone={tone}
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            initial={still ? false : { scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={still ? { duration: 0 } : { type: 'spring', visualDuration: 0.32, bounce: 0, delay }}>
            <circle className="kb-art__shape" cx={x} cy="60" r="24" />
            <Glyph tone={tone} x={x} delay={delay} still={still} />
          </m.g>
        );
      })}
      {xs.map((x, i) => (
        <text key={`l-${x}`} className="kb-art__text kb-art__text--small" x={x} y="104">{labels[i]}</text>
      ))}
    </>
  );
}

export function StepArt({ step, tones }: { step: ArtStep; tones?: [SummaryTone, SummaryTone, SummaryTone] }) {
  const still = useReducedMotion() === true;
  return (
    <Frame step={step} still={still}>
      {step === 'lang' && <LangArt still={still} />}
      {step === 'agent' && <AgentArt still={still} />}
      {step === 'speech' && <SpeechArt still={still} />}
      {step === 'library' && <LibraryArt still={still} />}
      {step === 'summary' && <SummaryArt still={still} tones={tones ?? ['warn', 'warn', 'warn']} />}
    </Frame>
  );
}
