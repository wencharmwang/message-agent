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
            # 语音相关的方法从数据目录推路径（credentials/voice 都在那儿）
            "control_token_file": str(Path(self.tmp.name) / "control.token"),
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

    def test_sent_rule_does_not_keep_a_stale_status_line(self):
        """发完之后规则上不能留"已提交回复，继续监听"。

        那是一句"正在做什么"的话，挂在界面上会一直显示成当前状态，让人以为卡住了
        （用户实测报的就是这个）。结果该留在最近处理记录里。
        """
        self._add_rule("wxid_a")
        rules = self.worker._rules_by_username()
        self.worker._handle_event(_event("wxid_a", "incoming", "第一条", sort_seq=1000), rules)
        self.worker.process(self.worker.store.pending()[0])
        rule = self.worker.store.rule(self.worker.store.rules()[0]["id"])
        self.assertEqual(rule["status"], "listening")
        self.assertEqual(rule["detail"], "")

    def test_voice_message_tells_the_user_instead_of_staying_silent(self):
        """语音不会触发回复（读不到内容），但必须在规则上留一句说明。

        用户实测：对方连发三条语音，助手毫无反应、也没有任何提示，只能以为它坏了。
        """
        rule_id = self._add_rule("wxid_a")
        rules = self.worker._rules_by_username()
        self.worker._handle_event(
            _event("wxid_a", "incoming", "", local_type=34, sort_seq=2000), rules)
        self.assertEqual(self.worker.store.pending(), [], "语音不该产生回复任务")
        rule = self.worker.store.rule(rule_id)
        self.assertEqual(rule["status"], "listening")
        self.assertIn("语音", rule["detail"])
        self.assertIn("需要你自己听", rule["detail"])

    def test_non_text_from_a_conversation_without_a_rule_is_harmless(self):
        rules = self.worker._rules_by_username()
        self.worker._handle_event(_event("wxid_none", "incoming", "", local_type=3), rules)
        self.assertEqual(self.worker.store.pending(), [])

    def test_our_own_outgoing_message_does_not_trigger_a_note(self):
        rule_id = self._add_rule("wxid_a")
        rules = self.worker._rules_by_username()
        self.worker._handle_event(_event("wxid_a", "outgoing", "", local_type=34), rules)
        self.assertEqual(self.worker.store.rule(rule_id)["detail"], "")

    def test_tick_consumes_events_and_processes_jobs(self):
        self._add_rule("wxid_a")
        self.fake_watcher.events = [_event("wxid_a", "incoming", "你好", sort_seq=5000)]
        self.worker.tick()
        # 事件 → enqueue → process → 发送完成，job 进入 recent 审计
        self.assertEqual(len(self.worker.store.recent()), 1)
        self.assertEqual(self.worker.store.recent()[0]["state"], "sent")


if __name__ == "__main__":
    unittest.main()


class VoiceWiringTests(WorkerDbWatchTests):
    """语音转文字的接线测试。

    这里盯的是两个**真实踩过的坑**：

    1. `service.py` 忘了 `from . import voice` —— 调用时抛 NameError，被宽 except 吞掉，
       表现是"开关开着、语音永远读不到、而且一点线索都没有"。所以第一件事就是确认这个导入在。
    2. 失败必须留痕（`last_voice_error`），否则用户看到开关开着却没反应，只能靠猜。
    """

    def test_service_imports_the_voice_module(self):
        from agent_worker import service
        self.assertTrue(hasattr(service, 'voice'), 'service.py 少了 `from . import voice`')

    def test_worker_reports_why_a_transcript_failed(self):
        from agent_worker import voice as voice_module
        # 开关打开，但把"读偏好"弄坏：必须留下原因，而不是静默返回空
        original = voice_module.load_prefs
        voice_module.load_prefs = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('读偏好失败'))
        try:
            self.assertEqual(self.worker.voice_text(1), '')
            self.assertIn('读偏好失败', self.worker.last_voice_error)
        finally:
            voice_module.load_prefs = original

    def test_voice_switch_off_means_no_work_at_all(self):
        from agent_worker import voice as voice_module
        called = []
        original = voice_module.voice_python
        voice_module.voice_python = lambda *a, **k: (called.append(1), None)[1]
        try:
            self.assertEqual(self.worker.voice_text(1), '')
            self.assertEqual(called, [], '开关关着的时候不该去找识别环境，更不该启动它')
        finally:
            voice_module.voice_python = original


    def test_reading_messages_never_waits_for_transcription(self):
        """读消息**绝不能**在请求里转写。

        用户实测："进消息页要等好久才显示"—— 因为一次读十几条语音，每条 1-2 秒，
        页面就卡在那儿。转写必须在后台排队，读的时候只看缓存。
        """
        import inspect
        from agent_worker import service
        row = inspect.getsource(service.Worker._message_row)
        self.assertIn('cached_only', row, '读消息要走"只看缓存"')
        self.assertNotIn('voice_text(', row, '读消息里不许出现会触发转写的调用')
        self.assertIn('_queue_voice', row, '没转过的要排进后台队列')
        self.assertIn('pending_voice', row, '要告诉界面"这条在转"')

    def test_background_queue_dedupes_and_has_a_ceiling(self):
        from agent_worker import voice as voice_module
        original = voice_module.voice_python
        # 没装识别环境：排队逻辑照样要能跑（不能报错，也不能无限堆）
        voice_module.voice_python = lambda *a, **k: None
        try:
            for _ in range(3):
                self.worker._queue_voice(42)
            self.assertEqual(self.worker._voice_queue.qsize(), 1, '同一条不该排多次')
            self.worker._voice_failed.add(99)
            self.worker._queue_voice(99)
            self.assertEqual(self.worker._voice_queue.qsize(), 1, '失败过的不再排')
        finally:
            voice_module.voice_python = original


class MessageTimeTests(unittest.TestCase):
    """消息必须带时间。

    用户实测：周一说了"准备回家"，周三还在按"他还在路上"回复（"路上注意安全"）。
    根因就是这里 —— canonical_messages 把 at 丢了，模型看到的一串话没有先后，
    提示词里"不要把历史状态当作现在的状态"那条规矩因此执行不了。
    """

    def test_keeps_timestamp(self):
        from .service import canonical_messages

        out = canonical_messages([
            {'direction': 'incoming', 'content': '准备回家了', 'sender': None, 'type': 'text', 'at': 1789973708}
        ])
        self.assertEqual(out[0]['at'], 1789973708)

    def test_falls_back_to_sort_seq_then_zero(self):
        from .service import canonical_messages

        # 老数据只有 sort_seq（毫秒级时间戳）时用它兜底
        out = canonical_messages([
            {'direction': 'incoming', 'content': '在吗', 'sender': None, 'type': 'text', 'sort_seq': 123}
        ])
        self.assertEqual(out[0]['at'], 123)
        # 什么都没有就是 0 —— **不要编一个时间**，宁可让模型知道"这条没有时间"
        out = canonical_messages([
            {'direction': 'incoming', 'content': '在吗', 'sender': None, 'type': 'text'}
        ])
        self.assertEqual(out[0]['at'], 0)
