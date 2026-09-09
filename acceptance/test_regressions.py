"""Coordinator acceptance regressions at the HTTP API seam.

These are deterministic boundary tests, NOT live model-quality evidence.
Only the external HTTP transport is stubbed; the production app handles requests.
"""
import io
import json
import wave

import httpx
import pytest
import pytest_asyncio
from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.secrets import MemorySecretStore

MODEL='google/gemini-2.5-flash-lite'

@pytest_asyncio.fixture
async def api(tmp_path):
    state={'speech':'Согласовали перенос отгрузки на пятницу.','calls':[]}
    def outbound(request):
        state['calls'].append(request)
        if request.method=='GET':
            return httpx.Response(200,json={'data':[{'id':MODEL,'name':'Gemini','architecture':{'input_modalities':['text','audio'],'output_modalities':['text']}},{'id':'qwen/qwen3-30b-a3b-instruct-2507','name':'Qwen','architecture':{'input_modalities':['text'],'output_modalities':['text']}}]})
        body=json.loads(request.content)
        is_audio=isinstance(body['messages'][-1]['content'],list)
        return httpx.Response(200,json={'model':body['model'],'choices':[{'message':{'role':'assistant','content':state['speech'] if is_audio else 'Согласовали перенос [S1].'}}]})
    app=create_app(AppConfig(token='acceptance-token',data_dir=tmp_path),secret_store=MemorySecretStore({'openrouter':'test-not-a-real-key'}),http_client=httpx.AsyncClient(transport=httpx.MockTransport(outbound)))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1:8000',headers={'Authorization':'Bearer acceptance-token'}) as client:
            response=await client.put('/settings',json={'asr':{'provider':'openrouter','model':MODEL},'agent':{'provider':'openrouter','model':'qwen/qwen3-30b-a3b-instruct-2507'},'notes':{'provider':'openrouter','model':'qwen/qwen3-30b-a3b-instruct-2507'},'cloud_consent':True})
            assert response.status_code==200,response.text
            sid=(await client.post('/sessions',json={'title':'Acceptance fixture'})).json()['id']
            buf=io.BytesIO()
            with wave.open(buf,'wb') as wav:
                wav.setparams((1,2,16000,0,'NONE','not compressed')); wav.writeframes(b'\x01\x10'*16000)
            async def upload(sequence,start,text):
                state['speech']=text
                response=await client.post(f'/sessions/{sid}/audio',params={'sequence':sequence,'start_ms':start,'end_ms':start+1000},content=buf.getvalue(),headers={'Content-Type':'audio/wav'})
                assert response.status_code==200,response.text
            yield client,sid,state,upload

@pytest.mark.asyncio
async def test_cloud_consent_revocation_blocks_question_and_notes(api):
    client,sid,state,upload=api
    await upload(0,0,'Встреча посвящена отгрузке товара.')
    assert (await client.put('/settings',json={'cloud_consent':False})).status_code==200
    state['calls'].clear()
    question=await client.post(f'/sessions/{sid}/ask',json={'question':'Что я пропустил?'})
    notes=await client.post(f'/sessions/{sid}/notes',json={})
    assert question.status_code in (400,403),question.text
    assert notes.status_code in (400,403),notes.text
    assert not [r for r in state['calls'] if r.method=='POST'],'Text leaked to cloud after consent revoked'

@pytest.mark.asyncio
async def test_current_discussion_question_uses_recent_scope(api):
    client,sid,state,upload=api
    await upload(0,0,'В начале определили бюджет проекта.')
    await upload(1,700000,'Договорились перенести отгрузку на пятницу.')
    response=await client.post(f'/sessions/{sid}/ask',json={'question':'Что сейчас обсуждают?','scope':'auto'})
    assert response.status_code==200,response.text
    assert response.json()['context']['scope']=='recent'
    post=json.loads([r for r in state['calls'] if r.method=='POST'][-1].content)
    context=post['messages'][-1]['content']
    assert 'перенести отгрузку' in context
    assert 'В начале определили бюджет' not in context

@pytest.mark.asyncio
async def test_first_five_minutes_does_not_select_last_five(api):
    client,sid,state,upload=api
    await upload(0,0,'В начале определили бюджет проекта.')
    await upload(1,700000,'Договорились перенести отгрузку на пятницу.')
    response=await client.post(f'/sessions/{sid}/ask',json={'question':'Что сказали в первые 5 минут?','scope':'auto'})
    assert response.status_code==200,response.text
    body=response.json()
    assert body['context']['scope']=='beginning',body
    post=json.loads([r for r in state['calls'] if r.method=='POST'][-1].content)
    context=post['messages'][-1]['content']
    assert 'В начале определили бюджет' in context
    assert 'перенести отгрузку' not in context

@pytest.mark.asyncio
async def test_request_for_audio_is_not_a_verified_transcription(api):
    client,sid,state,upload=api
    await upload(0,0,'Could you please provide the audio file or its transcript so I can transcribe it for you?')
    models=(await client.get('/models',params={'provider':'openrouter','task':'asr'})).json()['models']
    candidate=next(m for m in models if m['id']==MODEL)
    assert candidate['verified'] is False,'Any nonempty text currently masquerades as verified ASR'


# --- added coverage -----------------------------------------------------------
# New assertions only; nothing above is relaxed.

@pytest.mark.asyncio
async def test_audio_input_llm_is_offered_only_as_an_explicit_legacy_choice(api):
    """An audio-input chat model is a candidate, never the default ASR contract."""
    client,sid,state,upload=api
    models=(await client.get('/models',params={'provider':'openrouter','task':'asr'})).json()['models']
    candidate=next(m for m in models if m['id']==MODEL)
    assert candidate['asr_contract']=='legacy',candidate
    assert candidate['recommended'] is False
    assert 'not a dedicated' in candidate['note'].lower()
    assert [m['id'] for m in models if m['asr_contract']=='dedicated']==[],'this catalog has no STT model'
    assert 'qwen/qwen3-30b-a3b-instruct-2507' not in [m['id'] for m in models],'text LLM is not an ASR option'


@pytest.mark.asyncio
async def test_legacy_audio_chat_stays_unverified_after_a_successful_call(api):
    """Transport success through the legacy adapter is not ASR verification."""
    client,sid,state,upload=api
    await upload(0,0,'Совершенно нормальный текст, похожий на транскрипт.')
    asr=(await client.get('/settings')).json()['asr']
    assert asr['verified'] is False
    assert 'audio input' in asr['verification_note'].lower()


@pytest.mark.asyncio
async def test_follow_up_question_keeps_history_notes_and_original_sources(api):
    client,sid,state,upload=api
    await upload(0,0,'В начале определили бюджет проекта.')
    await upload(1,700000,'Договорились перенести отгрузку на пятницу.')
    first=await client.post(f'/sessions/{sid}/ask',json={'question':'Что определили в начале?','scope':'beginning'})
    assert first.status_code==200,first.text
    assert first.json()['citations'],'the first answer must cite a real segment'
    assert (await client.post(f'/sessions/{sid}/notes',json={})).status_code==200
    second=await client.post(f'/sessions/{sid}/ask',json={'question':'А почему именно так?','scope':'recent'})
    assert second.status_code==200,second.text
    sent='\n'.join(str(m.get('content','')) for m in json.loads([r for r in state['calls'] if r.method=='POST'][-1].content)['messages'])
    assert 'Что определили в начале?' in sent,'the follow-up must see the chat history'
    assert 'В начале определили бюджет' in sent,'the follow-up must keep the original cited source'
    assert second.json()['context']['scope']=='recent'
    assert second.json()['context']['start_ms']>=700000-5*60000,'carried sources must not widen the window'


@pytest.mark.asyncio
async def test_empty_search_does_not_claim_absence_beyond_lexical_evidence(api):
    client,sid,state,upload=api
    await upload(0,0,'В начале определили бюджет проекта.')
    response=await client.post(f'/sessions/{sid}/ask',json={'question':'Когда обсуждали блокчейн-регламент?','scope':'search'})
    assert response.status_code==200,response.text
    assert response.json()['citations']==[]
    sent=json.loads([r for r in state['calls'] if r.method=='POST'][-1].content)['messages'][-1]['content'].lower()
    assert 'no lexical match' in sent
    assert 'do not claim the entire recording definitively lacks the topic' in sent


@pytest.mark.asyncio
async def test_gist_and_notes_prompts_forbid_chunk_boundary_bullets(api):
    """Adjacent chunks must be combined; a stray trailing word is not a point.

    Mirrors the live JFK failure: one sentence cut into three contiguous windows
    whose last window holds only the closing word.
    """
    client,sid,state,upload=api
    await upload(0,0,'Мы начали обсуждать план поставки и')
    await upload(1,1000,'закончили его на')
    await upload(2,2000,'пятнице.')
    assert (await client.post(f'/sessions/{sid}/ask',json={'question':'Что обсуждают?'})).status_code==200
    last=json.loads([r for r in state['calls'] if r.method=='POST'][-1].content)['messages']
    ask_system=last[0]['content'].lower()
    supplied=last[-1]['content']
    # The ask path now supplies the passage already joined, as the notes path does: the
    # chunk edges are gone from the text instead of only being tagged as continuous.
    assert 'Мы начали обсуждать план поставки и закончили его на пятнице.' in supplied,\
        'fragments must arrive as one passage'
    assert '[P1] ' in supplied and '(segments S1-S3)' in supplied,\
        'the joined passage is citable and every contributing segment stays addressable'
    assert 'one continuous passage' in ask_system
    assert 'sentence fragment' in ask_system
    assert '[s2-s4]' in ask_system,'the range citation form must be offered'
    assert (await client.post(f'/sessions/{sid}/notes',json={})).status_code==200
    notes=json.loads([r for r in state['calls'] if r.method=='POST'][-1].content)['messages']
    notes_system=notes[0]['content'].lower()
    notes_supplied=notes[-1]['content']
    # Notes see the passage already joined, so a chunk edge cannot become a bullet.
    assert '[P1] ' in notes_supplied
    assert 'Мы начали обсуждать план поставки и закончили его на пятнице.' in notes_supplied
    assert '(segments S1-S3)' in notes_supplied,'every contributing segment stays addressable'
    assert 'one continuous passage' in notes_supplied.lower()
    assert 'one continuous stretch of speech' in notes_system
    assert 'at most one point per passage' in notes_system
    assert 'never split one passage into several points' in notes_system
    assert 'never a fragment or the tail of it' in notes_system


@pytest.mark.asyncio
async def test_range_citation_resolves_to_every_contributing_segment(stt_api):
    """A claim spanning a passage must carry provenance for all of its lines."""
    client,sid,state,wav=stt_api
    for sequence,(start,text) in enumerate([
        (0,'And so, my fellow Americans, ask not.'),
        (1000,'What your country can do for you, ask what you can do for your.'),
        (2000,'Country.'),
    ]):
        state['reply']={'text':text}
        response=await client.post(f'/sessions/{sid}/audio',params={'sequence':sequence,'start_ms':start,'end_ms':start+1000},content=wav,headers={'Content-Type':'audio/wav'})
        assert response.status_code==200,response.text
    state['answer']='Призыв служить стране [S1-S3].'
    answer=await client.post(f'/sessions/{sid}/ask',json={'question':'Что обсуждают?','scope':'all'})
    assert answer.status_code==200,answer.text
    body=answer.json()
    assert len(body['citations'])==3,'a range must cite every contributing segment'
    assert [c['text'] for c in body['citations']][-1]=='Country.'
    assert [c['start_ms'] for c in body['citations']]==[0,1000,2000],'citations stay in timeline order'
    detail=(await client.get(f'/sessions/{sid}')).json()
    known={s['id'] for s in detail['segments']}
    assert all(c['segment_id'] in known for c in body['citations']),'every citation resolves to a real segment'


@pytest.mark.asyncio
async def test_range_citation_never_reaches_outside_the_requested_scope(stt_api):
    """Grouping must widen provenance, not the temporal window."""
    client,sid,state,wav=stt_api
    for sequence,(start,text) in enumerate([(0,'Ранняя тема про бюджет.'),(600000,'Сейчас про отгрузку.')]):
        state['reply']={'text':text}
        assert (await client.post(f'/sessions/{sid}/audio',params={'sequence':sequence,'start_ms':start,'end_ms':start+1000},content=wav,headers={'Content-Type':'audio/wav'})).status_code==200
    state['answer']='Обсуждают отгрузку [S1-S9].'
    answer=await client.post(f'/sessions/{sid}/ask',json={'question':'Что сейчас обсуждают?','scope':'recent'})
    assert answer.status_code==200,answer.text
    body=answer.json()
    assert body['context']['scope']=='recent'
    assert [c['text'] for c in body['citations']]==['Сейчас про отгрузку.'],'out-of-window labels stay unresolved'
    supplied=json.loads([r for r in state['calls'] if r.method=='POST'][-1].content)['messages'][-1]['content']
    assert 'Ранняя тема про бюджет' not in supplied


# --- dedicated OpenRouter STT contract (separate fixture; the one above is legacy audio-chat) ---

STT='qwen/qwen3-asr-1.7b'

@pytest_asyncio.fixture
async def stt_api(tmp_path):
    state={'calls':[],'reply':{'text':'Согласовали перенос отгрузки на пятницу.'},'answer':'Согласовали перенос [S1].'}
    def outbound(request):
        state['calls'].append(request)
        if request.method=='GET':
            return httpx.Response(200,json={'data':[
                {'id':STT,'name':'Qwen3 ASR','architecture':{'modality':'audio->transcription','input_modalities':['audio'],'output_modalities':['transcription']},'pricing':{'prompt':'0.0000075','completion':'0'},'top_provider':{'max_completion_tokens':0}},
                {'id':MODEL,'name':'Gemini','architecture':{'input_modalities':['text','audio'],'output_modalities':['text']}},
                {'id':'qwen/qwen3-30b-a3b-instruct-2507','name':'Qwen','architecture':{'input_modalities':['text'],'output_modalities':['text']}}]})
        if 'audio/transcriptions' in str(request.url):
            return httpx.Response(200,json=state['reply'])
        return httpx.Response(200,json={'model':'qwen/qwen3-30b-a3b-instruct-2507','choices':[{'message':{'role':'assistant','content':state['answer']}}]})
    app=create_app(AppConfig(token='acceptance-token',data_dir=tmp_path),secret_store=MemorySecretStore({'openrouter':'test-not-a-real-key'}),http_client=httpx.AsyncClient(transport=httpx.MockTransport(outbound)))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1:8000',headers={'Authorization':'Bearer acceptance-token'}) as client:
            response=await client.put('/settings',json={'asr':{'provider':'openrouter','model':STT},'agent':{'provider':'openrouter','model':'qwen/qwen3-30b-a3b-instruct-2507'},'notes':{'provider':'openrouter','model':'qwen/qwen3-30b-a3b-instruct-2507'},'cloud_consent':True})
            assert response.status_code==200,response.text
            sid=(await client.post('/sessions',json={'title':'Dedicated STT'})).json()['id']
            buf=io.BytesIO()
            with wave.open(buf,'wb') as wav:
                wav.setparams((1,2,16000,0,'NONE','not compressed')); wav.writeframes(b'\x01\x10'*16000)
            yield client,sid,state,buf.getvalue()


@pytest.mark.asyncio
async def test_dedicated_stt_uses_the_transcriptions_endpoint_not_chat(stt_api):
    """The live contract the coordinator will exercise: POST /api/v1/audio/transcriptions."""
    client,sid,state,wav=stt_api
    response=await client.post(f'/sessions/{sid}/audio',params={'sequence':0,'start_ms':0,'end_ms':1000},content=wav,headers={'Content-Type':'audio/wav'})
    assert response.status_code==200,response.text
    assert [s['text'] for s in response.json()['segments']]==['Согласовали перенос отгрузки на пятницу.']
    post=[r for r in state['calls'] if r.method=='POST'][-1]
    assert str(post.url)=='https://openrouter.ai/api/v1/audio/transcriptions'
    body=json.loads(post.content)
    assert body['model']==STT
    assert body['response_format']=='json'
    assert body['input_audio']['format']=='wav'
    assert body['input_audio']['data'],'audio must be sent as base64'
    assert 'language' not in body,'auto detection must omit language, not send "auto"'
    assert not [r for r in state['calls'] if r.method=='POST' and 'chat/completions' in str(r.url)]


@pytest.mark.asyncio
async def test_dedicated_stt_becomes_verified_only_after_a_real_transcription(stt_api):
    client,sid,state,wav=stt_api
    before=(await client.get('/models',params={'provider':'openrouter','task':'asr'})).json()['models']
    candidate=next(m for m in before if m['id']==STT)
    assert candidate['asr_contract']=='dedicated'
    assert candidate['recommended'] is True
    assert candidate['pricing']=={'amount_usd':0.0000075,'unit':'second'}
    assert candidate['verified'] is False,'catalog membership is not verification'
    assert (await client.get('/settings')).json()['asr']['verified'] is False
    response=await client.post(f'/sessions/{sid}/audio',params={'sequence':0,'start_ms':0,'end_ms':1000},content=wav,headers={'Content-Type':'audio/wav'})
    assert response.status_code==200,response.text
    assert (await client.get('/settings')).json()['asr']['verified'] is True
    after=next(m for m in (await client.get('/models',params={'provider':'openrouter','task':'asr'})).json()['models'] if m['id']==STT)
    assert after['verified'] is True


@pytest.mark.asyncio
async def test_empty_dedicated_transcription_does_not_count_as_verification(stt_api):
    """Silence is a real 200 with no speech; it must not prove the model transcribes."""
    client,sid,state,wav=stt_api
    state['reply']={'text':'   '}
    response=await client.post(f'/sessions/{sid}/audio',params={'sequence':0,'start_ms':0,'end_ms':1000},content=wav,headers={'Content-Type':'audio/wav'})
    assert response.status_code==200,response.text
    assert response.json()['segments']==[]
    assert (await client.get('/settings')).json()['asr']['verified'] is False


@pytest.mark.asyncio
async def test_consent_revocation_blocks_audio_before_any_outbound_post(stt_api):
    client,sid,state,wav=stt_api
    assert (await client.put('/settings',json={'cloud_consent':False})).status_code==200
    state['calls'].clear()
    response=await client.post(f'/sessions/{sid}/audio',params={'sequence':0,'start_ms':0,'end_ms':1000},content=wav,headers={'Content-Type':'audio/wav'})
    assert response.status_code in (400,403),response.text
    assert 'consent' in response.json()['detail'].lower()
    assert not [r for r in state['calls'] if r.method=='POST'],'Audio leaked to cloud after consent revoked'
