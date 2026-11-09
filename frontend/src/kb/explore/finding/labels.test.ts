// Pure rules of the finding view: wording, which actions a finding offers, and where its text comes from.
import { describe, expect, it } from 'vitest';
import { contractFixtures as f } from '../../api/fake/fixtures';
import type { KbFinding, KbPaidAccess, KbScienceWork } from '../../../api/kb/types.gen';
import {
  EXPLORE_MODES, LABEL_TEXT, PAID_COPY, READ_MARKS, READ_MARK_TEXT, addContent, addLabel, authorLine,
  hintShown, paidText, publisherUrl, showsAddToWiki, sourceLine,
} from './labels';

const finding = (over: Partial<KbFinding> = {}): KbFinding => ({ ...(f.KbFinding as KbFinding), ...over });
const work = (over: Partial<KbScienceWork> = {}): KbScienceWork => ({ ...(f.KbScienceWork as KbScienceWork), ...over });
const access = (over: Partial<KbPaidAccess> = {}): KbPaidAccess => ({
  paid: false, alternatives_checked: true, free_alternative_ids: [], suggestion_shown_at: null,
  recommendation: null, publisher_url: null, ...over,
});

describe('finding wording', () => {
  it('names every label the way the wiki relation reads', () => {
    expect(LABEL_TEXT).toEqual({
      new: 'New',
      extends: 'Extends your wiki',
      contradicts: 'Contradicts your wiki',
      branch: 'Branch from your wiki',
      covered: 'Already in your wiki',
    });
  });

  it('offers the four read marks in the approved order and wording', () => {
    expect(READ_MARKS).toEqual(['useful_method', 'changed_my_view', 'already_knew', 'not_for_me']);
    expect(READ_MARKS.map((m) => READ_MARK_TEXT[m])).toEqual([
      'Useful method', 'Changed my view', 'Already knew this', 'Not for me',
    ]);
  });

  it('offers Brief tour, Deep dive and Notes', () => {
    expect(EXPLORE_MODES).toEqual([
      { mode: 'brief_tour', label: 'Brief tour' },
      { mode: 'deep_dive', label: 'Deep dive' },
      { mode: 'notes', label: 'Notes' },
    ]);
  });

  it('shows the authors as first author et al. only when there are several', () => {
    expect(authorLine(work({ authors: ['Lin', 'Chen'] }))).toBe('Lin et al.');
    expect(authorLine(work({ authors: ['Lin'] }))).toBe('Lin');
    expect(authorLine(work({ authors: [] }))).toBe('');
  });
});

describe('text source line', () => {
  it('says what text the wiki would get, and that full text is PDF or paywalled when it is not there', () => {
    expect(sourceLine('full_text')).toBe('Full text');
    expect(sourceLine('abstract_only')).toBe('Abstract only · full text is PDF or paywalled');
    expect(sourceLine('unchecked')).toBe('Full text not checked yet');
  });
});

describe('publisher link', () => {
  it('uses the publisher URL of the access record first, then a publisher location', () => {
    expect(publisherUrl(work({ access: access({ publisher_url: 'https://pub.example/a' }) }))).toBe('https://pub.example/a');
    expect(publisherUrl(work({
      access: access(), locations: [{ url: 'https://oa.example/x', kind: 'open_page', open_access: true },
        { url: 'https://pub.example/b', kind: 'publisher', open_access: false }],
    }))).toBe('https://pub.example/b');
  });

  it('is absent when the work has no publisher page', () => {
    expect(publisherUrl(work({ access: access(), locations: [] }))).toBeNull();
  });
});

describe('paid copy', () => {
  it('uses the recommendation of the server when it has one', () => {
    expect(paidText(access({ paid: true, recommendation: 'Server sentence.' }))).toBe('Server sentence.');
  });

  it('falls back to the approved copy, with the reason slot left for the server', () => {
    expect(PAID_COPY).toBe(
      "This article is paid. I think it's useful because … You can check it yourself; if you get it, add it to your materials.",
    );
    expect(paidText(access({ paid: true }))).toBe(PAID_COPY);
  });

  it('never says "buy"', () => {
    expect(PAID_COPY.toLowerCase()).not.toContain('buy');
  });
});

describe('add to wiki', () => {
  it('adds the full text when there is one, otherwise the abstract, and says which', () => {
    expect(addContent(finding({ text_available: 'full_text' }))).toBe('full_text');
    expect(addContent(finding({ text_available: 'abstract_only' }))).toBe('abstract_only');
    expect(addContent(finding({ text_available: 'unchecked' }))).toBe('abstract_only');
    expect(addLabel('full_text')).toBe('Add to wiki · full text');
    expect(addLabel('abstract_only')).toBe('Add to wiki · abstract only');
  });

  it('is not offered for paid articles or once the finding has a material', () => {
    expect(showsAddToWiki(finding())).toBe(true);
    expect(showsAddToWiki(finding({ work: work({ access: access({ paid: true }) }) }))).toBe(false);
    expect(showsAddToWiki(finding({ material_id: 'material-1' }))).toBe(false);
  });
});

describe('OpenAlex key hint', () => {
  const settings = { enabled: true, consent_at: null, openalex_key_configured: false, full_text_hint_dismissed: false };

  it('shows only for an abstract, without a key, until it is dismissed', () => {
    expect(hintShown(finding({ text_available: 'abstract_only' }), settings)).toBe(true);
    expect(hintShown(finding({ text_available: 'full_text' }), settings)).toBe(false);
    expect(hintShown(finding({ text_available: 'abstract_only' }), { ...settings, openalex_key_configured: true })).toBe(false);
    expect(hintShown(finding({ text_available: 'abstract_only' }), { ...settings, full_text_hint_dismissed: true })).toBe(false);
    expect(hintShown(finding({ text_available: 'abstract_only' }), null)).toBe(false);
  });
});
