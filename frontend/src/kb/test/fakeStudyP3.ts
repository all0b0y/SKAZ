// P3 in the shared fake backend: an open answer's review (key ideas, model answer, «I did say this»,
// «counted by you»), in the shapes of the generated contract (types.gen.ts). A fake on the external
// seam: it proves the UI's handling of contract-shaped answers, not the backend's prompts or checks
// (backend/tests/knowledge/test_p3_*.py own those).

import type { KbStudyPart, KbStudyQuestion, KbStudyResponse, KbStudyReview } from '../../api/kb/types.gen';
import type { FakeRoutes, FakeWorld } from './fakeKb';

type Status = NonNullable<KbStudyResponse['status']>;

/** SKAZ's own count (P3-a decision 5): (covered + ½·partial) / all; Got it ≥ 0.8, Not yet = 0. */
export function scoreOf(review: KbStudyReview): { score: number; status: Status; verdict: string } {
  const all = review.ideas.length || 1;
  const points = review.ideas.reduce((n, i) => n + (i.by_user || i.status === 'covered' ? 1 : i.status === 'partial' ? 0.5 : 0), 0);
  const score = Math.round((points / all) * 10_000) / 10_000;
  const status: Status = score >= 0.8 ? 'got' : score <= 0 ? 'not_yet' : 'almost';
  return { score, status, verdict: { got: 'right', almost: 'partly', not_yet: 'wrong' }[status] };
}

/** The review the fake agent gives an open answer by default: one idea covered, one partly, one missing. */
export function defaultReview(question: KbStudyQuestion): KbStudyReview {
  const cite = question.citations;
  return {
    ideas: [
      { id: 'k1', text: 'Entropy counts the arrangements W.', citations: cite, status: 'covered', yours: null, why: null,
        why_basis: null, why_citations: [], by_user: false, recheck: null, rechecking: false },
      { id: 'k2', text: 'Joining two systems multiplies their arrangements.', citations: cite, status: 'partial', yours: 'joined systems',
        why: 'The counts multiply, so something has to turn a product into a sum.', why_basis: 'source', why_citations: cite,
        by_user: false, recheck: null, rechecking: false },
      { id: 'k3', text: 'A logarithm turns the product into a sum, so entropies add up.', citations: cite, status: 'missing', yours: null,
        why: 'That is the reason for the logarithm itself.', why_basis: 'agent', why_citations: [], by_user: false, recheck: null, rechecking: false },
    ],
    model_answer: [
      { text: 'Because joined systems add up:', idea: null, added: false },
      { text: 'their arrangements multiply,', idea: 'k2', added: true },
      { text: 'and a logarithm turns that product into a sum.', idea: 'k3', added: true },
    ],
    also_right: [{ text: 'Entropy grows with the number of arrangements.', basis: 'agent', citations: [] }],
    comment: 'A good start: you saw that joined systems add up. Next, say what the logarithm does to the product.',
  };
}

interface Helpers {
  findStudy: (w: FakeWorld, id: string) => { part: KbStudyPart };
  studyChanged: (w: FakeWorld, found: never) => KbStudyPart;
  fail: (status: number, detail: string) => never;
}

/** The P3 study routes; `helpers` are the fake backend's own (find a block, send its update). */
export function p3StudyRoutes({ findStudy, studyChanged, fail }: Helpers): FakeRoutes {
  const reviewed = (w: FakeWorld, blockId: string, itemId: string) => {
    const found = findStudy(w, blockId);
    const q = found.part.questions.find((x) => x.id === itemId) ?? fail(404, 'This question is not in the test.');
    if (!q.response?.review) fail(409, 'Check this answer with the agent first.');
    return { found, q, response: q.response!, review: q.response!.review! };
  };
  const rescore = (response: KbStudyResponse) => Object.assign(response, scoreOf(response.review!));
  /** Every marked item the fake knows: blocks in chats, then deck pages (the fake has no folders: «All»). */
  const marked = (w: FakeWorld) => {
    const out: Array<{ item_id: string; kind: 'card' | 'question'; question: string; title: string; page_id: string | null;
      clear: () => void }> = [];
    const seen = new Set<string>();
    const add = (item: { id: string; question: string; unclear?: boolean }, kind: 'card' | 'question', title: string, page: string | null) => {
      if (!item.unclear || seen.has(item.id)) return;
      seen.add(item.id);
      out.push({ item_id: item.id, kind, question: item.question, title, page_id: page, clear: () => { item.unclear = false; } });
    };
    for (const chat of w.chats) {
      for (const message of chat.messages) {
        for (const part of message.parts as ReadonlyArray<{ type: string }>) {
          if (part.type !== 'study') continue;
          const study = part as KbStudyPart;
          study.cards.forEach((c) => add(c, 'card', study.title, study.save.page_id));
          study.questions.forEach((q) => add(q, 'question', study.title, study.save.page_id));
        }
      }
    }
    for (const [pageId, deck] of Object.entries(w.decks ?? {})) deck.cards.forEach((c) => add(c, 'card', deck.title, pageId));
    return out;
  };
  const list = (w: FakeWorld, pageId?: string | null) => {
    const items = marked(w).filter((i) => !pageId || i.page_id === pageId).map(({ clear: _clear, ...item }) => item);
    return { items, scope: pageId ? 'page' as const : 'library' as const };
  };
  return {
    'GET /kb/study/unclear': [200, (w, { query }) => list(w, query?.page_id)],
    'POST /kb/study/unclear/clear': [200, (w, { body }) => {
      for (const item of marked(w)) if (body.item_ids.includes(item.item_id)) item.clear();
      return list(w);
    }],
    'POST /kb/study/{block_id}/recheck': [200, (w, { path, body }) => {
      const { found, response, review } = reviewed(w, path.block_id, body.item_id);
      const idea = review.ideas.find((i) => i.id === body.idea_id) ?? fail(404, 'This key idea is not in the review.');
      if (!(response.text ?? '').includes(body.words.trim())) fail(409, 'Select words of your own answer.');
      const agreed = w.recheck ?? { status: 'missing' as const, note: 'Here you name the systems; what the logarithm does is still to add.' };
      idea.recheck = { status: agreed.status, note: agreed.note, words: body.words.trim() };
      if (agreed.status === 'covered' || (agreed.status === 'partial' && idea.status === 'missing')) idea.status = agreed.status;
      rescore(response);
      return studyChanged(w, found as never);
    }],
    'POST /kb/study/{block_id}/count': [200, (w, { path, body }) => {
      const { found, response, review } = reviewed(w, path.block_id, body.item_id);
      const idea = review.ideas.find((i) => i.id === body.idea_id) ?? fail(404, 'This key idea is not in the review.');
      idea.by_user = body.counted ?? true;
      rescore(response);
      return studyChanged(w, found as never);
    }],
  };
}
