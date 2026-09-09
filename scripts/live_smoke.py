"""Live public-API smoke with real audio and real OpenRouter calls (not mocks).

Run: uv run --project backend python scripts/live_smoke.py --asr-only
Fixtures must be downloaded by benchmark_asr.py and converted to PCM16 WAV first.
The in-process HTTP transport reaches the real app; outbound network is untouched.
"""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import io
import json
import secrets
import time
import wave
from pathlib import Path

import httpx
from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.secrets import MemorySecretStore
from check_openrouter import ROOT, project_key

REFERENCE = 'And so my fellow Americans ask not what your country can do for you ask what you can do for your country'


class SmokeFailure(RuntimeError):
    """A live check failed; the report keeps the evidence."""


def http_failure(report, method, path, status, body):
    """Record a failed request and describe it, keeping the server's own wording.

    Only the method, the in-process path and a truncated response body are kept: request
    headers carry the local token and the provider key, so they are never recorded.
    """
    detail = ' '.join((body or '').split())[:400]
    report.setdefault('http_errors', []).append(
        {'method': method, 'path': path, 'status': status, 'detail': detail})
    return SmokeFailure(f'{method} {path} -> HTTP {status}: {detail}')


def aborted(report, failures, error):
    """Turn an exception that ended the run into reportable evidence."""
    report['error'] = f'{type(error).__name__}: {error}'
    failures.append('run aborted: ' + report['error'])


def finish(report, failures, out):
    """Persist the run's evidence and decide its exit status.

    The report is written whether the run passed or failed: a failed live run is exactly
    when its diagnostics are worth keeping, including whatever partial evidence the run
    had already gathered.
    """
    report['failures'] = list(failures)
    report['ok'] = not failures
    destination = out / 'report.json'
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    print('REPORT', destination)
    if failures:
        print('FAILED', len(failures), 'check(s); see the report above')
        raise SystemExit(1)
    return destination


def citation_failures(label, payload, segments):
    """Structural grounding failures of one cited answer or set of notes.

    Every citation must name a segment the session actually stored, with that segment's
    own time window and text. This is provenance only: an empty list means the listener
    can check each point back against the recording, never that the prose is a correct
    or complete summary of it.
    """
    failures = []
    stored = {segment['id']: segment for segment in segments or []}
    body = (payload or {}).get('content') or (payload or {}).get('answer') or ''
    citations = (payload or {}).get('citations') or []
    if not body.strip():
        failures.append(f'{label}: empty text')
    if not stored:
        failures.append(f'{label}: no stored transcript segment to cite')
    if not citations:
        failures.append(f'{label}: no citations')
    for index, citation in enumerate(citations):
        source_id = citation.get('segment_id')
        source = stored.get(source_id)
        if source is None:
            failures.append(f'{label}: citation {index} cites unknown source {source_id!r}')
            continue
        start, end = citation.get('start_ms'), citation.get('end_ms')
        if (start, end) != (source['start_ms'], source['end_ms']):
            failures.append(
                f'{label}: citation {index} ({source_id}) claims {start}-{end} ms,'
                f' stored segment is {source["start_ms"]}-{source["end_ms"]} ms')
        elif not isinstance(start, int) or not isinstance(end, int) or end <= start:
            failures.append(f'{label}: citation {index} ({source_id}) has no positive time span')
        if citation.get('text') != source['text']:
            failures.append(f'{label}: citation {index} ({source_id}) text differs from the stored segment')
    return failures


async def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--asr-only',action='store_true')
    parser.add_argument('--asr-model',default='qwen/qwen3-asr-1.7b')
    parser.add_argument('--audio',type=Path,default=ROOT/'.runtime/jfk.wav')
    parser.add_argument('--chunk-seconds',type=int,choices=[5,10,15,30],default=5)
    args=parser.parse_args()
    run_id=time.strftime('%Y%m%d-%H%M%S')+'-'+secrets.token_hex(3)
    out=ROOT/'.runtime'/('live-'+run_id)
    out.mkdir(parents=True)
    wav=args.audio.read_bytes()
    token=secrets.token_urlsafe(32)
    provider_calls=[]
    async def observe(response:httpx.Response):
        if response.request.method!='POST': return
        await response.aread()
        try: data=response.json()
        except ValueError: return
        provider_calls.append({'status':response.status_code,'id':data.get('id'),'model':data.get('model'),'usage':data.get('usage')})
    outgoing=httpx.AsyncClient(event_hooks={'response':[observe]},timeout=90)
    app=create_app(AppConfig(token=token,data_dir=out/'data'),secret_store=MemorySecretStore({'openrouter':project_key()}),http_client=outgoing)
    is_jfk=args.audio.resolve()==(ROOT/'.runtime/jfk.wav').resolve()
    failures=[]
    report={'scope':'backend API in-process, real outward HTTP; not physical microphone/desktop','audio_sha256':hashlib.sha256(wav).hexdigest(),'reference':REFERENCE if is_jfk else None,'checks':'structural grounding and persistence only; not a judgement of answer or notes quality','failures':failures,'provider_calls':provider_calls}
    try:
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1:8765',headers={'Authorization':'Bearer '+token},timeout=120) as client:
                async def request(method,path,**kwargs):
                    response=await client.request(method,path,**kwargs)
                    if response.status_code>=400:
                        raise http_failure(report,method,path,response.status_code,response.text)
                    return response.json()
                report['requested_asr_model']=args.asr_model
                await request('PUT','/settings',json={'asr':{'provider':'openrouter','model':args.asr_model},'agent':{'provider':'openrouter','model':'qwen/qwen3-30b-a3b-instruct-2507'},'notes':{'provider':'openrouter','model':'qwen/qwen3-30b-a3b-instruct-2507'},'cloud_consent':True,'transcript_language':'auto','output_language':'ru'})
                session=await request('POST','/sessions',json={'title':'Live smoke — '+args.audio.stem})
                sid=session['id']; report['session_id']=sid
                with wave.open(io.BytesIO(wav),'rb') as audio:
                    rate=audio.getframerate(); params=audio.getparams(); pcm=audio.readframes(audio.getnframes())
                width=params.sampwidth*params.nchannels
                # Attached before the loop, so the windows already uploaded stay in the
                # report when a later chunk fails.
                windows=report['windows']=[]; start=0
                for seq, offset in enumerate(range(0,len(pcm),rate*width*args.chunk_seconds)):
                    part=pcm[offset:offset+rate*width*args.chunk_seconds]; end=start+round(len(part)/width/rate*1000)
                    buf=io.BytesIO()
                    with wave.open(buf,'wb') as chunk:
                        chunk.setparams(params); chunk.writeframes(part)
                    started=time.perf_counter()
                    body=await request('POST',f'/sessions/{sid}/audio',params={'sequence':seq,'start_ms':start,'end_ms':end},content=buf.getvalue(),headers={'Content-Type':'audio/wav'})
                    windows.append({'sequence':seq,'start_ms':start,'end_ms':end,'seconds':round(time.perf_counter()-started,3),'result':body})
                    start=end
                detail=await request('GET',f'/sessions/{sid}')
                report['transcript']=' '.join(s['text'] for s in detail['segments'])
                if not detail['segments']:
                    raise SmokeFailure('no real transcript returned; nothing downstream can be checked')
                if is_jfk and 'country' not in report['transcript'].lower():
                    failures.append('transcript: known content of the reference audio is missing')
                if not args.asr_only:
                    started=time.perf_counter()
                    report['answer']=await request('POST',f'/sessions/{sid}/ask',json={'question':'Что я пропустил из последнего? Ответь кратко по-русски.','scope':'auto','window_minutes':5})
                    report['answer_seconds']=round(time.perf_counter()-started,3)
                    failures.extend(citation_failures('answer',report['answer'],detail['segments']))
                    report['absent_question']=await request('POST',f'/sessions/{sid}/ask',json={'question':'Какой бюджет проекта назвали в долларах?','scope':'all','window_minutes':5})
                    await request('PATCH',f'/sessions/{sid}',json={'status':'stopped'})
                    started=time.perf_counter()
                    report['notes']=await request('POST',f'/sessions/{sid}/notes',json={'language':'ru'})
                    report['notes_seconds']=round(time.perf_counter()-started,3)
                    persisted=await request('GET',f'/sessions/{sid}')
                    report['persisted_messages']=len(persisted['messages'])
                    # The notes must cite the stored transcript, and the saved note must be the
                    # one that was returned: an ungrounded or unsaved note is a failed run.
                    failures.extend(citation_failures('notes',report['notes'],persisted['segments']))
                    failures.extend(citation_failures('persisted notes',persisted['notes'],persisted['segments']))
                    if (persisted['notes'] or {}).get('content')!=report['notes']['content']:
                        failures.append('notes: the persisted note differs from the returned one')
    except Exception as error:
        aborted(report,failures,error)
    reported_costs=[(x.get('usage') or {}).get('cost') for x in provider_calls]
    report['reported_api_cost_usd']=sum(c for c in reported_costs if isinstance(c,(int,float)))
    report['calls_without_reported_cost']=sum(c is None for c in reported_costs)
    finish(report,failures,out)

if __name__=='__main__': asyncio.run(main())
