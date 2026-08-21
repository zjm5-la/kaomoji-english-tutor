# pi-english-anki

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
- **按需备课**：条件满足后生成一天的完整批次：10 个单词或词组（以单词为主，词组最多 3 个）加 1 个语法填空。学习者备考雅思：单词/词组至少 3 个来自当前会话的真实表达，其余从雅思入门/基础段（4.0-5.5 分，A2-B1）高频常用核心词选取（雅思线贴合画像词汇档、初学阶段禁超纲学术难词，critic 把关；会话来源的工作词汇不受难度限制，立即能用即优先）；会话缺乏英语内容时也用雅思词汇出满一批。新卡只在首次真正展示时消耗每日额度；Skip 补卡严格一换一、额度外，并让位于已到期复习，补卡同样可用雅思词汇兜底
- **适应难度**：从近 60 天答题记录确定性聚合学习者画像（句法/词汇档位、首轮通过率、辅助依赖、归一化薄弱点），推导客观难度预算（句长区间、句法复杂度、词汇层次、生词上限、爬坡方向）。备课与独立 critic 都接入同一预算；句长/生词数超出预算会被审查客观打回。冷启动先验为 B1；零/低证据时默认巩固而非拉伸，预算经迟滞平滑（升档每次备课最多一档、降档立即、拉伸需连续两次信号）。B0–B3 为未校准的内部难度档，不是 CEFR 测量
- **统一 Pi SDK 通信**：备课、独立 critic、修订、补卡、句子数据补全及答案评价全部通过隔离的 Pi SDK 内存会话执行；内部会话不加载扩展、skills、项目上下文或文件工具。生成内容和补卡只有通过独立 critic 才会写入
- **语法填空**：每道题是一句英文恰挖一个空（空后括号给原形提示），专考时态、语态、主谓一致、介词等明确语法点，答案唯一；题面只显示英文句（中文翻译和考点说明留在答案面）；**首次出场就直接做题**，首答即真实掌握证据，无教学面；本地精确评判、SDK LLM 兄底。更早生成的渐进默写句子卡不再新增，存量卡片照常复习（L1 填空 → L2 分句 → L3 整句）
- **遗忘曲线复习**：学习项用 [FSRS](https://github.com/open-spaced-repetition/fsrs.js)（Anki 同源算法）调度。单词/词组的中→英产出与英→中识别是两个独立技能，分别持有 FSRS 状态与到期时间（迁移自动把旧状态回填到两个方向）；两个方向强制最小 24 小时间隔，避免刚默写完就送识别答案；卡片到期时选择真正到期的方向，同到期先考产出。辅助感知调度：无辅助答对=Good、提示后答对至多 Hard、翻面后答对=Again；手动 `/anki:good` 作为自评单独记录并保守调度（至多 Hard），不冒充客观证据。模型暂时无法可靠判断时不记录成绩。句子在纠错后完成本轮，但按第一次回忆表现提交一次 Good/Again；损坏的 FSRS 数据会保留原文并隔离，不会静默重置
- **出题日志**：每次作答把题目快照、答案、判定与反馈写入 attempts 表，争议可审计；备课/补卡时注入最近作答记录，作为把握学生近况与避免争议出题的依据。释义字段只保留可回忆的最小释义，作用说明放例句，critic 发现混入直接打回。备课与补卡的每次决策（等待/打回/去重/报错/成功，含原因）写入环形日志（最近 20 条），`/anki:stats` 显示最近几条，「为什么没出卡」可追溯
- **卡片交互**：单词/词组复习按方向到期时间进行中→英或英→中回忆；英→中识别方向接受同义表达与语体差异（如“已”与“已经”），中→英默写保持拼写严格；句子答案由本地精确匹配或隔离 SDK LLM 按语义、语法和搭配评价。句子写错会停留原级、给最小修正并要求立即重写；提示/翻面会使本轮最终按 Again 调度，单词/词组的提示与翻面同样影响调度并跨会话生效
- **精简状态**：常驻 widget 只显示连续学习天数和今日剩余卡片；掌握阶段、强化需求和正确率通过 `/anki:stats` 查看
- **持久化**：学习记录、句子输出 cycle、重试和辅助状态存在 SQLite（`~/.pi/agent/kaomoji-english-tutor.db`，WAL 模式），跨会话累积；每天新学上限 11 个（一批 10 个单词/词组 + 1 个语法填空，可配置）
- **多会话一致**：并行运行多个 Pi 会话时共享同一张当前卡；句子级别、纠错、提示、翻面及首次回忆结果也会跨会话/reload 恢复，任一会话提交后其他会话自动同步
- **颜文字心情**：教新课 `(=^･ω･^=)`、复习 `(=^‥^=)`、无事打瞌睡 `(=ΦωΦ=)`、出错 `(=；ω；=)`

### 安装

```bash
pi install git:github.com/zjm5-la/pi-english-anki
```

或者添加到 `settings.json`：

```json
{
  "packages": ["git:github.com/zjm5-la/pi-english-anki"]
}
```

### 命令

| 命令 | 说明 |
| --------- | ------------- |
| `/anki:model` | 交互式选择备课模型（仅列出已登录/已配置密钥的模型，按推荐优先级排序） |
| `/anki:model <编号>` | 按列表编号直接选择 |
| `/anki:model <provider/model>` | 直接指定模型（如 `deepseek/deepseek-v4-flash`） |
| `/anki:thinking <等级>` | 设置备课思考等级：`off` 到 `max` |
| `/anki:interval <分钟\|off>` | 设置自动检查间隔，或关闭自动检查 |
| `/anki:flip` | 在问题面和答案面之间切换 |
| `/anki:answer <答案>` | 单词/词组双向回忆，或提交句子渐进输出；系统本地匹配或调用 SDK LLM 判定 |
| `/anki:hint` | 显示当前单词/词组回忆提示，或句子当前级别的英文首字提示 |
| `/anki:stats` | 显示掌握阶段分布、强化需求、答题正确率，以及学习者画像（档位/置信度/首轮通过率/辅助/薄弱点）与当前难度预算 |
| `/anki:teach <话题>` | 立即就指定话题备课（绕过自动话题检测） |
| `/anki:good` | 手动自评记得：单独记录为自评，调度保守（至多 Hard），不产生客观掌握证据；句子卡不能跳过真实输出 |
| `/anki:again` | 手动评分为忘了；句子在任意级别都可结束本轮并从 L1 重新调度 |
| `/anki:skip` | 标记为很熟，至少 365 天后再出现，并尝试补充同类型卡片 |

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
  "maxTokens": 262144,
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
| `maxTokens` | `262144` | 所有备课/审查/评价 LLM 调用的输出 token 上限（实际生效值会被模型自身上限收窄） |
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
- **Readiness-aware lessons**: the model waits when the conversation lacks a useful topic, and identical rejected context is not sent again. When ready, it creates 1 word, 1 phrase, and 1 grammar cloze. Planned cards consume quota only on first display; Skip replacements are strictly one-for-one, quota-free, and yield to due reviews
- **Unified Pi SDK transport**: lesson generation, independent critique, revision, replacements, sentence-data completion, and answer evaluation all run through isolated in-memory Pi SDK sessions with no discovered extensions, skills, project context, or file tools. Lessons and replacements are inserted only after independent critic approval
- **Grammar cloze**: each card is one English sentence with exactly one blank (lemma hint in parentheses), targeting a single clear grammar point (tense, voice, agreement, prepositions, ...) with a unique answer; the question face shows only the English sentence (translation and grammar note stay on the answer face); **the very first showing is already the quiz** — the first answer is genuine mastery evidence, no teach face; graded by local exact match with isolated SDK LLM fallback. Legacy progressive sentence cards are no longer generated but keep being reviewed normally (L1 cloze → L2 clause → L3 full sentence)
- **Spaced repetition**: items use [FSRS](https://github.com/open-spaced-repetition/fsrs.js). Word/phrase Chinese→English production and English→Chinese recognition are distinct skills with independent FSRS states and due times (legacy state migrates into both directions); the two directions are forced at least 24h apart so a just-reviewed direction cannot prime the other; a due card surfaces its actually-due direction, ties favor production so recognition cannot leak the answer. Assistance-aware scheduling: unassisted correct = Good, correct after a hint = at most Hard, correct after a flip/reveal = Again; manual `/anki:good` is recorded separately as a self-report and scheduled conservatively (at most Hard), never as objective evidence. Unavailable evaluation writes no score. A sentence allows corrective retries but commits one Good/Again based on the first-recall path; corrupt FSRS state is preserved and quarantined instead of silently reset
- **Question log**: every attempt persists the question snapshot, answer, verdict, and feedback in the attempts table, so disputes are auditable; recent attempts are injected into lesson/replacement generation as evidence of learner state and past question-design issues. Meaning fields keep only the minimal recallable translation — usage notes belong to examples, and the critic rejects violations. Every lesson/replacement decision (waiting / rejected / duplicate / error / success, with reason) lands in a 20-entry ring log; `/anki:stats` shows the latest few, making "why no new cards" answerable
- **Card interaction**: word/phrase direction follows per-direction due times (Chinese→English or English→Chinese); Chinese-meaning recall accepts synonymous and register variants (e.g. 已 vs 已经) while English production stays spelling-strict. Sentence output is checked locally when exact or semantically by the isolated SDK LLM; misses receive one minimal correction and remain on the same level for immediate rewriting. Hint/flip makes the sentence cycle Again, and word/phrase hint/reveal equally affect scheduling, persisting across sessions
- **Compact status**: the persistent widget only shows learning streak and cards remaining today; `/anki:stats` keeps mastery, reinforcement, and accuracy details
- **Persistent**: learning history, sentence cycles, retries, and assistance live in SQLite (`~/.pi/agent/kaomoji-english-tutor.db`, WAL mode); daily new-item cap defaults to 3
- **Multi-session consistency**: concurrent Pi sessions share one current card; sentence level, correction, hint/reveal state, and first-recall outcome survive session changes/reload and synchronize automatically
- **Kaomoji moods**: teaching `(=^･ω･^=)`, reviewing `(=^‥^=)`, dozing off `(=ΦωΦ=)`, error `(=；ω；=)`

### Install

```bash
pi install git:github.com/zjm5-la/pi-english-anki
```

Or add to `settings.json`:

```json
{
  "packages": ["git:github.com/zjm5-la/pi-english-anki"]
}
```

### Commands

| Command | Description |
| --------- | ------------- |
| `/anki:model` | Interactively pick the lesson model (only authenticated providers, sorted by preference) |
| `/anki:model <number>` | Pick by list number |
| `/anki:model <provider/model>` | Set explicitly (e.g. `deepseek/deepseek-v4-flash`) |
| `/anki:thinking <level>` | Set lesson reasoning level (`off` through `max`) |
| `/anki:interval <minutes\|off>` | Set or disable automatic checks |
| `/anki:flip` | Toggle question and answer sides |
| `/anki:answer <answer>` | Submit bidirectional word/phrase recall or progressive written sentence output; checked locally or by the SDK evaluator |
| `/anki:hint` | Show the current word/phrase recall hint or the sentence level's initial-letter hint |
| `/anki:stats` | Show mastery-stage distribution, reinforcement needs, answer accuracy, plus the learner profile (bands/confidence/first-pass rates/assistance/error focus) and current difficulty budget |
| `/anki:teach <topic>` | Prepare a lesson on a specific topic now (bypasses auto-readiness) |
| `/anki:good` | Manual self-report of knowing: recorded separately and scheduled conservatively (at most Hard), never objective mastery evidence; cannot bypass required sentence output |
| `/anki:again` | Manually rate forgotten; from any sentence level, end the cycle and schedule the next attempt from L1 |
| `/anki:skip` | Mark as well known, return after at least 365 days, and attempt a same-type replacement |
| `/anki:pull` | Pull newer learning data from the cloud (local DB backed up as `.bak`) |
| `/anki:sync` | Push learning data to the cloud sync repo now |

Takes effect immediately and persists to `~/.pi/agent/kaomoji-english-tutor.json`. If project config defines the same field, the project value wins after reload.

### Cloud sync

Learning data syncs across machines through a private Git repo (whole-DB snapshot, last writer wins — use one machine at a time):

1. Create a private repo (e.g. `kaomoji-tutor-data`) and clone it to `~/.pi/agent/kaomoji-english-tutor-sync/`; the extension auto-enables sync when this directory exists.
2. **Pull**: never blocks startup — a background check after session start nudges you when the cloud is newer; `/anki:pull` then swaps in the remote snapshot (local DB backed up as `.bak-<timestamp>`).
3. **Push**: throttled by the timer (at most once per 30 min) after progress, plus a final push on session shutdown; `/anki:sync` pushes immediately.
4. A push is refused when the remote holds newer progress — `/anki:pull` pulls it instead of clobbering.
5. Sync actions land in the generation decision log (`sync_pulled` / `sync_pushed` / `sync_remote_newer` / `sync_error`), visible via `/anki:stats`.

### Configuration

Create `~/.pi/agent/kaomoji-english-tutor.json` (global) or `.pi/kaomoji-english-tutor.json` (project override). All fields optional:

| Setting | Default | Description |
| --------- | --------- | ------------- |
| `provider` | *(auto-detect)* | Lesson model provider |
| `model` | *(auto-detect)* | Lesson model ID |
| `thinkingLevel` | *(provider default)* | Reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `intervalMinutes` | `10` | Background check/lesson interval when no stored card is ready; `0` disables it; ready queued cards have no inter-card wait |
| `dailyNewLimit` | `3` | Planned cards first shown per day; `0` is unlimited and Skip replacements are quota-free |
| `maxTokens` | `262144` | Output-token ceiling for every generation/critique/evaluation call (clamped by the model's own limit) |
| `showWidget` | `true` | Show the pet widget |
| `verbose` | `false` | Notify whenever a new item is taught |

### Notes

- Without explicit config, the pet automatically picks a suitable model for lessons (e.g. gpt-5.4-mini, deepseek-v4-flash, grok-4.3, glm-5.2), only from providers with configured auth (logged in or API key present)
- If the chosen model is unreachable (missing key, network or provider errors), it falls back to the model driving the current session and retries
- When context is insufficient, the model waits instead of fabricating cards; within the current session, unchanged rejected context is not requested again
- Learning data lives in `~/.pi/agent/kaomoji-english-tutor.db`; exit Pi before deleting the file so a live SQLite connection cannot keep writing to an unlinked database
