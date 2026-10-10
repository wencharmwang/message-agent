"""从已安装的 Harness 预设生成本项目的部署配置。

这是**开发/源码检出**用的脚本（打包安装走 packaging/make_config.py）。所以它必须对
别人的机器也成立：路径全部**推导或可覆盖**，不写死任何人的用户名。

* 本仓库根 = 这个文件所在目录；
* messaging-runtime 默认取**同级目录** `../messaging-runtime`
  （两个仓库按 README 的说明并排放时就是这个布局）；
  放别处就用环境变量 `MESSAGING_RUNTIME_ROOT` 指定。

跑之前请先停掉正在运行的消息助手（它要重写 config.json）。
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNTIME = Path(os.environ.get('MESSAGING_RUNTIME_ROOT') or (ROOT.parent / 'messaging-runtime'))

if not (RUNTIME / '.runtime-data/auto-reply/config.json').is_file():
    sys.exit(
        '找不到 messaging-runtime 的运行时配置：\n'
        f'  {RUNTIME / ".runtime-data/auto-reply/config.json"}\n'
        '请先跑一次 messaging-runtime（让它生成 .runtime-data），'
        '或用环境变量 MESSAGING_RUNTIME_ROOT 指向那个仓库。'
    )

AUTO_PRESET = """# Automatic replies use only the decision tool registered by plugin/index.mjs.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      你是用户已授权的自动消息助手。自然、友好、简短地接续日常聊天。未知生活状态不能编造，但可以回应关心或询问来意。只有真实承诺、授权或重要决定才需要本人处理。必须通过 submit_reply_decision 提交一次决定；该工具成功后任务会立即结束。

- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
"""

config = json.loads((RUNTIME/'.runtime-data/auto-reply/config.json').read_text(encoding='utf-8-sig'))
config.update(harness_port=3080, agent_workspace=str(ROOT/'workspace'), response_timeout_seconds=180,
              database=str(ROOT/'data/reply.db'), worker_token_file=str(ROOT/'data/worker.token'),
              control_token_file=str(ROOT/'data/control.token'), harness_home=str(ROOT/'.harness'),
              max_tokens=4096, auto_reasoning_effort='low')

# 保留已有的 unlocked_root：那是用户自己指到"已解锁目录"的，重跑本脚本不该把它抹掉。
# （本项目不解锁，产物由用户准备 —— 丢掉这个键就等于让程序突然读不到数据。）
existing = ROOT/'config.json'
unlocked_root = ''
if existing.is_file():
    try:
        unlocked_root = json.loads(existing.read_text(encoding='utf-8-sig')).get('unlocked_root') or ''
    except (OSError, ValueError):
        unlocked_root = ''
config['unlocked_root'] = unlocked_root
if not unlocked_root:
    print('提示：还没配置 unlocked_root —— 程序能启动，但读不到消息。')
    print('      准备好数据后把 config.json 里的 unlocked_root 指向那个目录即可。')

(ROOT/'config.json').write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
print('已生成 config.json（unlocked_root 会原样保留）。')

# Preserve the reviewed lightweight preset instead of copying the coding preset.
interactive = (ROOT/'presets/message-agent/agent.cordis.yml').read_text(encoding='utf-8')

# ``selectable: false`` on the background preset keeps it off every picker
# without taking it off the roster: the plugin still resolves ``message-auto``
# by id, and a session already running it keeps its own name and description on
# the surfaces that only READ a preset. The interactive preset is the one choice
# a person makes, so it stays selectable and stays the deployment default.
PRESETS = [
    ('message-agent', interactive,
     'name: 消息助手\n'
     'description: 用于读取、分析并按用户要求处理微信消息的交互 Agent。\n'
     'order: 1\n'),
    ('message-auto', AUTO_PRESET,
     'name: 自动消息任务\n'
     'description: 监听已授权会话并按规则生成回复决策的后台 Agent。\n'
     'order: 2\n'
     'selectable: false\n'),
]

# ---- 预设与 web.patch.yml：**已存在就不动** ----
#
# 为什么默认不覆写：这几份文件在仓库里是**受版本管理的**，而且后来被手工改过 ——
# 特别是 web.patch.yml 里那 17 条 `disabled: true`（tool-web / tool-bash / tool-fs /
# tool-subagent …），它们是**故意关掉 Harness 通用工具**的：只保留 messaging-runtime
# 的 MCP 工具，减少每轮注入的 tool schema（用户明确要求：不必要的工具不注入，省 token）。
#
# 而本脚本里的模板是**旧快照**：跑一次就会把 web.patch.yml 从 56 行截断回 18 行
# —— 等于**静默地**把 bash / PowerShell / 文件系统 / 网页 / 子代理能力还给 agent，
# 每轮 token 也涨回去。它只表现为一个大 diff，很容易被当成垃圾清掉或误提交。
#
# 所以：文件在 → 跳过；确实想重置成模板 → 加 --force（会明确提示后果）。
force = '--force' in sys.argv
skipped: list[str] = []
written: list[str] = []

for name, composition, metadata in PRESETS:
    directory = ROOT/'presets'/name
    directory.mkdir(parents=True, exist_ok=True)
    for filename, content in (('agent.cordis.yml', composition), ('preset.yml', metadata)):
        target = directory/filename
        if target.exists() and not force:
            skipped.append(str(target.relative_to(ROOT)))
            continue
        target.write_text(content, encoding='utf-8')
        written.append(str(target.relative_to(ROOT)))

PATCH = '''- id: agent-presets
  config:
    default: message-agent
    roots:
      - path: !!js process.env.MESSAGE_AGENT_ROOT + '/presets'
        trust: system
    includeShippedRoot: true
    includeUserRoot: true
- id: permission
  config:
    presets:
      read-only: {sandbox: read-only, approval: ask}
      workspace-write: {sandbox: workspace-write, approval: ask}
      danger-full-access: {sandbox: danger-full-access, approval: never}
      message-auto: {sandbox: read-only, approval: never, name: '自动消息任务', selectable: false}
- insert:
    - id: messaging-agent-ui
      name: './plugin/index.mjs'
'''
patch_path = ROOT/'web.patch.yml'
if patch_path.exists() and not force:
    skipped.append('web.patch.yml')
else:
    patch_path.write_text(PATCH, encoding='utf-8')
    written.append('web.patch.yml')
    if force:
        print('⚠️  --force：web.patch.yml 已按**模板**重写。模板是旧快照，')
        print('    里面没有那 17 条关闭通用工具的规则 —— 如果要保留它们，请从 git 里恢复。')

if skipped:
    print('以下文件已存在，未改动（要强制按模板重写加 --force）：')
    for item in skipped:
        print('   -', item)
if written:
    print('已生成：', '、'.join(written))
