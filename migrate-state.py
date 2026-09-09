"""One-time stopped-worker migration: preserve rules, receipts, and authorization material."""
import json
from pathlib import Path
import shutil
import sqlite3

target=Path(r'C:\Users\Wencharm\Documents\projects\message-agent')/'data'
source=Path(r'C:\Users\Wencharm\Documents\projects\messaging-runtime')/'.runtime-data/auto-reply'
target.mkdir(parents=True,exist_ok=True)
if not (target/'reply.db').exists():
    with sqlite3.connect(source/'reply.db') as old, sqlite3.connect(target/'reply.db') as new:
        old.backup(new)
for name in ('worker.token','control.token'):
    if not (target/name).exists():
        shutil.copy2(source/name,target/name)
print('Upper-layer state prepared; legacy state retained for rollback.')
