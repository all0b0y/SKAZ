# API contract v0 — shared implementation boundary

All API routes (except GET /health) require Authorization: Bearer <per-run token>. Bind 127.0.0.1; token passed to Python by env AUDIOHELPER_TOKEN, data dir AUDIOHELPER_DATA_DIR. Python entry `uv run --project backend python -m audiohelper --port N` from repo root, or backend .venv Python with PYTHONPATH backend/src. Desktop main chooses free port, spawns, polls health before exposing connection through preload. No secrets in renderer storage.

JSON camel_case? **Use snake_case throughout API.** IDs strings. Times integer milliseconds relative to recording audio timeline, pauses excluded for v0. HTTP error detail string. All return shapes below mandatory; additional fields allowed.

- GET /health → {status:"ok"}
- GET /settings → {asr:Profile,agent:Profile,notes:Profile,transcript_language:"auto",output_language:"ru",cloud_consent:false}. Profile {provider,model,base_url?,has_api_key?:bool}. Never return keys. Defaults asr local-whisper/small; agent and notes openrouter/empty (unconfigured).
- PUT /settings body same keys partial; profiles optionally api_key for write only; response sanitized full settings. Reject incompatible known ASR model/task profiles. Provider names: local-whisper, openai, openrouter, anthropic, openai-compatible. Optional local development connector claude-code ONLY if explicitly enabled, tools disabled and not advertised as third-party OAuth. Do not implement token extraction.
- GET /models?provider=P&task=asr|agent|notes → {models:[{id,name,input_modalities:string[],verified:bool}],error?:string}. No speculative family list. For unknown custom ASR demand supported adapter metadata; audio-input catalog alone not verified ASR.
- GET /sessions → {sessions:[Session]}
- POST /sessions {title:string} → Session
- GET /sessions/{id} → {session:Session,segments:Segment[],messages:Message[],notes:Note|null}
- PATCH /sessions/{id} {status:"recording"|"paused"|"stopped",title?:string} → Session
- DELETE /sessions/{id} → {deleted:true}
- POST /sessions/{id}/audio?sequence=N&start_ms=N&end_ms=N Content-Type audio/wav body standalone PCM16 mono WAV (device sample rate accepted, backend resamples local ASR as needed), ≤30sec; response {segments:Segment[],duplicate:bool}. Sequential processing per session; UI bounded pending queue and displays pending count. Persist actual audio and dedupe sequence, reject sequence reuse with changed content; don't lose failed chunks. No WebSocket required in v0: returned chunk segments visible while subsequent chunks record.
- POST /sessions/{id}/ask {question:string,window_minutes:5,scope:"auto"|"recent"|"all"|"beginning"|"search",language?:string} → {answer:string,citations:Citation[],context:{start_ms:int,end_ms:int,scope:string},model:string}. Nonstream response v0; isolate requests so ASR continues. Future streaming optional, not invented in UI. Save question/answer as Message. auto must recognize explicit minutes and beginning in question before default window, topical search across recording for referential questions. Safe refusals for no transcript. Bound context and show truncation if needed.
- POST /sessions/{id}/notes {language?:string} → Note
- GET /sessions/{id}/audio/{sequence} → original WAV (authenticated) for playback.

Session {id,title,created_at:string,status, duration_ms:int}; Segment {id,start_ms,end_ms,text,language?:string}; Message {id,role:"user"|"assistant",content,created_at,citations?:Citation[]}; Citation {segment_id,start_ms,end_ms,text}; Note {content,created_at,model,citations:Citation[]}.

Tests exercise these public seams with fake external gateway only in deterministic tests; real integration is a separate command. No mocks enabled by default in shipped app. Contract changes require coordinator update before other agent depends on them.
