"""Discover the specialized STT catalog, distinct from audio-input LLMs."""
import json
import urllib.request
from check_openrouter import ROOT, project_key
url='https://openrouter.ai/api/v1/models?output_modalities=transcription'
with urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Bearer '+project_key()}),timeout=40) as response:
    data=json.load(response)
(ROOT/'.runtime/stt-models.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
for model in data.get('data',[]):
    print(json.dumps({k:model.get(k) for k in ('id','architecture','pricing')},ensure_ascii=False))
