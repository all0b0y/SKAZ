"""Deterministic tests for the semantic Q&A evaluator's own rules.

These pin what the fixture-scoped checker calls a defect. They are evidence about the
checker, never about a model: no provider is called and no answer is generated here.
The positive cases are the real outputs of the two stored JFK runs, so a rule that
stopped catching the observed failure fails here.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

from semantic_eval import (  # noqa: E402
    DEFAULT_AGENT_MODEL,
    FIXTURE_PATH,
    MAX_REPEATS,
    defects,
    fixture_digest,
    load_fixture,
    parse_args,
    verdict,
)

FIXTURE = load_fixture(FIXTURE_PATH)


def test_the_fixture_is_a_replay_and_says_so():
    """The runner's input must never be mistaken for a fresh ASR result."""
    assert 'REPLAY ONLY' in FIXTURE['source']['asr']
    assert [segment['text'] for segment in FIXTURE['segments']] == [
        'And so, my fellow Americans, ask not.',
        'What your country can do for you, ask what you can do for your.',
        'Country.',
    ]


def test_the_fixture_digest_pins_the_exact_input(tmp_path):
    sample = tmp_path / 'bytes'
    sample.write_bytes(b'abc')
    assert fixture_digest(sample) == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    sample.write_bytes(b'abcd')
    assert fixture_digest(sample) == '88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589'


def test_every_observed_output_is_judged_as_recorded():
    """Each stored real output keeps the verdict the fixture claims for it."""
    for observed in FIXTURE['observed_outputs']:
        found = defects(observed['question_key'], observed['answer'], FIXTURE)
        assert found == observed['expected_defects'], observed['label']


def test_the_observed_negation_reversal_is_a_defect():
    answer = 'Вы пропустили фразу: «Что ваша страна может сделать для вас, спросите, что вы можете сделать для своей страны» [S1-S3].'
    assert defects('missed_recent', answer, FIXTURE) == ['negation_dropped']
    assert verdict(['negation_dropped']) == 'fail'


def test_the_observed_half_contrast_is_a_defect():
    answer = 'Вы пропустили фразу: «спросите, что вы можете сделать для своей страны» [S2-S3].'
    assert defects('missed_recent', answer, FIXTURE) == ['contrast_incomplete']


def test_a_complete_negated_contrast_has_no_defect_but_still_needs_a_human():
    answer = ('Он призвал не спрашивать, что ваша страна может сделать для вас, '
              'а спрашивать, что вы можете сделать для своей страны [S1-S3].')
    assert defects('missed_recent', answer, FIXTURE) == []
    assert verdict([]) == 'pending_manual', 'a clean rule run is never a pass on its own'


def test_the_same_reversal_in_english_is_caught():
    answer = 'You missed: ask what your country can do for you, and what you can do for your country [S1-S3].'
    assert defects('missed_recent', answer, FIXTURE) == ['negation_dropped']


def test_an_english_negated_contrast_has_no_defect():
    answer = ('He asked people not to ask what your country can do for you, '
              'but what you can do for your country [S1-S3].')
    assert defects('missed_recent', answer, FIXTURE) == []


def test_an_answer_that_states_its_uncertainty_is_left_to_the_human():
    answer = 'Фрагмент обрывается на середине фразы, точная формулировка неясна [S1-S3].'
    assert defects('missed_recent', answer, FIXTURE) == []
    assert verdict([]) == 'pending_manual'


def test_a_question_without_rules_is_manual_only():
    """The absent-topic question has no reliable rule, so it is never auto-judged."""
    answer = 'В предоставленном фрагменте бюджет не назван.'
    assert defects('absent_budget', answer, FIXTURE) == []
    assert FIXTURE['questions'][1]['checks'] == []
    assert FIXTURE['questions'][1]['rubric'], 'a manual-only question still carries its rubric'


def test_an_unknown_question_key_is_rejected_instead_of_silently_passing():
    try:
        defects('no-such-question', 'что угодно', FIXTURE)
    except KeyError as error:
        assert 'no-such-question' in str(error)
    else:
        raise AssertionError('an unknown question key must not be judged as clean')


def test_a_paid_run_has_to_be_asked_for_explicitly():
    """Neither mode is the default, so the runner cannot spend money by being started."""
    with pytest.raises(SystemExit):
        parse_args([])
    with pytest.raises(SystemExit):
        parse_args(['--live', '--dry-run'])
    assert parse_args(['--live']).live is True
    assert parse_args(['--dry-run']).live is False


def test_the_default_run_is_bounded_and_keeps_the_application_model():
    args = parse_args(['--dry-run'])
    assert args.repeats == 3
    assert args.model == DEFAULT_AGENT_MODEL == 'qwen/qwen3-30b-a3b-instruct-2507'
    with pytest.raises(SystemExit):
        parse_args(['--dry-run', '--repeats', str(MAX_REPEATS + 1)])
    with pytest.raises(SystemExit):
        parse_args(['--dry-run', '--repeats', '0'])


def test_the_fixture_on_disk_is_valid_json_with_the_questions_the_runner_asks():
    raw = json.loads(FIXTURE_PATH.read_text())
    assert [question['key'] for question in raw['questions']] == ['missed_recent', 'absent_budget']
    assert all(question['rubric'] for question in raw['questions'])


@pytest.mark.parametrize('relative', [False, True])
def test_cli_replay_report_keeps_sources_for_every_repeat(tmp_path, relative):
    """Execute the offline CLI, not private collaborators; no provider is called."""
    import subprocess

    fixture = tmp_path / 'fixture.json'
    fixture.write_text(FIXTURE_PATH.read_text())
    out = tmp_path / 'report'
    script = FIXTURE_PATH.parents[2] / 'scripts' / 'semantic_eval.py'
    result = subprocess.run(
        [sys.executable, str(script), '--dry-run', '--repeats', '2',
         '--fixture', fixture.name if relative else str(fixture), '--out', str(out)],
        cwd=tmp_path, capture_output=True, text=True, timeout=30,
    )
    assert (out / 'report.json').exists(), result.stderr
    report = json.loads((out / 'report.json').read_text())
    assert result.returncode == 1  # canned known-bad outputs must fail
    assert len(report['attempts']) == 4
    sessions = {attempt['session_id'] for attempt in report['attempts']}
    assert set(report['replayed_sessions']) == sessions
    for attempt in report['attempts']:
        sources = {s['id']: s for s in report['replayed_sessions'][attempt['session_id']]}
        for citation in attempt['citations']:
            source = sources[citation['segment_id']]
            assert citation['text'] == source['text']
            assert (citation['start_ms'], citation['end_ms']) == (source['start_ms'], source['end_ms'])


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['missing_model', 'http_error', 'timeout', 'malformed_usage'])
async def test_runner_records_unverified_or_failed_provider_attempt(tmp_path, failure):
    import httpx
    from semantic_eval import run

    def provider(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{
                'id': DEFAULT_AGENT_MODEL,
                'architecture': {'input_modalities': ['text'], 'output_modalities': ['text']},
            }]})
        if failure == 'timeout':
            raise httpx.ReadTimeout('test timeout', request=request)
        if failure == 'http_error':
            return httpx.Response(503, text='unavailable')
        response: dict = {'choices': [{'message': {'content': 'Неясно [P1].'}}]}
        if failure == 'malformed_usage':
            response['usage'] = 'unavailable'
        return httpx.Response(200, json=response)

    args = parse_args(['--dry-run', '--repeats', '1', '--out', str(tmp_path / 'result')])
    with pytest.raises(SystemExit) as stopped:
        await run(args, transport=httpx.MockTransport(provider))
    assert stopped.value.code == 1
    report = json.loads((args.out / 'report.json').read_text())
    attempt = report['attempts'][0]
    assert attempt['question_key'] == 'missed_recent'
    assert attempt['repeat'] == 1
    assert attempt['seconds'] >= 0
    assert report['exit_code'] == 1
    assert report['source_sha256'] and report['command']
    assert attempt['provider_model_status'] == 'unknown'
    if failure in ('missing_model', 'malformed_usage'):
        assert attempt['status'] == 'completed'
        assert report['calls_without_reported_cost'] == 2
        assert any('model identity' in problem for problem in report['failures'])
        assert attempt['provider_requests'][0]['parameters']['max_tokens'] == 900
        assert len(attempt['provider_requests'][0]['messages_sha256']) == 64
    else:
        assert attempt['status'] == 'error'
        assert attempt['error']
        if failure == 'http_error':
            assert report['provider_calls'][0]['status'] == 503
            assert report['provider_calls'][0]['json_response'] is False
