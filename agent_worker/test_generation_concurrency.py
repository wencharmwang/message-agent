"""生成 / 发送分离的并发行为测试。

**改造前的病**：模型调用与 UI 发送挤在同一个串行循环里 —— 一个会话慢，所有会话一起被拖住；
排队超过 job_ttl 还会过期，那正是"某些人一直等不到回复"的来源。

**改造后**：生成可并发（不同会话在不同线程里互不影响），发送仍然串行
（只有一个微信窗口、一个输入框，这是物理约束）。

这里钉住五件事：
1. 不同会话的生成**真的会重叠**（不是排队串行）
2. 一个 job 只会被生成**一次**（靠 transition 的乐观抢占，不是靠锁）
3. 发送**不发生在生成线程里** —— 只由主循环串行取走
4. **一个慢会话不挡住别的会话**
5. 限速是"留在队列里下一轮再试"，**不丢**
"""

from __future__ import annotations

import tempfile
import threading
import time
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


class RecordingHarness:
    """记录"同时有几个生成在跑"，并可按会话设置不同延迟。"""

    def __init__(self, default_delay=0.20, slow=None, slow_delay=2.0):
        self.default_delay = default_delay
        self.slow = slow or {}
        self.slow_delay = slow_delay
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.runs: list[str] = []
        self.ready_at: dict[str, float] = {}

    def run(self, rule, job):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.runs.append(job["id"])
        try:
            conversation = rule["conversation"]
            time.sleep(self.slow_delay if conversation in self.slow else self.default_delay)
            with self.lock:
                self.ready_at[conversation] = time.time()
            return {"action": "reply", "text": "自动回复"}
        finally:
            with self.lock:
                self.active -= 1

    def close(self):
        pass


class RecordingMcp:
    def __init__(self, delay=0.05):
        self.delay = delay
        self.sent: list[dict] = []
        self.max_active = 0
        self._active = 0
        self._lock = threading.Lock()

    def call(self, name, arguments):
        if name == "send_message":
            with self._lock:
                self._active += 1
                self.max_active = max(self.max_active, self._active)
            try:
                time.sleep(self.delay)
                self.sent.append(arguments)
                return {"status": "sent"}
            finally:
                with self._lock:
                    self._active -= 1
        if name == "get_send_status":
            return {"status": "sent"}
        return {}

    def observe(self, rule, limit=30):
        return []


class FakeWatcher:
    def __init__(self):
        self.events = []

    def poll(self):
        events, self.events = self.events, []
        return events


class GenerationConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = {
            "database": str(Path(self.tmp.name) / "reply.db"),
            "runtime_settings_file": str(Path(self.tmp.name) / "settings.json"),
            "worker_token_file": str(Path(self.tmp.name) / "token"),
            "control_token_file": str(Path(self.tmp.name) / "control.token"),
            "poll_interval_seconds": 5,
            "settle_seconds": 0,
            "job_ttl_seconds": 300,
            "min_reply_interval_seconds": 0,
            "generation_workers": 3,
            "watcher_python": "python",
            "watcher_src": "src",
        }
        self.harness = RecordingHarness()
        self.mcp = RecordingMcp()
        self.worker = Worker(self.config, mcp=self.mcp, harness=self.harness,
                             harness_factory=lambda: self.harness)
        self.worker._watcher = lambda: FakeWatcher()

    def tearDown(self):
        self.worker.close()
        self.tmp.cleanup()

    # ---- 帮手 ----

    def _add_rule(self, username, title):
        rule_id = self.worker.store.add("wechat-main", username, title, "direct", "礼貌回复")
        self.worker.store.enable(rule_id, True)
        return rule_id

    def _enqueue(self, username, text="你好", sort_seq=1000):
        rules = self.worker._rules_by_username()
        self.worker._handle_event(_event(username, "incoming", text, sort_seq=sort_seq), rules)

    def _wait_until(self, predicate, timeout=6.0, interval=0.02):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return True
            time.sleep(interval)
        return False

    def _states(self):
        return [job["state"] for job in self.worker.store.sendable()]

    def _odd_jobs(self, worker=None):
        """列出所有**不是 ready** 的 job（诊断用）：状态 + detail 才是线索。"""
        worker = worker or self.worker
        rows = []
        with worker.store.connect() as db:
            for row in db.execute("SELECT state,detail FROM reply_jobs ORDER BY created_at"):
                if row["state"] != "ready":
                    rows.append("%s:%s" % (row["state"], row["detail"]))
        return rows or ["(没有异常 job)"]

    # ---- 1. 并发生成 ----

    def test_generations_overlap_across_conversations(self):
        for index in range(3):
            self._add_rule("wxid_%d" % index, "好友%d" % index)
            self._enqueue("wxid_%d" % index)
        self.assertEqual(len(self.worker.store.pending()), 3)

        self.worker._start_generation_pool()
        try:
            # 完成条件是"都变成 ready"，不是"没有 queued" —— 后者在还有 job 处于 generating
            # 时也成立（第一版就是这么写错的，结果只等到 10/12）。
            done = self._wait_until(lambda: len(self.worker.store.sendable()) == 3)
            stuck = self.worker.store.inflight()
        finally:
            self.worker._stop_generation_pool()

        self.assertTrue(done, "三个会话的生成应该在超时内全部完成；超时时在途=%s runs=%d last_error=%r 异常job=%s"
                        % (stuck, len(self.harness.runs), self.worker.last_error, self._odd_jobs()))

        self.assertGreaterEqual(self.harness.max_active, 2,
                                "不同会话的生成必须真的重叠；串行的话 max_active 只会是 1")
        self.assertEqual(len(self.worker.store.sendable()), 3)

    # ---- 2. 每个 job 只生成一次 ----

    def test_each_job_is_generated_exactly_once(self):
        """并发取下必须精确：8 个线程抢 12 个 job，不能有任何一个被生成两次。"""
        # 改配置而不是新建第二个 Worker：第二个 Worker 的线程会在 tearDown 之后仍然活着
        # （addCleanup 比 tearDown 晚执行），库文件已经被删，于是写库报 readonly 并污染后续用例。
        self.config["generation_workers"] = 8

        for index in range(12):
            username = "wxid_%02d" % index
            self._add_rule(username, "好友%02d" % index)
        rules = self.worker._rules_by_username()
        for index in range(12):
            self.worker._handle_event(_event("wxid_%02d" % index, "incoming", "你好", sort_seq=1000 + index), rules)

        self.worker._start_generation_pool()
        try:
            done = self._wait_until(lambda: len(self.worker.store.sendable()) == 12, timeout=10)
            stuck = self.worker.store.inflight()
        finally:
            self.worker._stop_generation_pool()

        self.assertTrue(done, "12 个 job 应该全部生成完；超时时在途=%s runs=%d last_error=%r 异常job=%s"
                        % (stuck, len(self.harness.runs), self.worker.last_error, self._odd_jobs()))

        self.assertEqual(len(self.harness.runs), 12)
        self.assertEqual(len(set(self.harness.runs)), 12, "同一个 job 不能被生成两次")
        self.assertEqual(len(self.worker.store.sendable()), 12)

    # ---- 3. 发送不在生成线程里 ----

    def test_sending_does_not_happen_in_generation_threads(self):
        self._add_rule("wxid_a", "好友")
        self._enqueue("wxid_a")

        self.worker._start_generation_pool()
        try:
            self.assertTrue(self._wait_until(lambda: self.worker.store.sendable(), timeout=6))
            time.sleep(0.4)   # 再等一会：确认没有哪个生成线程"顺手"把消息发了
        finally:
            self._stop_and_assert()

        self.assertEqual(self.mcp.sent, [], "发送必须只发生在主循环里，不能在生成线程里")
        self.worker.tick()          # 主循环取走 ready 并串行发送
        self.assertEqual(len(self.mcp.sent), 1)
        self.assertEqual(self.worker.store.inflight(), {})

    def _stop_and_assert(self):
        self.worker._stop_generation_pool()

    # ---- 4. 慢会话不挡住别的会话 ----

    def test_one_slow_conversation_does_not_block_others(self):
        """改造前：慢会话会把整个 tick 拖住，其他会话只能排在它后面。
        改造后：各自在自己的线程里跑，快的先完成 —— 这正是"消息一多就不可用"的解药。"""
        self.harness.slow = {"wxid_slow"}
        self.harness.slow_delay = 2.0
        self.harness.default_delay = 0.05

        self._add_rule("wxid_slow", "慢会话")
        self._add_rule("wxid_fast", "快会话")
        self._enqueue("wxid_slow")
        self._enqueue("wxid_fast")

        self.worker._start_generation_pool()
        try:
            # 慢的还在跑的时候，快的应该已经完成
            self.assertTrue(self._wait_until(lambda: "wxid_fast" in self.harness.ready_at, timeout=5))
            self.assertNotIn("wxid_slow", self.harness.ready_at,
                             "慢会话这时不该完成 —— 但快会话已经完成了，说明两者是并行的")
        finally:
            self.worker._stop_generation_pool()

    # ---- 5. 限速不丢任务 ----

    def test_rate_limited_job_stays_queued_and_is_not_dropped(self):
        self._add_rule("wxid_a", "好友")
        self._enqueue("wxid_a", "第一条")
        self.worker.tick()                       # 内联跑一遍：发出第一条，last_sent 被写上
        self.assertEqual(len(self.mcp.sent), 1)

        self.config["min_reply_interval_seconds"] = 600   # 之后 10 分钟内不许再发
        self._enqueue("wxid_a", "第二条", sort_seq=2000)
        job = self.worker.store.pending()[0]
        self.worker.tick()

        self.assertEqual(self.worker.store.job(job["id"])["state"], "queued",
                         "限速时任务必须留在队列里等下一轮，不能被标成失败或过期丢掉")
        self.assertEqual(len(self.mcp.sent), 1, "限速期间不能发出去")

    # ---- 6. FIFO 顺序 ----

    def test_send_order_follows_creation_time(self):
        for index, title in enumerate(("甲", "乙", "丙")):
            self._add_rule("wxid_%d" % index, title)
            self._enqueue("wxid_%d" % index)
            time.sleep(0.02)                     # 让 created_at 单调递增
        self.worker.tick()
        self.assertEqual([call["conversation_id"] for call in self.mcp.sent], ["甲", "乙", "丙"],
                         "发送必须按进入队列的先后顺序，先来先发")

    # ---- 7. 发送仍然串行 ----

    def test_sending_stays_serial(self):
        for index in range(3):
            self._add_rule("wxid_%d" % index, "好友%d" % index)
            self._enqueue("wxid_%d" % index)
        self.worker.tick()
        self.assertEqual(len(self.mcp.sent), 3)
        self.assertEqual(self.mcp.max_active, 1, "发送是物理串行的：同一时刻只能有一个在发")


if __name__ == "__main__":
    unittest.main()
