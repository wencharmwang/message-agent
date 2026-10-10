"""只读「已解锁的微信数据库」。

这个包**只做一件事**：打开一个符合 `docs/unlocked-db-protocol.md` 的产物目录，
把里面的明文库读成结构化数据。

设计边界（重要，别在这里加东西）：

* **不取密钥、不解密、不合并 WAL、不读进程内存** —— 解锁是别人的事，产物是输入；
* 所有连接 **只读**（`mode=ro` / `query_only`），不改动产物；
* 不依赖任何解密相关的模块（`keyextract` / `winmem` / `sqlcipher4` / `vault`）。
  这条可以用一行命令自检（只看真正的 import，注释里提到这些词不算）：

      grep -rnE "^[[:space:]]*(from|import)[[:space:]].*(keyextract|winmem|sqlcipher|vault)" \\
        agent_worker/wechat_reader/

  输出为空才算合格。
"""

from __future__ import annotations

from .messages import decode_content, preview, strip_sender_prefix, type_name
from .readers import KnowledgeBase

__all__ = ["KnowledgeBase", "decode_content", "preview", "strip_sender_prefix", "type_name"]
