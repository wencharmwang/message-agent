"""Exercise the real Harness with a simulated messaging provider; never calls WeChat."""
import argparse
import json
from pathlib import Path
import tempfile
from .__main__ import load_config
from .harness import Harness
from .service import Worker


def message(text, direction='incoming'):
    return {'direction': direction, 'content': text, 'sender': None, 'type': 'text'}


class SimulatedMessaging:
    def __init__(self):
        self.messages = [message('这是本地联调测试。'), message('准备好了。', 'outgoing')]
        self.sends = []

    def observe(self, rule):
        return list(self.messages)

    def call(self, name, args):
        if name != 'send_message':
            raise AssertionError('Unexpected tool: ' + name)
        self.sends.append(args)
        self.messages.append(message(args['text'], 'outgoing'))
        return {'status': 'sent'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    config = load_config(args.config)
    with tempfile.TemporaryDirectory() as temp:
        config.update(database=str(Path(temp) / 'smoke.db'), settle_seconds=0, min_reply_interval_seconds=0)
        messaging = SimulatedMessaging()
        worker = Worker(config, messaging, Harness(config))
        rule_id = worker.store.add('simulation', 'local-test', '本地联调', 'direct', '友好简短地回复。对方询问你的作用时，说明你能自动回复新消息。')
        worker.store.enable(rule_id, True)
        worker.tick()
        messaging.messages.append(message('你好，你能做什么？'))
        worker.tick()
        worker.tick()
        for _ in range(3):
            worker.tick()
        jobs = worker.store.recent()
        if len(messaging.sends) != 1 or len(jobs) != 1 or jobs[0]['state'] != 'sent':
            raise RuntimeError('Real Harness pipeline smoke failed: ' + json.dumps(jobs, ensure_ascii=False))
        worker.store.enable(rule_id, False)
        messaging.messages.append(message('暂停后不应该再回复。'))
        worker.tick()
        assert len(messaging.sends) == 1
        result = {'ok': True, 'real_harness': True, 'simulated_messaging': True, 'wechat_messages_sent': 0,
                  'automatic_replies': len(messaging.sends), 'reply': messaging.sends[0]['text'],
                  'pause_verified': True, 'duplicate_suppression_verified': True}
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
