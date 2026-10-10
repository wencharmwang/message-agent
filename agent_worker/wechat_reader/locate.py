"""库的分类辅助（从 wechat-db-lab 的 locate 里取出的最小子集）。

这里**只有**纯路径分类，没有任何解锁/解密相关的东西 —— 这个包存在的意义就是
"只读明文库"，所以它不能、也不需要知道密钥与页解密。

（原 locate.py 里还有账号发现 `Account`、枚举待解锁库 `db_files`、以及依赖
`keyextract.DbFile` 的部分 —— 那些属于解锁侧，留在私有库里。）
"""

from __future__ import annotations

KIND_CONTACT = "contact"
KIND_SESSION = "session"
KIND_MESSAGE = "message"
KIND_SNS = "sns"
KIND_OTHER = "other"

_KIND_BY_DIR = {
    "contact": KIND_CONTACT,
    "session": KIND_SESSION,
    "message": KIND_MESSAGE,
    "sns": KIND_SNS,
}


def classify(rel: str) -> str:
    """按相对路径的首层目录给出库的类别（`contact` / `session` / `message` / `sns` / `other`）。"""
    head = rel.replace("\\", "/").split("/")[0].lower()
    return _KIND_BY_DIR.get(head, KIND_OTHER)
