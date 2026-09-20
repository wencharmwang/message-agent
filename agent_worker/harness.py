"""Deliver new turns to the contact's persistent native Harness Session."""
import json
import sqlite3
from contextlib import closing
from pathlib import Path
import urllib.request
import urllib.error
from .decision import validate_decision

class Harness:
    def __init__(self, config):
        self.config = config
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def run(self, rule, job):
        token = Path(self.config['control_token_file']).read_text().strip()
        legacy_ids, deliveries = [], []
        auto_model = self.config['model']
        auto_provider = 'deepseek-official'
        if self.config.get('database') and Path(self.config['database']).exists():
            with closing(sqlite3.connect(Path(self.config['database']).as_uri() + '?mode=ro', uri=True)) as db:
                rows = db.execute('SELECT id,state,text,detail FROM reply_jobs WHERE provider=? AND conversation=? AND id<>? ORDER BY created_at DESC LIMIT 100',
                                  (job['provider'], job['conversation'], job['id'])).fetchall()
                model_row = db.execute("SELECT value FROM runtime_settings WHERE key='auto_model'").fetchone()
                provider_row = db.execute("SELECT value FROM runtime_settings WHERE key='auto_provider'").fetchone()
            legacy_ids = ['messaging-' + row[0] for row in rows]
            deliveries = [{'state': row[1], 'text': row[2]} for row in rows[:3]]
            if model_row and model_row[0]:
                auto_model = model_row[0]
            if provider_row and provider_row[0]:
                auto_provider = provider_row[0]
        payload = json.dumps({'rule': rule, 'job': job, 'legacy_session_ids': legacy_ids,
                              'recent_deliveries': deliveries, 'auto_model': auto_model,
                              'auto_provider': auto_provider}, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(f"http://127.0.0.1:{self.config['harness_port']}/message-agent/job",payload,
                    headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        try:
            with self.opener.open(request, timeout=self.config['response_timeout_seconds']+30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            # The loopback host has already recorded provider details. Keep wire
            # bodies and possible model output out of the settings UI.
            raise RuntimeError('Harness generation failed') from error
        self.last_session_id = result['session_id']
        return validate_decision(result['response'],job,self.config['max_reply_chars'])
    def close(self):
        pass  # Host owns Session lifecycle; closing one worker job must not kill the Web UI.

