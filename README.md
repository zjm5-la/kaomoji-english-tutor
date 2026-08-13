# kaomoji-english-tutor

**🌐 语言 / Language：** **[中文](#zh)** · [English](#en)

<a id="zh"></a>

## 中文说明

一只用颜文字当形象的英语小宠物，住在 pi 编辑器下方的 widget 里。它默默看着你的会话，根据当前工作主题自动备课并在到期时出卡；你通过简短命令完成回忆和英文输出。

```
(=^･ω･^=) 单词：overfitting /ˌəʊ.vəˈfɪt.ɪŋ/
  释义：过拟合
  例：Dropout can help reduce overfitting in neural networks.（Dropout 可以帮助减少神经网络中的过拟合。）
🔥 连续学习 5 天 · 今日剩余 4 张卡片
```

### 机制

- **时间触发**：默认每 10 分钟自动检查备课/到期状态（可配置）；若队列里已有可学习卡，评分后会像 Anki 一样立即显示下一张，不在两张卡之间强制等待
- **按需备课**：宠物从最近对话中识别主题。模型判定信息不足后，如果会话没有变化就不会重复请求；条件满足后生成 1 个单词、1 个词组和 1 个渐进长句。新卡只在首次真正展示时消耗每日额度；Skip 补卡严格一换一、额度外，并让位于已到期复习
- **适应难度**：从近 60 天答题记录确定性聚合学习者画像（句法/词汇档位、首轮通过率、辅助依赖、薄弱点），推导客观难度预算（句长区间、句法复杂度、词汇层次、生词上限、爬坡方向）。备课与独立 critic 都接入同一预算；句长/生词数超出预算会被审查客观打回。冷启动先验为 B1（即原行为）
- **统一 Pi SDK 通信**：备课、独立 critic、修订、补卡、句子数据补全及答案评价全部通过隔离的 Pi SDK 内存会话执行；内部会话不加载扩展、skills、项目上下文或文件工具。生成内容和补卡只有通过独立 critic 才会写入
- **渐进句子输出**：同一张句子卡从 L1 单词填空 → L2 主干英文 → L3 完整自然表达；每级都用 `/kaomoji:answer` 真正输入英文，标准句只是参考，不要求逐字复刻
- **遗忘曲线复习**：学习项用 [FSRS](https://github.com/open-spaced-repetition/fsrs.js)（Anki 同源算法）调度；单词/词组答对自动 Good、答错或部分正确自动 Again，模型暂时无法可靠判断时不记录成绩。句子在纠错后完成本轮，但按第一次回忆表现提交一次 Good/Again；损坏的 FSRS 数据会保留原文并隔离，不会静默重置
- **卡片交互**：单词/词组复习随机进行中→英或英→中回忆；句子答案由本地精确匹配或隔离 SDK LLM 按语义、语法和搭配评价。句子写错会停留原级、给最小修正并要求立即重写；提示/翻面会使本轮最终按 Again 调度
- **精简状态**：常驻 widget 只显示连续学习天数和今日剩余卡片；掌握阶段、强化需求和正确率通过 `/kaomoji:stats` 查看
- **持久化**：学习记录、句子输出 cycle、重试和辅助状态存在 SQLite（`~/.pi/agent/kaomoji-english-tutor.db`，WAL 模式），跨会话累积；每天新学上限 3 个（可配置）
- **多会话一致**：并行运行多个 Pi 会话时共享同一张当前卡；句子级别、纠错、提示、翻面及首次回忆结果也会跨会话/reload 恢复，任一会话提交后其他会话自动同步
- **颜文字心情**：教新课 `(=^･ω･^=)`、复习 `(=^‥^=)`、无事打瞌睡 `(=ΦωΦ=)`、出错 `(=；ω；=)`

### 安装

```bash
pi install git:github.com/zjm5-la/kaomoji-english-tutor
```

或者添加到 `settings.json`：

```json
{
  "packages": ["git:github.com/zjm5-la/kaomoji-english-tutor"]
}
```

### 命令

| 命令 | 说明 |
| --------- | ------------- |
| `/kaomoji:model` | 交互式选择备课模型（仅列出已登录/已配置密钥的模型，按推荐优先级排序） |
| `/kaomoji:model <编号>` | 按列表编号直接选择 |
| `/kaomoji:model <provider/model>` | 直接指定模型（如 `deepseek/deepseek-v4-flash`） |
| `/kaomoji:thinking <等级>` | 设置备课思考等级：`off` 到 `max` |
| `/kaomoji:interval <分钟\|off>` | 设置自动检查间隔，或关闭自动检查 |
| `/kaomoji:flip` | 在问题面和答案面之间切换 |
| `/kaomoji:answer <答案>` | 单词/词组双向回忆，或提交句子渐进输出；系统本地匹配或调用 SDK LLM 判定 |
| `/kaomoji:hint` | 显示当前单词/词组回忆提示，或句子当前级别的英文首字提示 |
| `/kaomoji:stats` | 显示掌握阶段分布、强化需求、答题正确率，以及学习者画像（档位/置信度/首轮通过率/辅助/薄弱点）与当前难度预算 |
| `/kaomoji:teach <话题>` | 立即就指定话题备课（绕过自动话题检测） |
| `/kaomoji:good` | 手动评分为记得；句子卡不能跳过真实输出 |
| `/kaomoji:again` | 手动评分为忘了；句子在任意级别都可结束本轮并从 L1 重新调度 |
| `/kaomoji:skip` | 标记为很熟，至少 365 天后再出现，并尝试补充同类型卡片 |

设置后立即生效并持久化到 `~/.pi/agent/kaomoji-english-tutor.json`。如果项目配置包含同名字段，reload 后仍以项目配置为准。

### 配置

创建 `~/.pi/agent/kaomoji-english-tutor.json`（全局）或 `.pi/kaomoji-english-tutor.json`（项目覆盖）。所有字段可选：

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "thinkingLevel": "medium",
  "intervalMinutes": 10,
  "dailyNewLimit": 3,
  "maxTokens": 900,
  "showWidget": true,
  "verbose": false
}
```

| 设置项 | 默认值 | 说明 |
| --------- | --------- | ------------- |
| `provider` | *(自动检测)* | 备课模型提供商 |
| `model` | *(自动检测)* | 备课模型 ID |
| `thinkingLevel` | *(provider 默认)* | 推理强度：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `intervalMinutes` | `10` | 无现成队列卡时的自动检查/备课间隔（分钟）；设为 `0` 可关闭；现成队列卡之间不等待 |
| `dailyNewLimit` | `3` | 每天首次展示的计划新卡上限；`0` 为不限，Skip 补卡不占额度 |
| `maxTokens` | `900` | 备课 LLM 响应的最大 token 数 |
| `showWidget` | `true` | 是否显示宠物 widget |
| `verbose` | `false` | 每次教新内容时显示通知 |

### 说明

- 未手动指定时，宠物会自动挑选适合的模型备课（如 gpt-5.4-mini、deepseek-v4-flash、grok-4.3、glm-5.2），仅从已登录或已配置密钥的提供商中选择
- 若选中的模型无法访问（密钥缺失、网络或服务端错误），自动降级到当前会话正在使用的模型重试
- 模型判断信息不足时不会硬凑学习卡；本次会话内，同一份被拒绝的会话内容不会重复请求模型
- 学习数据位于 `~/.pi/agent/kaomoji-english-tutor.db`；请先退出 Pi 再删除数据库文件，以免运行中的 SQLite 连接继续写入旧文件

---

<a id="en"></a>

## English

A kaomoji pet that lives in a widget below the editor, prepares lessons from your conversation topic, and surfaces due cards automatically; short commands handle recall and written output.

### How it works

- **Time-triggered**: checks lesson/readiness state every 10 minutes by default; when another stored card is ready, rating immediately surfaces it Anki-style with no forced inter-card delay
- **Readiness-aware lessons**: the model waits when the conversation lacks a useful topic, and identical rejected context is not sent again. When ready, it creates 1 word, 1 phrase, and 1 progressive sentence. Planned cards consume quota only on first display; Skip replacements are strictly one-for-one, quota-free, and yield to due reviews
- **Unified Pi SDK transport**: lesson generation, independent critique, revision, replacements, sentence-data completion, and answer evaluation all run through isolated in-memory Pi SDK sessions with no discovered extensions, skills, project context, or file tools. Lessons and replacements are inserted only after independent critic approval
- **Progressive sentence output**: one sentence moves from an L1 word cloze to L2 core-clause writing and L3 natural full-sentence production; every level requires `/kaomoji:answer`, and the reference is not treated as the only valid wording
- **Spaced repetition**: items use [FSRS](https://github.com/open-spaced-repetition/fsrs.js). Word/phrase answers auto-rate when evaluation is reliable; unavailable evaluation writes no score. A sentence allows corrective retries but commits one Good/Again based on the first-recall path; corrupt FSRS state is preserved and quarantined instead of silently reset
- **Card interaction**: word/phrase direction is randomized Chinese→English or English→Chinese. Sentence output is checked locally when exact or semantically by the isolated SDK LLM; misses receive one minimal correction and remain on the same level for immediate rewriting. Hint/flip makes the sentence cycle Again
- **Compact status**: the persistent widget only shows learning streak and cards remaining today; `/kaomoji:stats` keeps mastery, reinforcement, and accuracy details
- **Persistent**: learning history, sentence cycles, retries, and assistance live in SQLite (`~/.pi/agent/kaomoji-english-tutor.db`, WAL mode); daily new-item cap defaults to 3
- **Multi-session consistency**: concurrent Pi sessions share one current card; sentence level, correction, hint/reveal state, and first-recall outcome survive session changes/reload and synchronize automatically
- **Kaomoji moods**: teaching `(=^･ω･^=)`, reviewing `(=^‥^=)`, dozing off `(=ΦωΦ=)`, error `(=；ω；=)`

### Install

```bash
pi install git:github.com/zjm5-la/kaomoji-english-tutor
```

Or add to `settings.json`:

```json
{
  "packages": ["git:github.com/zjm5-la/kaomoji-english-tutor"]
}
```

### Commands

| Command | Description |
| --------- | ------------- |
| `/kaomoji:model` | Interactively pick the lesson model (only authenticated providers, sorted by preference) |
| `/kaomoji:model <number>` | Pick by list number |
| `/kaomoji:model <provider/model>` | Set explicitly (e.g. `deepseek/deepseek-v4-flash`) |
| `/kaomoji:thinking <level>` | Set lesson reasoning level (`off` through `max`) |
| `/kaomoji:interval <minutes\|off>` | Set or disable automatic checks |
| `/kaomoji:flip` | Toggle question and answer sides |
| `/kaomoji:answer <answer>` | Submit bidirectional word/phrase recall or progressive written sentence output; checked locally or by the SDK evaluator |
| `/kaomoji:hint` | Show the current word/phrase recall hint or the sentence level's initial-letter hint |
| `/kaomoji:stats` | Show mastery-stage distribution, reinforcement needs, answer accuracy, plus the learner profile (bands/confidence/first-pass rates/assistance/error focus) and current difficulty budget |
| `/kaomoji:teach <topic>` | Prepare a lesson on a specific topic now (bypasses auto-readiness) |
| `/kaomoji:good` | Manually rate remembered; cannot bypass required sentence output |
| `/kaomoji:again` | Manually rate forgotten; from any sentence level, end the cycle and schedule the next attempt from L1 |
| `/kaomoji:skip` | Mark as well known, return after at least 365 days, and attempt a same-type replacement |

Takes effect immediately and persists to `~/.pi/agent/kaomoji-english-tutor.json`. If project config defines the same field, the project value wins after reload.

### Configuration

Create `~/.pi/agent/kaomoji-english-tutor.json` (global) or `.pi/kaomoji-english-tutor.json` (project override). All fields optional:

| Setting | Default | Description |
| --------- | --------- | ------------- |
| `provider` | *(auto-detect)* | Lesson model provider |
| `model` | *(auto-detect)* | Lesson model ID |
| `thinkingLevel` | *(provider default)* | Reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `intervalMinutes` | `10` | Background check/lesson interval when no stored card is ready; `0` disables it; ready queued cards have no inter-card wait |
| `dailyNewLimit` | `3` | Planned cards first shown per day; `0` is unlimited and Skip replacements are quota-free |
| `maxTokens` | `900` | Max tokens for lesson generation |
| `showWidget` | `true` | Show the pet widget |
| `verbose` | `false` | Notify whenever a new item is taught |

### Notes

- Without explicit config, the pet automatically picks a suitable model for lessons (e.g. gpt-5.4-mini, deepseek-v4-flash, grok-4.3, glm-5.2), only from providers with configured auth (logged in or API key present)
- If the chosen model is unreachable (missing key, network or provider errors), it falls back to the model driving the current session and retries
- When context is insufficient, the model waits instead of fabricating cards; within the current session, unchanged rejected context is not requested again
- Learning data lives in `~/.pi/agent/kaomoji-english-tutor.db`; exit Pi before deleting the file so a live SQLite connection cannot keep writing to an unlinked database
