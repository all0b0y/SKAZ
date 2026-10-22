import type { CSSProperties } from 'react';
import openai from '../../brand/providers/openai.svg';
import claude from '../../brand/providers/claude-color.svg';
import nous from '../../brand/providers/nousresearch.svg';
import grok from '../../brand/providers/grok.svg';
import xai from '../../brand/providers/xai.svg';
import qwen from '../../brand/providers/qwen-color.svg';
import alibabacloud from '../../brand/providers/alibabacloud-color.svg';
import minimax from '../../brand/providers/minimax-color.svg';
import openrouter from '../../brand/providers/openrouter.svg';
import gemini from '../../brand/providers/gemini-color.svg';
import vertex from '../../brand/providers/vertexai-color.svg';
import deepseek from '../../brand/providers/deepseek-color.svg';
import zai from '../../brand/providers/zai.svg';
import kimi from '../../brand/providers/kimi-color.svg';
import nvidia from '../../brand/providers/nvidia-color.svg';
import huggingface from '../../brand/providers/huggingface-color.svg';
import vercel from '../../brand/providers/vercel.svg';
import opencode from '../../brand/providers/opencode.svg';
import kilocode from '../../brand/providers/kilocode.svg';
import copilot from '../../brand/providers/githubcopilot.svg';
import deepinfra from '../../brand/providers/deepinfra-color.svg';
import fireworks from '../../brand/providers/fireworks-color.svg';
import novita from '../../brand/providers/novita-color.svg';
import nebius from '../../brand/providers/nebius.svg';
import stepfun from '../../brand/providers/stepfun-color.svg';
import xiaomi from '../../brand/providers/xiaomimimo.svg';
import hunyuan from '../../brand/providers/hunyuan-color.svg';
import ollama from '../../brand/providers/ollama.svg';
import upstage from '../../brand/providers/upstage-color.svg';
import arcee from '../../brand/providers/arcee-color.svg';
import metaai from '../../brand/providers/metaai-color.svg';
import lmstudio from '../../brand/providers/lmstudio.svg';
import bedrock from '../../brand/providers/bedrock-color.svg';
import azure from '../../brand/providers/azureai-color.svg';

/** A mark and whether it is drawn in the text colour (single-colour marks) or as is. */
type Mark = { src: string; mono: boolean };
const mono = (src: string): Mark => ({ src, mono: true });
const color = (src: string): Mark => ({ src, mono: false });

/** Hermes provider id (and SKAZ's own engines' providers) → mark (brand/providers/NOTICE.md). */
const MARKS: Record<string, Mark> = {
  'openai-codex': mono(openai), 'openai-api': mono(openai), openai: mono(openai), codex: mono(openai),
  anthropic: color(claude), claude: color(claude), claude_code: color(claude),
  nous: mono(nous), 'xai-oauth': mono(grok), xai: mono(xai),
  'qwen-oauth': color(qwen), alibaba: color(qwen), 'alibaba-coding-plan': color(alibabacloud),
  minimax: color(minimax), 'minimax-cn': color(minimax), 'minimax-oauth': color(minimax),
  openrouter: mono(openrouter), gemini: color(gemini), vertex: color(vertex), deepseek: color(deepseek), zai: mono(zai),
  'kimi-coding': color(kimi), 'kimi-coding-cn': color(kimi), nvidia: color(nvidia), huggingface: color(huggingface),
  'ai-gateway': mono(vercel), 'opencode-zen': mono(opencode), 'opencode-go': mono(opencode), opencode: mono(opencode),
  kilocode: mono(kilocode), copilot: mono(copilot), deepinfra: color(deepinfra), fireworks: color(fireworks),
  novita: color(novita), 'nebius-token-factory': mono(nebius), stepfun: color(stepfun), xiaomi: mono(xiaomi),
  'tencent-tokenhub': color(hunyuan), 'tencent-tokenplan': color(hunyuan), 'ollama-cloud': mono(ollama),
  upstage: color(upstage), arcee: color(arcee), 'meta-ai': color(metaai), lmstudio: mono(lmstudio),
  bedrock: color(bedrock), 'azure-foundry': color(azure),
};

export function hasProviderMark(provider: string): boolean {
  return provider in MARKS;
}

/**
 * The provider's mark on a small tile (decision Q4: every provider in the picker and in Accounts &
 * keys has its icon); a provider without one gets its first letter. Decorative: the name is beside it.
 */
export function ProviderIcon({ provider, name, size = 16 }: { provider: string; name: string; size?: number }) {
  const mark = MARKS[provider];
  const style = { '--kb-provider-size': `${size}px` } as CSSProperties;
  if (!mark) {
    return <span className="kb-provider kb-provider--letter" style={style} aria-hidden="true">{(name.trim()[0] ?? '?').toUpperCase()}</span>;
  }
  if (mark.mono) {
    // Drawn in the text colour, so a black mark stays visible on the dark theme.
    return <span className="kb-provider kb-provider--mono" style={{ ...style, maskImage: `url("${mark.src}")`, WebkitMaskImage: `url("${mark.src}")` }} aria-hidden="true" />;
  }
  return (
    <span className="kb-provider" style={style} aria-hidden="true">
      <img src={mark.src} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}
