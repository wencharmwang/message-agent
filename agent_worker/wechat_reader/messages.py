"""微信 4.x 消息正文解码。

``Msg_<md5>`` 表里的 ``message_content`` 是个"容器" blob，形态不止一种：

* 纯 UTF-8 文本（多数短文本）；
* 带容器头的明文（``\\x28\\xb5\\x2f\\xfd …`` 前缀 + 明文 + ``\\x01\\x00`` 尾部填充）；
* zstd 压缩帧（长文本），有 ``zstandard`` 时才能还原；
* 二进制/XML 卡片（图片、文件、引用、红包等），只给类型占位。

本模块只做"尽力还原可读文本"，还原不了就老实返回占位符，不猜。
"""

from __future__ import annotations

import re
import unicodedata
from typing import Optional

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

MSG_TYPE_NAMES = {
    1: "文本",
    3: "图片",
    34: "语音",
    43: "视频",
    47: "动画表情",
    48: "位置",
    49: "文件/链接/卡片",
    50: "音视频通话",
    10000: "系统消息",
    11000: "动画表情",
    8594229559345: "红包",
}

_CONTROL_RE = re.compile(r"[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]+")

# 真 XML 元素的起点（`<?xml` / `<msg>` / `<url>` 都算；`<3 爱你` 这种聊天里的表情不算）。
_MARKUP_RE = re.compile(r"^<[?!/]?[A-Za-z_][\w.:-]*[\s/>]")

# 群消息的正形是「发送者:」+ 换行 + XML，markup 不在行首。前缀是一段不含换行和冒号的短 token。
_PREFIXED_MARKUP_RE = re.compile(r"^[^\n<:]{1,90}:[ \t\n]*<[?!/]?[A-Za-z_][\w.:-]*[\s/>]")

_ZSTD_MODULE: object | None = None
_ZSTD_LOADED = False


def type_name(local_type: object) -> str:
    """``local_type`` -> 中文类型名。

    49 是"app 消息"，真正的子类型编码在**高 32 位**：``local_type = (子类型 << 32) | 49``。
    实测群里 21474836529 / 201863462961 / 244813135921 / 270582939697 解压后的 XML 里
    ``<type>`` 正好是 5 / 47 / 57 / 63。只看整数值的话这些全会掉进"类型N"。
    """
    try:
        value = int(local_type)
    except (TypeError, ValueError):
        return f"类型{local_type}"
    label = MSG_TYPE_NAMES.get(value)
    if label:
        return label
    base = value & 0xFFFFFFFF
    if base != value:
        label = MSG_TYPE_NAMES.get(base)
        if label:
            return label
    return f"类型{local_type}"


def strip_sender_prefix(text: str, username: str) -> str:
    """切掉群消息正文前面的「发送者: 」前缀。

    微信在群消息的 ``message_content`` 里把发送者名字也写在正文开头
    （``wxid_xxx:\\n不是``）。发送者已经由 ``sender`` / ``display`` 单独给了，
    留在正文里只会让同一句话既当发送者又出现在内容里 —— 界面上就成了
    ``wxid_xxx:不是``。

    只在**前缀正好等于发送者自己的 username** 时才切，所以"注意：…"这类正常正文
    不会被吃掉。不匹配时原样返回。
    """
    if not text or not username or not text.startswith(username):
        return text
    rest = text[len(username):]
    if not rest.startswith(":"):
        return text
    body = rest[1:]
    if body.startswith("\n"):
        return body[1:]
    return body.lstrip(" \t")


def _zstd():
    global _ZSTD_MODULE, _ZSTD_LOADED
    if not _ZSTD_LOADED:
        for name in ("zstandard", "zstd"):
            try:
                _ZSTD_MODULE = __import__(name)
                break
            except ImportError:
                continue
        _ZSTD_LOADED = True
    return _ZSTD_MODULE


def _looks_like_text(text: str) -> bool:
    """可打印字符占比 + 控制/未分配类字符占比双门槛判定，防止把二进制噪声当文本。

    不要求含中文——纯英文、纯数字、URL、Emoji 消息同样需要还原。``Cf``（格式类，
    如 ZWJ）不计入噪声，否则 ``👨\\u200d👩\\u200d👧`` 这类组合序列会被误杀。
    """
    if not text:
        return False
    printable = 0
    bad = 0
    for char in text:
        if char in "\n\r\t":
            printable += 1
            continue
        if unicodedata.category(char) in ("Cc", "Co", "Cs", "Cn"):
            bad += 1
        else:
            printable += 1
    if printable / len(text) < 0.7:
        return False
    return bad / len(text) <= 0.1


def text_from_container(content: bytes) -> Optional[str]:
    """从容器头里剥离明文。多数消息明文从第 10 字节开始。"""
    def attempt(offset: int) -> Optional[str]:
        if offset >= len(content):
            return None
        chunk = content[offset:]
        if b"\x01\x00" in chunk:
            chunk = chunk.split(b"\x01\x00")[0]
        try:
            candidate = chunk.decode("utf-8")
        except UnicodeDecodeError:
            return None
        candidate = _CONTROL_RE.sub("", candidate).strip()
        if not candidate or not _looks_like_text(candidate):
            return None
        return candidate

    found = attempt(10)
    if found:
        return found
    for offset in range(min(16, len(content))):
        if offset == 10:
            continue
        found = attempt(offset)
        if found:
            return found
    return None


def _zstd_decompress(content: bytes) -> Optional[str]:
    module = _zstd()
    if module is None:
        return None
    try:
        decompressed = module.ZstdDecompressor().decompress(content, max_output_size=200_000)
    except Exception:  # noqa: BLE001 - zstd 抛的异常类型不稳定
        return None
    if not decompressed:
        return None
    text = decompressed.decode("utf-8", "ignore").strip()
    if not text:
        return None
    text = _CONTROL_RE.sub("", text)
    return text if _looks_like_text(text) else None


def looks_like_markup(text: str) -> bool:
    """正文是不是一段 XML/blob 卡片，而不是人话。

    图片/视频/位置这些消息的 ``message_content`` 是一整段**可打印 XML**
    （``<?xml version="1.0"?><msg><img hdlength="…"/></msg>``）。它 UTF-8 解码必然成功、
    ``_looks_like_text`` 也必然通过，于是"解出来非空就当正文"的旧逻辑把整段卡片返回了
    出去 —— 界面显示一堆 XML，模型只能从 ``hdlength`` 反推"这是张照片"。
    占位符对两边都更有用，所以这里认一下卡片形态。
    """
    head = text.lstrip()[:400]
    # 也要认「发送者:\n<XML>」这种带前缀的形态 —— 群里每条消息都长这样，只看行首会全漏。
    return bool(_MARKUP_RE.match(head) or _PREFIXED_MARKUP_RE.match(head))


def _is_non_text(local_type: object) -> bool:
    """1 是文本；其余（含认不出的类型）都算非文本。"""
    try:
        return int(local_type) != 1
    except (TypeError, ValueError):
        return True


def decode_content(content: object, local_type: object) -> str:
    """把 ``message_content`` 解成可展示字符串。

    解不出来、或者解出来是 XML 卡片（非文本消息）时，返回 ``[类型]`` 占位 —— 绝不把
    原始 XML 当正文交给界面或模型。
    """
    text = _decode_body(content, local_type)
    if _is_non_text(local_type) and looks_like_markup(text):
        return f"[{type_name(local_type)}]"
    return text


def _decode_body(content: object, local_type: object) -> str:
    """真实解码：纯 UTF-8 / zstd / 容器头；全都失败时返回 ``[类型]`` 占位。"""
    label = type_name(local_type)
    if content is None:
        return f"[{label}]"
    if isinstance(content, str):
        return content or f"[{label}]"
    if not isinstance(content, (bytes, bytearray, memoryview)):
        return str(content)
    raw = bytes(content)
    if not raw:
        return f"[{label}]"

    try:
        plain = raw.decode("utf-8")
        if _looks_like_text(plain):
            return plain
    except UnicodeDecodeError:
        pass

    if raw[:4] == ZSTD_MAGIC:
        text = _zstd_decompress(raw)
        if text:
            return text

    text = text_from_container(raw)
    if text:
        return text

    return f"[{label}]"


def preview(text: str, limit: int = 60) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"
