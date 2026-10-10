# 解锁产物协议（unlocked database protocol）

**版本：manifest v1**

本项目（message-agent）**只消费"已解锁的数据库目录"，不参与解锁** ——
它不读进程内存、不取密钥、不做页解密、不合并 WAL。

解锁可以由任何一方完成，只要产出符合本协议：

| 谁来做 | 说明 |
| --- | --- |
| 私有工具 `wechat-db-lab`（作者自有） | 跑 `unlock` 即得到符合本协议的产物 |
| 第三方开源项目 + Agent | 例如公开项目 `wxauto-replica` 等；按下述协议产出即可 |

> 本协议**只描述"产物长什么样"**，不描述怎么解锁。解锁涉及规避技术措施，请自行判断
> 合法性并使用你有权的数据。

---

## 一、目录结构

```
<unlocked_root>/
├── manifest.json          # 必需：解锁元信息（见下）
└── plain/                 # 必需：明文库，按 db_storage 的相对路径摆放
    ├── contact/contact.db
    ├── session/session.db
    ├── message/message_0.db
    ├── message/message_resource.db
    └── ...                # 其余库照相对路径
```

- `<unlocked_root>` 由使用方配置，路径任意。
- `plain/` 下的层级与微信 `db_storage/` **完全一致**（相对路径不变）。
- 文件必须是**标准明文 SQLite**（文件头 `SQLite format 3\0`）。消费方会校验这个魔数。

## 二、`manifest.json`（v1）

```json
{
  "manifest_version": 1,
  "account": "wxid_xxxxxxxxxxxx_xxxx",
  "created_at": "2026-10-10T03:36:18Z",
  "databases": [
    {
      "rel": "contact/contact.db",
      "output": "<绝对路径>/plain/contact/contact.db",
      "status": "decrypted",
      "pages": 71,
      "wal_frames": 102,
      "bytes": 290816,
      "source": {
        "size": 290816,
        "mtime_ns": 1791594651960628500,
        "wal": { "size": 420272, "mtime_ns": 1791594651962652100 }
      }
    }
  ]
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `manifest_version` | ✓ | 必须是 `1`。消费方遇到未知版本会拒绝启动 |
| `account` | ✓ | 账号标识（微信的账号目录名，如 `wxid_xxx_xxxx`）。用于日志与展示 |
| `created_at` | ✓ | 本次解锁完成时间（ISO 8601，UTC）。**新鲜度判定的主依据** |
| `databases` | ✓ | 库清单，至少包含下方"必需库集合" |
| `databases[].rel` | ✓ | 相对 `db_storage` 的路径，如 `message/message_0.db` |
| `databases[].output` | ✓ | 明文库的**绝对路径**。消费方直接用它打开 |
| `databases[].status` | ✓ | `decrypted` / `reused` 等，仅用于展示与排障 |
| `databases[].source` | ✓ | 源库与源 WAL 的 `size` / `mtime_ns`。用于判断产物是否落后于微信 |
| `databases[].key_fingerprint` | ○ | 密钥指纹（**只能是哈希前几位，绝不放密钥**）。用于排障"是不是换了密钥" |
| `keys` / `kdf_iterations` / `data_root` 等 | ○ | 产出方自己的统计信息，消费方只透传展示、不依赖 |

### 必需库集合

消费方**至少**需要这些库才能正常工作：

| 库 | 用途 |
| --- | --- |
| `contact/contact.db` | 联系人、备注、群成员 |
| `session/session.db` | 会话列表、未读 |
| `message/message_*.db` | 消息分片（正文、发送者、时间） |
| `message/message_resource.db` | 消息资源（语音等） |
| `message/media_*.db` | 媒体（语音二进制等） |

其余库（`favorite/`、`sns/`、`general/`、`hardlink/`、`emoticon/` …）**可选**，
但建议一并解锁以保持与私有工具产出的功能一致。

## 三、硬性要求（不满足会出难查的错）

1. **必须合并 WAL。**
   主库停在上一次 checkpoint，最新消息在 `-wal` 里。只解密主库不合并 WAL →
   **会缺最近几条消息**，且症状是"少了几条"、极难定位。产物必须是"合完 WAL 的完整库"。
2. **一次解锁 = 一批一致的快照。**
   同一份 manifest 下的所有库应来自同一次解锁操作。不要混用不同时间产出的库：
   跨库关联（`message` 里的 `real_sender_id` → `contact` 的 `name2id`）会错位，
   表现为**发送者名字显示成别人或"服务通知"**。
3. **只能只读打开。**
   消费方用 `mode=ro`（或 `immutable=1`）打开，不会改动产物；产出方也无需为消费方加锁。
4. **库之间不要跨账号混装。** 一个 `unlocked_root` 只对应一个账号。
5. **不要放密钥。** manifest 里不要出现任何密钥材料（指纹哈希除外）。

## 四、消费方会做哪些校验（失败时的提示依据）

启动 / 每次轮询时：

| 检查 | 不通过时的行为 |
| --- | --- |
| `<unlocked_root>/manifest.json` 存在且可解析 | 明确报"未配置已解锁目录"，并给出配置路径 |
| `manifest_version == 1` | 报"产物版本不受支持" |
| 必需库都在 `databases[].rel` 里，且 `output` 指向的文件存在 | 报缺哪些库（逐项列出） |
| 每个文件头是 `SQLite format 3\0` | 报"不是明文库：产物可能没解开或被截断" |
| `created_at` 距今超过阈值（默认 24 小时） | 提示"产物可能已过期，建议重新解锁"（**不阻断**，只提示） |
| `source.mtime_ns` 落后于当前源库（能读到源库时） | 提示"微信有新数据未进产物" |

## 五、怎么用（消费方视角）

```jsonc
// message-agent 的 config.json
{
  "unlocked_root": "C:\\Users\\<你>\\AppData\\Local\\wechat-db-lab\\vault\\wxid_xxx_xxxx"
  // 其余配置项见 config.template.json
}
```

指向 `<unlocked_root>` 后启动即可。本项目**不会**、也**不能**替你解锁。
