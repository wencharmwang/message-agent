import json
from pathlib import Path

def read_dotenv(path):
    result = {}
    if Path(path).is_file():
        for line in Path(path).read_text(encoding='utf-8-sig').splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.removeprefix('export ').split('=', 1)
            if key.strip() in ('DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'):
                result[key.strip()] = value.strip().strip('\"\'')
    return result


def validate_decision(response, job, max_chars):
    decision = json.loads(response)
    required = {'job_id', 'event_id', 'action', 'text'}
    if not isinstance(decision, dict) or not required <= set(decision) or set(decision) - required - {'reason'}:
        raise ValueError('Invalid reply decision fields')
    if 'reason' in decision and (not isinstance(decision['reason'], str) or len(decision['reason']) > 500):
        raise ValueError('Invalid reply reason')
    if decision['job_id'] != job['id'] or decision['event_id'] != job['event_id']:
        raise ValueError('Reply decision belongs to a different event')
    action, text = decision['action'], decision['text']
    if action not in ('reply', 'skip', 'needs_user') or not isinstance(text, str):
        raise ValueError('Invalid reply decision')
    if action == 'reply' and (not text.strip() or len(text) > max_chars or any(ord(c) < 32 or ord(c) == 127 for c in text)):
        raise ValueError('Reply must be bounded single-line text')
    if action != 'reply' and text != '':
        raise ValueError('Non-reply decision must have empty text')
    return decision

