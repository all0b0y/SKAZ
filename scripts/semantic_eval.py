"""Semantic evaluation of the production Q&A path on a replayed public transcript.

What this is
------------
The live smoke checks structure: that citations resolve to stored segments. It cannot
say whether the answer means what the recording said. This runner asks the production
``POST /sessions/{id}/ask`` route the fixture's questions, repeats them, and records
every input and output so a human can judge the meaning, plus a small deterministic
checker for the two failures actually observed on this fixture.

What it is not
--------------
* Not ASR. The transcript is replayed from an earlier stored run (fixture
  ``source.asr``); no audio is transcribed and nothing here is evidence about any ASR.
* Not a general correctness oracle. The rules below recognise the phrasings of the
  observed failures on this one fixture. A clean rule run is reported as
  ``pending_manual``, never as a pass: only a human verdict against the fixture's
  rubric can call an answer correct.
* Not an LLM judge. No second model reads the answers.

Run (real provider calls, costs money — run deliberately):

    uv run --project backend python scripts/semantic_eval.py --live --repeats 3

Wiring check without any provider (canned local answers, proves nothing about a model):

    uv run --project backend python scripts/semantic_eval.py --dry-run
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import re
import secrets
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = ROOT / 'acceptance' / 'fixtures' / 'jfk_replay.json'
#: The application's current agent model. This runner never changes it.
DEFAULT_AGENT_MODEL = 'qwen/qwen3-30b-a3b-instruct-2507'
MAX_REPEATS = 10

# --- fixture-scoped rules ----------------------------------------------------
#
# Each rule below matches the wording of a failure that was actually observed on this
# fixture, in the answer language the fixture asks for (ru) and in English. They are
# deliberately narrow: a phrasing they do not recognise yields no defect, which is why
# a clean run still ends as pending_manual.

#: "what your country can do for you" — the side that must stay negated.
SIDE_COUNTRY = re.compile(
    r'что\s+(?:ваша\s+|твоя\s+|наша\s+|их\s+|его\s+)?стран[аы]\s+(?:может|можете|могут)\s+сделать'
    r'\s+для\s+(?:вас|вам|тебя|нас|них)'
    r'|what\s+(?:your\s+|the\s+)?country\s+can\s+do\s+for\s+(?:you|them|us)',
    re.IGNORECASE,
)
#: "what you can do for your country" — the other side of the contrast.
SIDE_CITIZEN = re.compile(
    r'что\s+(?:вы|ты|они|мы)\s+(?:можете|можешь|можем|могут|может)\s+сделать\s+для'
    r'\s+(?:сво(?:ей|его|ему)\s+)?стран'
    r'|what\s+(?:you|they|we)\s+can\s+do\s+for\s+(?:your|their|our|the)?\s*country',
    re.IGNORECASE,
)
#: A negation or a substitution marker that must stand before the country side.
NEGATION_BEFORE = re.compile(
    r'\bне\b|\bни\b|\bвместо\b|\bне\w*\s*спрашивай'
    r"|\bnot\b|\bdon'?t\b|\binstead\b|\brather\s+than\b",
    re.IGNORECASE,
)
#: How far back the negation may stand from the phrase it negates.
NEGATION_WINDOW_CHARS = 80


def _normalised(text: str) -> str:
    return re.sub(r'\s+', ' ', text.replace('ё', 'е').replace('Ё', 'Е'))


def _contrast_negation(answer: str) -> list[str]:
    """Defects of the JFK contrast: a dropped negation, or only one side of it.

    Reports at most one defect, the more severe first: an answer that reverses the
    negation is wrong about what was said, an answer that keeps only one side is
    incomplete. An answer naming neither side is left to the human — it may be a
    legitimate statement of uncertainty about a transcript that really is cut.
    """
    text = _normalised(answer)
    country = SIDE_COUNTRY.search(text)
    citizen = SIDE_CITIZEN.search(text)
    if country is not None:
        before = text[max(0, country.start() - NEGATION_WINDOW_CHARS):country.start()]
        if not NEGATION_BEFORE.search(before):
            return ['negation_dropped']
    if bool(country) != bool(citizen):
        return ['contrast_incomplete']
    return []


RULES = {'contrast_negation': _contrast_negation}


def load_fixture(path: Path = FIXTURE_PATH) -> dict:
    return json.loads(path.read_text())


def fixture_digest(path: Path = FIXTURE_PATH) -> str:
    """SHA-256 of the exact fixture bytes, so a report names the input it used."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def question(key: str, fixture: dict) -> dict:
    for item in fixture['questions']:
        if item['key'] == key:
            return item
    raise KeyError(f'unknown question key {key!r} in fixture {fixture.get("id")!r}')


def defects(question_key: str, answer: str, fixture: dict) -> list[str]:
    """Names of the observed failures this answer reproduces, in severity order."""
    found: list[str] = []
    for name in question(question_key, fixture)['checks']:
        found.extend(RULES[name](answer))
    return found


def verdict(found: list[str]) -> str:
    """``fail`` when a known failure is reproduced, otherwise a pending human verdict."""
    return 'fail' if found else 'pending_manual'


# --- live runner -------------------------------------------------------------


def _canned(fixture: dict) -> httpx.MockTransport:
    """Local canned answers for --dry-run: the stored bad outputs, replayed in order."""
    answers = [item['answer'] for item in fixture['observed_outputs']]
    state = {'index': 0}

    def handle(request: httpx.Request) -> httpx.Response:
        if request.method == 'GET' and request.url.path.endswith('/models'):
            # The settings route validates the model against the provider catalog; a
            # dry run has no provider, so the catalog is canned too.
            return httpx.Response(200, json={'data': [{
                'id': DEFAULT_AGENT_MODEL, 'name': 'canned catalog entry',
                'architecture': {'input_modalities': ['text'], 'output_modalities': ['text']}}]})
        answer = answers[state['index'] % len(answers)]
        state['index'] += 1
        return httpx.Response(
            200,
            json={
                'id': 'dry-run',
                'model': 'dry-run/canned-not-a-model',
                'choices': [{'message': {'content': answer}}],
            },
        )

    return httpx.MockTransport(handle)


def _seed(runtime, session_id: str, fixture: dict) -> list[dict]:
    """Store the fixture's transcript as this session's segments. No audio is decoded."""
    from audiohelper import repository as repo

    stored = []
    for item in fixture['segments']:
        segment = repo.new_segment(item['start_ms'], item['end_ms'], item['text'], None)
        repo.replace_chunk_segments(runtime.db, session_id, item['sequence'], [segment])
        stored.append({'id': segment.id, 'start_ms': segment.start_ms,
                       'end_ms': segment.end_ms, 'text': segment.text})
    repo.extend_duration(runtime.db, session_id, fixture['segments'][-1]['end_ms'])
    return stored


async def run(args: argparse.Namespace, *, transport: httpx.MockTransport | None = None) -> Path:
    from audiohelper.app import create_app
    from audiohelper.config import AppConfig
    from audiohelper.secrets import MemorySecretStore

    if transport is not None and not args.dry_run:
        raise ValueError('An injected offline transport requires --dry-run')

    fixture = load_fixture(args.fixture)
    out = args.out or ROOT / '.runtime' / ('semantic-' + time.strftime('%Y%m%d-%H%M%S') + '-'
                                           + secrets.token_hex(3))
    out.mkdir(parents=True)
    provider_calls: list[dict] = []
    provider_requests: list[dict] = []

    async def observe_request(request: httpx.Request) -> None:
        if request.method != 'POST':
            return
        data = json.loads(request.content)
        messages = json.dumps(data.get('messages'), ensure_ascii=False, sort_keys=True).encode()
        provider_requests.append({
            'messages_sha256': hashlib.sha256(messages).hexdigest(),
            'parameters': {name: data[name] for name in
                           ('model', 'max_tokens', 'temperature', 'top_p', 'seed', 'stream') if name in data},
        })

    async def observe(response: httpx.Response) -> None:
        if response.request.method != 'POST':
            return
        await response.aread()
        try:
            data = response.json()
        except ValueError:
            data = None
        is_json = isinstance(data, dict)
        data = data if is_json else {}
        provider_calls.append({'status': response.status_code, 'id': data.get('id'),
                               'model': data.get('model'), 'usage': data.get('usage'),
                               'json_response': is_json})

    hooks = {'request': [observe_request], 'response': [observe]}

    if args.dry_run:
        key, mode = 'dry-run-no-key', ('dry-run: canned local answers, NOT a model result; '
                                       'no provider was called')
        outgoing = httpx.AsyncClient(transport=transport or _canned(fixture),
                                     event_hooks=hooks, timeout=30)
    else:
        from check_openrouter import project_key

        key = project_key()  # never printed, never written to the report
        mode = 'live: real outward HTTP to the configured provider'
        outgoing = httpx.AsyncClient(event_hooks=hooks, timeout=90)

    token = secrets.token_urlsafe(32)
    app = create_app(AppConfig(token=token, data_dir=out / 'data'),
                     secret_store=MemorySecretStore({'openrouter': key}), http_client=outgoing)
    report: dict = {
        'command': [sys.executable, str(Path(__file__).resolve()),
                    '--dry-run' if args.dry_run else '--live', '--repeats', str(args.repeats),
                    '--model', args.model, '--fixture', str(args.fixture), '--out', str(out)],
        'source_sha256': {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in (
            'scripts/semantic_eval.py', 'backend/src/audiohelper/agent/ask.py',
            'backend/src/audiohelper/agent/context.py', 'backend/src/audiohelper/agent/scope.py',
            'backend/src/audiohelper/gateways/chat.py')},
        'mode': mode,
        'scope': ('production ask API in-process on a replayed stored transcript; '
                  'no ASR, no microphone, no desktop'),
        'fixture': {'path': str(args.fixture), 'id': fixture['id'],
                    'sha256': fixture_digest(args.fixture), 'source': fixture['source']},
        'requested_agent_model': args.model,
        'repeats': args.repeats,
        'rules': ('fixture-scoped deterministic checks of the failures observed on this '
                  'fixture; they can fail an answer, never certify one'),
        'manual_rubric': {item['key']: item['rubric'] for item in fixture['questions']},
        'attempts': [],
        'provider_calls': provider_calls,
    }
    failures: list[str] = []
    try:
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url='http://127.0.0.1:8765',
                                         headers={'Authorization': 'Bearer ' + token},
                                         timeout=120) as client:
                async def request(method: str, path: str, **kwargs) -> dict:
                    response = await client.request(method, path, **kwargs)
                    if response.status_code >= 400:
                        detail = ' '.join(response.text.split())[:400]
                        raise RuntimeError(f'{method} {path} -> HTTP {response.status_code}: {detail}')
                    return response.json()

                await request('PUT', '/settings', json={
                    'agent': {'provider': 'openrouter', 'model': args.model},
                    'cloud_consent': True, 'output_language': 'ru'})
                for repeat in range(1, args.repeats + 1):
                    # A fresh session per repeat: no chat history carries between repeats,
                    # so answer variability is isolated from conversation state.
                    session = await request('POST', '/sessions',
                                            json={'title': f'Semantic eval {fixture["id"]} #{repeat}'})
                    session_id = session['id']
                    stored = _seed(app.state.runtime, session_id, fixture)
                    report.setdefault('replayed_sessions', {})[session_id] = stored
                    for item in fixture['questions']:
                        before = len(provider_calls)
                        request_before = len(provider_requests)
                        started = time.perf_counter()
                        attempt = {
                            'repeat': repeat, 'question_key': item['key'],
                            'question': item['question'], 'session_id': session_id,
                            'requested_model': args.model, 'status': 'started',
                            'provider_model_status': 'unknown', 'manual_verdict': 'pending',
                        }
                        report['attempts'].append(attempt)
                        try:
                            body = await request('POST', f'/sessions/{session_id}/ask', json={
                                'question': item['question'], 'scope': item['scope'],
                                'window_minutes': item['window_minutes'], 'language': item['language']})
                        except Exception as error:
                            attempt.update(status='error', error=f'{type(error).__name__}: {error}')
                            raise
                        finally:
                            attempt['seconds'] = round(time.perf_counter() - started, 3)
                            attempt['provider_calls'] = provider_calls[before:]
                            attempt['provider_requests'] = provider_requests[request_before:]
                        # What the provider itself said it ran, next to what was asked for.
                        # The response body only echoes the configured model, so on its own
                        # it could never reveal a substitution.
                        calls = provider_calls[before:]
                        reported = next((call['model'] for call in reversed(calls) if call['model']), None)
                        found = defects(item['key'], body['answer'], fixture)
                        attempt.update({
                            'status': 'completed', 'response_model': body.get('model'),
                            'provider_reported_model': reported,
                            'provider_model_status': ('unknown' if reported is None else
                                                      'confirmed' if reported == args.model else 'mismatched'),
                            'usage': [call.get('usage') for call in calls],
                            'answer': body['answer'],
                            'citations': body.get('citations'), 'context': body.get('context'),
                            'defects': found, 'verdict': verdict(found),
                            'manual_verdict': 'pending',
                        })
                        if found:
                            failures.append(f'{item["key"]} repeat {repeat}: ' + ', '.join(found))
                        if reported is None:
                            failures.append(f'{item["key"]} repeat {repeat}: provider model identity unknown')
                        elif reported != args.model:
                            failures.append(
                                f'{item["key"]} repeat {repeat}: the provider reported model '
                                f'{reported!r}, not the requested {args.model!r}')
    except Exception as error:  # the evidence gathered so far is what makes a failure useful
        report['error'] = f'{type(error).__name__}: {error}'
        failures.append('run aborted: ' + report['error'])

    costs = []
    for call in provider_calls:
        usage = call.get('usage')
        cost = usage.get('cost') if isinstance(usage, dict) else None
        if isinstance(cost, bool) or not isinstance(cost, (int, float)) or not math.isfinite(cost):
            cost = None
        costs.append(cost)
    report['reported_api_cost_usd'] = sum(cost for cost in costs if cost is not None)
    report['calls_without_reported_cost'] = sum(cost is None for cost in costs)
    report['latency_seconds'] = sorted(attempt['seconds'] for attempt in report['attempts'])
    report['failures'] = failures
    report['ok'] = not failures
    report['exit_code'] = 1 if failures else 0
    report['note'] = ('ok:true means no known failure was reproduced and the model answered as '
                      'requested. Every answer still carries manual_verdict "pending": judge it '
                      'against manual_rubric before calling the behaviour correct.')
    destination = out / 'report.json'
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    print('REPORT', destination)
    if failures:
        print('FAILED', len(failures), 'check(s); see the report above')
        raise SystemExit(1)
    return destination


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--live', action='store_true',
                      help='make real paid provider calls; required for real evidence')
    mode.add_argument('--dry-run', action='store_true',
                      help='canned local answers, no provider; checks the wiring only')
    parser.add_argument('--repeats', type=int, default=3,
                        help=f'bounded number of repeats per question (max {MAX_REPEATS})')
    parser.add_argument('--model', default=DEFAULT_AGENT_MODEL,
                        help='agent model; defaults to the application\'s current one')
    parser.add_argument('--fixture', type=Path, default=FIXTURE_PATH)
    parser.add_argument('--out', type=Path, default=None)
    args = parser.parse_args(argv)
    if not 1 <= args.repeats <= MAX_REPEATS:
        parser.error(f'--repeats must be between 1 and {MAX_REPEATS}')
    return args


if __name__ == '__main__':
    asyncio.run(run(parse_args()))
