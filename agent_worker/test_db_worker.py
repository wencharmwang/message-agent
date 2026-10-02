"""DB 方案下 Worker 事件处理的单元测试。

不依赖真实微信 / runtime / deepseek：mock Mcp 与 Harness，注入 fake watcher，
验证事件 → 历史 → enqueue → pre-send 复查的闭环。
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from agent_worker.service import (Worker, display_body, looks_like_markup, looks_like_noise,
                                 message_type_label, split_sender_prefix)


IMAGE_XML = '<?xml version="1.0"?><msg><img hdlength="274437" length="0" md5=""/></msg>'
VIDEO_XML = '<?xml version="1.0"?><msg><videomsg length="666709927" playlength="1667"/></msg>'


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
    def test_canonical_preserves_event_time_not_sort_sequence(self):
        event = _event('person', 'incoming', '今天我生日', sort_seq=1790462800123)
        event['create_time'] = 1790462800
        self.assertEqual(Worker._canonical(event)['at'], 1790462800)
        event.pop('create_time')
        self.assertEqual(Worker._canonical(event)['at'], 0)

    def test_canonical_media_event_becomes_placeholder_not_xml(self):
        """线上事故：图片/视频事件的 text 是一整段可打印 XML，旧逻辑原样当正文送出去，
        界面显示一堆 XML、模型只能从 hdlength 反推"这是照片"。必须是 [类型]。"""
        image = _event('person', 'outgoing', IMAGE_XML, local_type=3)
        image['type'] = '图片'
        got = Worker._canonical(image)
        self.assertEqual(got['content'], '[图片]')
        self.assertEqual(got['type'], '图片')

        video = _event('person', 'outgoing', VIDEO_XML, local_type=43)
        video['type'] = '视频'
        self.assertEqual(Worker._canonical(video)['content'], '[视频]')

        # 类型名认不出时给中性的「其他消息」，别漏出 XML，也别把类型号丢给用户
        odd = _event('person', 'outgoing', IMAGE_XML, local_type=4242)
        odd['type'] = 'unknown'
        self.assertEqual(Worker._canonical(odd)['content'], '[其他消息]')

    def test_canonical_text_event_keeps_markup_like_body(self):
        """local_type 1 的正文一个字节都不许动 —— 包括真的以 < 开头的那种。"""
        for body in ('<?xml version="1.0"?> 是我手打的', '<msg>手打的</msg>', '<3 爱你'):
            self.assertEqual(Worker._canonical(_event('person', 'incoming', body))['content'], body)

    def test_display_body_and_markup_detection(self):
        self.assertTrue(looks_like_markup(IMAGE_XML))
        self.assertTrue(looks_like_markup('  \n' + VIDEO_XML))
        self.assertFalse(looks_like_markup('[图片]'))
        self.assertFalse(looks_like_markup(''))
        self.assertFalse(looks_like_markup(None))
        # 聊天里的 "<3" 不是 XML 起点
        self.assertFalse(looks_like_markup('<3 爱你'))
        self.assertFalse(looks_like_markup('3<5 怎么办'))
        # 群消息的正形是「发送者:\n<XML>」—— markup 不在行首，只看行首会全漏
        self.assertTrue(looks_like_markup('wxid_peer:\n' + IMAGE_XML))
        self.assertTrue(looks_like_markup('12345678901234@openim:\n<msg><appmsg/></msg>'))
        self.assertFalse(looks_like_markup('注意:\n明天要开会'))
        self.assertEqual(display_body('wxid_peer:\n' + IMAGE_XML, '图片'), '[图片]')

        self.assertEqual(display_body(IMAGE_XML, '图片'), '[图片]')
        self.assertEqual(display_body('[图片]', '图片'), '[图片]')
        self.assertEqual(display_body('在吗', 'text'), '在吗')
        self.assertEqual(display_body('在吗', '文本'), '在吗')
        self.assertEqual(display_body(IMAGE_XML, None), IMAGE_XML)  # 不知道类型就不动

    def test_display_body_treats_binary_residue_as_media_too(self):
        """``b"\\x00\\x01\\x02\\x03"`` 恰好是合法 UTF-8 —— "解码成功"不代表可读。"""
        residue = (b"\x00\x01\x02\x03" * 40).decode("utf-8")
        self.assertTrue(looks_like_noise(residue))
        self.assertFalse(looks_like_markup(residue))
        self.assertEqual(display_body(residue, '图片'), '[图片]')
        # 正常中文/英文/emoji 不是噪声
        for body in ('在吗', 'ok', '👨‍👩‍👧', '[图片]', '3<5 怎么办'):
            self.assertFalse(looks_like_noise(body), body)

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

    def _row(self, local_type, content, local_id=7, sender=2, at=1790762400):
        return (local_id, local_type, at, sender, at, content)

    def test_message_row_media_is_placeholder_not_xml(self):
        """DB 路径（首页/整理/会话详情/说话方式分析都走它）同样不能把 XML 当正文。"""
        got = self.worker._message_row(self._row(3, IMAGE_XML), {2: "wxid_me"}, {"wxid_me"})
        self.assertEqual(got["content"], "[图片]")
        self.assertEqual(got["type"], "3")
        self.assertEqual(got["direction"], "outgoing")

        got = self.worker._message_row(self._row(43, VIDEO_XML, sender=9), {9: "wxid_peer"}, {"wxid_me"})
        self.assertEqual(got["content"], "[视频]")
        self.assertEqual(got["direction"], "incoming")

        # 解不出来的二进制也照样给占位符（旧行为，别改坏）
        got = self.worker._message_row(self._row(3, b"\x00\x01\x02\x03" * 40), {2: "wxid_me"}, {"wxid_me"})
        self.assertEqual(got["content"], "[图片]")

    def test_message_row_unknown_media_type_still_gets_a_label(self):
        got = self.worker._message_row(self._row(4242, IMAGE_XML), {2: "wxid_me"}, {"wxid_me"})
        # 中性标签，**不带类型号** —— 界面上不该出现 类型4242
        self.assertEqual(got["content"], "[其他消息]")
        self.assertEqual(got["type"], "4242")

    def test_message_type_label(self):
        self.assertIsNone(message_type_label(1))                      # 文本没有标签
        self.assertEqual(message_type_label(3), "图片")
        self.assertEqual(message_type_label("34"), "语音")
        self.assertEqual(message_type_label(47), "表情")
        # app 消息：子类型在高 32 位，认低 32 位（49）
        self.assertEqual(message_type_label(21474836529), "链接或文件")
        self.assertEqual(message_type_label(244813135921), "链接或文件")
        # 认不出就给中性的，绝不吐类型号
        self.assertEqual(message_type_label(4242), "其他消息")
        self.assertIsNone(message_type_label(None))
        self.assertIsNone(message_type_label("不是数字"))

    def test_message_row_app_message_subtype_is_labelled_not_numbered(self):
        """local_type = (子类型 << 32) | 49 —— 实测群里那四个值都该给「链接或文件」，
        而不是界面上那串 ``类型244813135921``。"""
        for value in (21474836529, 201863462961, 244813135921, 270582939697):
            got = self.worker._message_row(self._row(value, IMAGE_XML), {2: "wxid_peer"}, {"wxid_me"}, {})
            self.assertEqual(got["content"], "[链接或文件]", value)
            self.assertEqual(got["type"], str(value))

    def test_message_row_uses_the_display_name_not_the_wxid(self):
        """群消息的 real_sender_id 只解得出 wxid；界面上不能是一串 wxid。"""
        got = self.worker._message_row(
            self._row(1, "wxid_peer0001:\n不是".encode("utf-8"), sender=27),
            {27: "wxid_peer0001"}, {"wxid_me"},
            {"wxid_peer0001": "同事甲"})
        self.assertEqual(got["content"], "不是", "正文里的发送者前缀要切掉")
        self.assertEqual(got["sender"], "同事甲")
        self.assertEqual(got["direction"], "incoming")

        # 卡片类消息的前缀是「名字: 」+ 空格 + XML
        card = self.worker._message_row(
            self._row(244813135921, "member_two: <?xml version=\"1.0\"?><msg/>".encode("utf-8"), sender=26),
            {26: "member_two"}, {"wxid_me"}, {"member_two": "同事乙"})
        self.assertEqual(card["content"], "[链接或文件]")
        self.assertEqual(card["sender"], "同事乙")

    def test_message_row_falls_back_to_username_when_no_display_name(self):
        got = self.worker._message_row(self._row(1, "在吗".encode("utf-8"), sender=9),
                                       {9: "wxid_unknown"}, set(), {})
        self.assertEqual(got["sender"], "wxid_unknown")

    def test_message_row_keeps_text_that_merely_starts_with_a_word_and_colon(self):
        """前缀只在等于发送者本人 username 时才切，"注意:\\n…"这种正常正文不许动。"""
        body = "注意:\n明天要开会"
        got = self.worker._message_row(self._row(1, body.encode("utf-8"), sender=9),
                                       {9: "wxid_a"}, {"wxid_me"}, {})
        self.assertEqual(got["content"], body)

    def test_split_sender_prefix(self):
        self.assertEqual(split_sender_prefix("wxid_a:\n不是", "wxid_a"), "不是")
        self.assertEqual(split_sender_prefix('wxid_a: <msg/>', "wxid_a"), "<msg/>")
        self.assertEqual(split_sender_prefix("注意:\n明天要开会", "wxid_a"), "注意:\n明天要开会")
        self.assertEqual(split_sender_prefix("在吗", "wxid_a"), "在吗")
        self.assertEqual(split_sender_prefix("", "wxid_a"), "")
        self.assertEqual(split_sender_prefix("wxid_a:\n不是", ""), "wxid_a:\n不是")

    def test_message_row_text_is_untouched_even_when_it_looks_like_markup(self):
        body = '<?xml version="1.0"?> 是我手打的'
        got = self.worker._message_row(self._row(1, body.encode("utf-8")), {2: "wxid_me"}, {"wxid_me"})
        self.assertEqual(got["content"], body)
        self.assertEqual(got["type"], "text")
        # 空的文本消息保持空串（不要变成 [类型1]）
        got = self.worker._message_row(self._row(1, b""), {2: "wxid_me"}, {"wxid_me"})
        self.assertEqual(got["content"], "")

    def test_message_row_voice_transcript_survives_the_placeholder_rule(self):
        """语音转成文字后 type 变 text —— 这时候必须留住文字，不能被占位符盖掉。"""
        with mock.patch("agent_worker.service.voice.cached_only", return_value="晚上一起吃饭吗"):
            got = self.worker._message_row(self._row(34, b"\xff\xfe" * 20), {2: "wxid_me"}, {"wxid_me"})
        self.assertEqual(got["content"], "晚上一起吃饭吗")
        self.assertEqual(got["type"], "text")

    def test_message_row_voice_without_transcript_falls_back_to_placeholder(self):
        # 能不能转由 _voice_ready 决定（有单独用例钉住）；这里只验占位符与排队标记。
        self.worker._voice_ready = lambda: True
        self.worker._queue_voice = lambda local_id: None
        with mock.patch("agent_worker.service.voice.cached_only", return_value=None):
            got = self.worker._message_row(self._row(34, IMAGE_XML), {2: "wxid_me"}, {"wxid_me"})
        self.assertEqual(got["content"], "[语音]")
        self.assertEqual(got["type"], "34")
        self.assertTrue(got["pending_voice"])

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

    def _voice_row(self, local_id):
        """一条语音消息行（local_type 34）。用 900+ 的号避开真实缓存。"""
        return self._row(34, b"\xff\xfe" * 20, local_id=local_id)

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


    def test_pending_flag_is_honest_when_transcription_cannot_happen(self):
        """识别没装、开关没开 —— 界面就不该再说"正在转写"。

        真实反馈："一直显示正在转文字，是不是服务没有启动？" 其实转写环境早就坏了，
        而卡片上那句"正在这台电脑上转成文字…"是**永远**不会兑现的。
        """
        queued = []
        self.worker._queue_voice = queued.append
        self.worker._voice_ready = lambda: False
        got = self.worker._message_row(self._voice_row(900), {2: "wxid_me"}, {"wxid_me"}, {})
        self.assertFalse(got["pending_voice"])
        self.assertEqual(got["content"], "[语音]")
        self.assertEqual(queued, [], "不可能转的时候不该排队")

    def test_pending_flag_clears_after_a_failed_attempt(self):
        queued = []
        self.worker._queue_voice = queued.append
        self.worker._voice_ready = lambda: True
        self.worker._voice_failed.add(901)
        got = self.worker._message_row(self._voice_row(901), {2: "wxid_me"}, {"wxid_me"}, {})
        self.assertFalse(got["pending_voice"], "失败过的别一直挂着'正在转写'")
        self.assertEqual(queued, [])

    def test_pending_flag_is_true_and_queued_when_it_can_really_run(self):
        queued = []
        self.worker._queue_voice = queued.append
        self.worker._voice_ready = lambda: True
        got = self.worker._message_row(self._voice_row(902), {2: "wxid_me"}, {"wxid_me"}, {})
        self.assertTrue(got["pending_voice"])
        self.assertEqual(queued, [902])

    def test_model_cache_is_recognised(self):
        """模型已在本地就离线跑 —— 否则 huggingface_hub 会先联网解析仓库（代理下 502），
        "模型早下好了"却每条语音都转不出来。"""
        from agent_worker import voice as voice_module
        with tempfile.TemporaryDirectory() as tmp:
            snap = (Path(tmp) / "hub" / "models--Systran--faster-whisper-small"
                    / "snapshots" / "rev1")
            snap.mkdir(parents=True)
            (snap / "model.bin").write_bytes(b"x")
            original = os.environ.get("HF_HOME")
            os.environ["HF_HOME"] = tmp
            try:
                self.assertTrue(voice_module.model_cached("small"))
                self.assertFalse(voice_module.model_cached("large-v3"))
            finally:
                if original is None:
                    os.environ.pop("HF_HOME", None)
                else:
                    os.environ["HF_HOME"] = original

    def test_available_rejects_a_venv_missing_pyvenv_cfg(self):
        """``Scripts/python.exe`` 还在、但 ``pyvenv.cfg`` 被删掉的 venv **不能用**。

        设置页原来只看文件在不在，坏了也显示"已装"（2026-10-02 实测），
        得和 worker 的 ``voice._runtime_usable`` 对齐。
        """
        from agent_worker import voice as voice_module
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            venv = data / "voice" / "venv"
            (venv / "Scripts").mkdir(parents=True)
            (venv / "Scripts" / "python.exe").write_bytes(b"")
            (venv / "Lib" / "site-packages" / "faster_whisper").mkdir(parents=True)
            self.assertIsNotNone(voice_module.voice_python(data))
            self.assertFalse(voice_module.available(data, tmp)["transcriber"],
                             "少了 pyvenv.cfg 的解释器起不来，不能算装好了")
            (venv / "pyvenv.cfg").write_text("home = x", encoding="utf-8")
            self.assertTrue(voice_module.available(data, tmp)["transcriber"])

    def test_new_wechat_silk_header_is_accepted(self):
        """微信 4.x 新录的语音头字节是 ``\\x03``，老的是 ``\\x02``，后面 9 字节一样。

        原样把 ``\\x03`` 喂给解码器会**静默产出 0 字节 PCM**（退出码还是 0），所以必须
        自己先把首字节改回 ``\\x02``。修之前这些语音永远转不出文字，而且没有任何报错。
        """
        from agent_worker import voice as voice_module
        body = b'#!SILK_V3' + b'\x00' * 40
        self.assertEqual(voice_module.normalize_silk(b'\x02' + body), b'\x02' + body)
        self.assertEqual(voice_module.normalize_silk(b'\x03' + body), b'\x02' + body)
        for bad in (b'RIFF' + body, b'', b'\x02'):
            with self.assertRaises(voice_module.VoiceError):
                voice_module.normalize_silk(bad)

    def test_cached_transcript_does_not_swallow_the_reason(self):
        """转写失败必须把原因抛出去 —— 调用方要写进 last_voice_error。

        原来这里是 `except Exception: return ''`，于是"不是 SILK 格式"这类真原因被吃掉，
        用户只看到语音永远不出文字，只能猜"是不是服务没启动"。
        """
        from agent_worker import voice as voice_module
        with tempfile.TemporaryDirectory() as tmp:
            def boom():
                raise voice_module.VoiceError('解码器不给力')
            with self.assertRaises(voice_module.VoiceError):
                voice_module.cached_transcript(tmp, 12345, boom)
            # 缓存命中的时候照旧直接返回，不跑 producer
            cache = Path(tmp) / 'voice' / 'cache'
            cache.mkdir(parents=True)
            (cache / '12345.txt').write_text('已经转过', encoding='utf-8')
            self.assertEqual(
                voice_module.cached_transcript(tmp, 12345, lambda: self.fail('不该重跑')),
                '已经转过')

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
