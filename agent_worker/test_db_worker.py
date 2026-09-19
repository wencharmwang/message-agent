"""DB 方案下 Worker 事件处理的单元测试。

不依赖真实微信 / runtime / deepseek：mock Mcp 与 Harness，注入 fake watcher，
验证事件 → 历史 → enqueue → pre-send 复查的闭环。
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agent_worker.service import Worker


def _event(username, direction, text, local_type=1, sort_seq=1000):
    return {
        "username": username, "display": "好友", "direction": direction,
        "sender": "好友" if direction == "incoming" else None,
        "text": text, "local_type": local_type, "type": "文本",
        "create_time": 100, "sort_seq": sort_seq, "local_id": 1,
    }


class FakeMcp:
    def __init__(self):
        self.sent = []

    def call(self, name, arguments):
        if name == "send_message":
            self.sent.append(arguments)
            return {"status": "sent"}
        if name == "get_send_status":
            return {"status": "sent"}
        return {}

    def observe(self, rule, limit=30):
        return []


class FakeHarness:
    def __init__(self, decision=None):
        self.decision = decision or {"action": "reply", "text": "自动回复"}

    def run(self, rule, job):
        return dict(self.decision)

    def close(self):
        pass


class FakeWatcher:
    def __init__(self):
        self.events = []

    def poll(self):
        events, self.events = self.events, []
        return events


class WorkerDbWatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db = Path(self.tmp.name) / "reply.db"
        self.config = {
            "database": str(db),
            "runtime_settings_file": str(Path(self.tmp.name) / "settings.json"),
            "worker_token_file": str(Path(self.tmp.name) / "token"),
            "poll_interval_seconds": 5,
            "job_ttl_seconds": 300,
            "min_reply_interval_seconds": 0,
            "watcher_python": "python",
            "watcher_src": "src",
        }
        self.mcp = FakeMcp()
        self.harness = FakeHarness()
        self.worker = Worker(self.config, mcp=self.mcp, harness=self.harness)
        self.fake_watcher = FakeWatcher()
        self.worker._watcher = lambda: self.fake_watcher

    def tearDown(self):
        self.worker.close()
        self.tmp.cleanup()

    def _add_rule(self, username, kind="direct"):
        rule_id = self.worker.store.add("wechat-main", username, "好友", kind, "礼貌回复")
        self.worker.store.enable(rule_id, True)
        return rule_id

    def test_ingest_flags_incoming_text(self):
        should, msg = self.worker._ingest(_event("wxid_a", "incoming", "你好"))
        self.assertTrue(should)
        self.assertEqual(msg["content"], "你好")
        self.assertEqual(msg["type"], "text")

        should, _ = self.worker._ingest(_event("wxid_a", "outgoing", "我发的"))
        self.assertFalse(should)

        should, _ = self.worker._ingest(_event("wxid_a", "incoming", "[图片]", local_type=3))
        self.assertFalse(should)

    def test_incoming_text_enqueues_for_matching_rule(self):
        self._add_rule("wxid_a")
        rules = self.worker._rules_by_username()
        self.worker._handle_event(_event("wxid_a", "incoming", "在吗"), rules)
        pending = self.worker.store.pending()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["conversation"], "wxid_a")
        context = json.loads(pending[0]["context"])
        self.assertEqual(context["incoming"][0]["content"], "在吗")
        self.assertTrue(context["fingerprint"])

    def test_unrelated_username_does_not_enqueue(self):
        self._add_rule("wxid_a")
        rules = self.worker._rules_by_username()
        self.worker._handle_event(_event("wxid_other", "incoming", "不相关"), rules)
        self.assertEqual(self.worker.store.pending(), [])

    def test_presend_superseded_when_newer_incoming_arrived(self):
        self._add_rule("wxid_a")
        rules = self.worker._rules_by_username()
        self.worker._handle_event(_event("wxid_a", "incoming", "第一条", sort_seq=1000), rules)
        job = self.worker.store.pending()[0]
        # 生成期间对方又发来一条（sort_seq 更大）
        self.worker._ingest(_event("wxid_a", "incoming", "第二条", sort_seq=2000))
        self.worker.process(job)
        self.assertEqual(self.worker.store.job(job["id"])["state"], "superseded")

    def test_presend_sends_when_no_newer_incoming(self):
        self._add_rule("wxid_a")
        rules = self.worker._rules_by_username()
        self.worker._handle_event(_event("wxid_a", "incoming", "第一条", sort_seq=1000), rules)
        job = self.worker.store.pending()[0]
        self.worker.process(job)
        self.assertEqual(self.worker.store.job(job["id"])["state"], "sent")
        # 发送定位用 display（rule.title），不是 username
        self.assertEqual(self.mcp.sent[0]["conversation_id"], "好友")

    def test_tick_consumes_events_and_processes_jobs(self):
        self._add_rule("wxid_a")
        self.fake_watcher.events = [_event("wxid_a", "incoming", "你好", sort_seq=5000)]
        self.worker.tick()
        # 事件 → enqueue → process → 发送完成，job 进入 recent 审计
        self.assertEqual(len(self.worker.store.recent()), 1)
        self.assertEqual(self.worker.store.recent()[0]["state"], "sent")


if __name__ == "__main__":
    unittest.main()
