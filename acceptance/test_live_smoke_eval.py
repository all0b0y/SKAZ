"""Deterministic tests for the live smoke evaluator.

The live run itself needs real audio and a real provider; these tests pin the rule it
applies to what comes back, so a run cannot pass on ungrounded notes. They are not
evidence about any model: no provider is called here.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

from live_smoke import SmokeFailure, aborted, citation_failures, finish, http_failure  # noqa: E402

SEGMENTS = [
    {'id': 'seg-1', 'start_ms': 0, 'end_ms': 5000, 'text': 'Определили энтропию.'},
    {'id': 'seg-2', 'start_ms': 5000, 'end_ms': 9000, 'text': 'Перенесли дедлайн.'},
]


def cite(segment, **overrides):
    citation = {'segment_id': segment['id'], 'start_ms': segment['start_ms'],
                'end_ms': segment['end_ms'], 'text': segment['text']}
    return {**citation, **overrides}


def notes(*citations, content='- Энтропия определена [S1]'):
    return {'content': content, 'citations': list(citations)}


def test_notes_citing_stored_segments_pass():
    assert citation_failures('notes', notes(cite(SEGMENTS[0]), cite(SEGMENTS[1])), SEGMENTS) == []


def test_an_answer_payload_is_checked_the_same_way():
    payload = {'answer': 'Кратко [S1]', 'citations': [cite(SEGMENTS[0])]}
    assert citation_failures('answer', payload, SEGMENTS) == []


def test_notes_without_citations_fail():
    failures = citation_failures('notes', notes(), SEGMENTS)
    assert failures == ['notes: no citations']


def test_an_unknown_source_id_fails():
    failures = citation_failures('notes', notes(cite(SEGMENTS[0], segment_id='seg-invented')), SEGMENTS)
    assert len(failures) == 1
    assert 'unknown source' in failures[0] and 'seg-invented' in failures[0]


def test_one_bad_citation_among_good_ones_still_fails():
    payload = notes(cite(SEGMENTS[0]), cite(SEGMENTS[1], segment_id='seg-invented'))
    assert [f for f in citation_failures('notes', payload, SEGMENTS) if 'unknown source' in f]


def test_a_wrong_time_window_fails():
    failures = citation_failures('notes', notes(cite(SEGMENTS[0], start_ms=1234, end_ms=99000)), SEGMENTS)
    assert len(failures) == 1
    assert '1234-99000 ms' in failures[0] and '0-5000 ms' in failures[0]


def test_a_citation_with_no_time_span_fails():
    zero = {'id': 'seg-1', 'start_ms': 700, 'end_ms': 700, 'text': 'Определили энтропию.'}
    failures = citation_failures('notes', notes(cite(zero)), [zero])
    assert failures == ['notes: citation 0 (seg-1) has no positive time span']


def test_citation_text_that_is_not_the_stored_segment_fails():
    failures = citation_failures('notes', notes(cite(SEGMENTS[0], text='Согласовали бюджет.')), SEGMENTS)
    assert len(failures) == 1
    assert 'text differs' in failures[0]


def test_absent_sources_fail_even_when_citations_look_well_formed():
    failures = citation_failures('notes', notes(cite(SEGMENTS[0])), [])
    assert 'notes: no stored transcript segment to cite' in failures
    assert any('unknown source' in failure for failure in failures)


def test_missing_notes_fail_instead_of_passing_silently():
    failures = citation_failures('notes', None, SEGMENTS)
    assert 'notes: empty text' in failures
    assert 'notes: no citations' in failures


def test_empty_note_text_fails_even_with_citations():
    failures = citation_failures('notes', notes(cite(SEGMENTS[0]), content='   '), SEGMENTS)
    assert failures == ['notes: empty text']


def test_a_failed_run_persists_its_report_and_exits_nonzero(tmp_path):
    """The report is written exactly when it matters most, and the run fails visibly."""
    failures = []
    report = {'windows': [{'sequence': 0, 'start_ms': 0, 'end_ms': 5000}]}
    aborted(report, failures, SmokeFailure('POST /sessions/s1/notes -> HTTP 502: provider said no'))
    with pytest.raises(SystemExit) as exit_info:
        finish(report, failures, tmp_path)
    assert exit_info.value.code == 1
    saved = json.loads((tmp_path / 'report.json').read_text())
    assert saved['ok'] is False
    assert saved['windows'] == report['windows'], 'partial evidence from before the failure survives'
    assert 'HTTP 502' in saved['error']
    assert [failure for failure in saved['failures'] if 'run aborted' in failure]


def test_a_clean_run_writes_its_report_and_does_not_exit(tmp_path):
    destination = finish({'session_id': 's1'}, [], tmp_path)
    assert json.loads(destination.read_text())['ok'] is True


def test_an_http_error_keeps_the_provider_detail_without_credentials():
    report = {}
    error = http_failure(report, 'POST', '/sessions/s1/notes', 502, 'x' * 900)
    assert isinstance(error, SmokeFailure)
    recorded = report['http_errors'][0]
    assert set(recorded) == {'method', 'path', 'status', 'detail'}, 'no headers are ever recorded'
    assert recorded['status'] == 502
    assert len(recorded['detail']) <= 400, 'the body is truncated, not dumped whole'
