"""Read-only discovery; never print the project credential."""
import json
import os
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def project_key() -> str:
    for name in ('OPENROUTER_API_KEY', 'OPEN_ROUTER_KEY'):
        if os.getenv(name):
            return os.environ[name]
    for line in (ROOT / '.env').read_text().splitlines():
        name, sep, value = line.strip().partition('=')
        if sep and name.strip() in ('OPENROUTER_API_KEY', 'OPEN_ROUTER_KEY'):
            return value.strip().strip('\"').strip("'")
    raise RuntimeError('OpenRouter key not configured')

if __name__ == '__main__':
    headers = {'Authorization': f'Bearer {project_key()}'}
    def get(path):
        with urllib.request.urlopen(urllib.request.Request('https://openrouter.ai/api/v1/' + path, headers=headers), timeout=40) as response:
            return json.load(response)
    info = get('key')['data']
    print('Key accepted:', {k:info.get(k) for k in ('limit','limit_remaining','is_free_tier')})
    catalog = get('models')['data']
    target = ROOT / '.runtime'
    target.mkdir(exist_ok=True)
    (target/'openrouter-models.json').write_text(json.dumps(catalog,ensure_ascii=False))
    audio = [m for m in catalog if 'audio' in m.get('architecture',{}).get('input_modalities',[])]
    print('Audio-input models (NOT proof of ASR quality):')
    for m in sorted(audio,key=lambda m:float(m.get('pricing',{}).get('prompt','inf'))):
        print(json.dumps({k:m.get(k) for k in ('id','architecture','pricing')},ensure_ascii=False))
    print('Text candidates:')
    for m in catalog:
        if any(part in m['id'] for part in ('qwen3.5','qwen3-','deepseek-v3','gemini-2.5-flash')):
            print(json.dumps({k:m.get(k) for k in ('id','pricing')},ensure_ascii=False))
