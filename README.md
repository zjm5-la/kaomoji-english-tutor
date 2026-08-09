# kaomoji-english-tutor

**🌐 语言 / Language：** **[中文](#zh)** · [English](#en)

<a id="zh"></a>

## 中文说明

一只用颜文字当形象的英语小宠物，住在 pi 编辑器下方的 widget 里。它默默看着你的会话，根据你当前的工作主题教你英语——不用任何命令，一切自动发生。

```
(=^･ω･^=) 单词：overfitting /ˌəʊ.vəˈfɪt.ɪŋ/
  释义：过拟合
  例：Dropout can help reduce overfitting in neural networks.（Dropout 可以帮助减少神经网络中的过拟合。）
📚 已学 12 · 今日新增 2 · 今日复习 3 · 连续学习 5 天
```

### 机制

- **时间触发**：默认每 10 分钟自动检查一次（可配置）；有待评分卡片时暂停，评分后重新计时
- **按需备课**：宠物从最近对话中识别主题。模型判定信息不足后，如果会话没有变化就不会重复请求；条件满足后生成 1 个单词、1 个词组和 1 个渐进长句
- **渐进长句**：同一张句子卡按 L1 主干 → L2 扩展 → L3 完整长句训练，配有逐级翻译、意群切分和独立生词卡
- **遗忘曲线复习**：学习项用 [FSRS](https://github.com/open-spaced-repetition/fsrs.js)（Anki 同源算法）调度；只有明确的 Good/Again/Skip 才修改调度，展示卡片不会自动评分
- **卡片交互**：卡片常驻编辑器下方 Widget；使用 `/kaomoji:flip` 翻面、`/kaomoji:good` 记得、`/kaomoji:again` 忘了、`/kaomoji:skip` 标记很熟并尝试补充同类型卡片；命令不进入会话历史
- **持久化**：学习记录存在 SQLite（`~/.pi/agent/kaomoji-english-tutor.db`，WAL 模式），跨会话累积；每天新学上限 3 个（可配置）
- **多会话一致**：并行运行多个 Pi 会话时共享同一张当前卡；任一会话完成评分后，其他会话会自动同步，翻面状态仍各自独立
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
| `/kaomoji:good` | 评分为记得；长句训练中升级 |
| `/kaomoji:again` | 评分为忘了；长句训练中退级，L1 时进入 FSRS Again |
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
| `intervalMinutes` | `10` | 自动检查间隔（分钟）；设为 `0` 可关闭 |
| `dailyNewLimit` | `3` | 每天新学学习项上限 |
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

A kaomoji pet that lives in a widget below the editor and teaches you English based on your conversation topic — fully automatic, no commands needed.

### How it works

- **Time-triggered**: checks automatically every 10 minutes by default; pauses while a card awaits a rating and restarts after completion
- **Readiness-aware lessons**: the model waits when the conversation lacks a useful topic, and identical rejected context is not sent again. When ready, it creates 1 word, 1 phrase, and 1 progressive sentence
- **Progressive sentences**: one sentence card advances from L1 core clause to L2 expansion and L3 full sentence, with per-level translations, chunks, and companion word cards
- **Spaced repetition**: items use [FSRS](https://github.com/open-spaced-repetition/fsrs.js); only explicit Good/Again/Skip actions change scheduling—displaying a card never rates it
- **Card interaction**: cards remain visible in the widget; use `/kaomoji:flip` to reveal the answer, `/kaomoji:good` for Good, `/kaomoji:again` for Again, and `/kaomoji:skip` to mark a card known and attempt a same-type replacement; commands do not enter session history
- **Persistent**: learning history lives in SQLite (`~/.pi/agent/kaomoji-english-tutor.db`, WAL mode); daily new-item cap defaults to 3
- **Multi-session consistency**: concurrent Pi sessions share one current card; rating it in any session automatically synchronizes the others, while flip state remains local
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
| `/kaomoji:good` | Remember; advances progressive sentences |
| `/kaomoji:again` | Forget; steps progressive sentences back, or schedules FSRS Again at L1 |
| `/kaomoji:skip` | Mark as well known, return after at least 365 days, and attempt a same-type replacement |

Takes effect immediately and persists to `~/.pi/agent/kaomoji-english-tutor.json`. If project config defines the same field, the project value wins after reload.

### Configuration

Create `~/.pi/agent/kaomoji-english-tutor.json` (global) or `.pi/kaomoji-english-tutor.json` (project override). All fields optional:

| Setting | Default | Description |
| --------- | --------- | ------------- |
| `provider` | *(auto-detect)* | Lesson model provider |
| `model` | *(auto-detect)* | Lesson model ID |
| `thinkingLevel` | *(provider default)* | Reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `intervalMinutes` | `10` | Automatic check interval in minutes; `0` disables it |
| `dailyNewLimit` | `3` | Max new items taught per day |
| `maxTokens` | `900` | Max tokens for lesson generation |
| `showWidget` | `true` | Show the pet widget |
| `verbose` | `false` | Notify whenever a new item is taught |

### Notes

- Without explicit config, the pet automatically picks a suitable model for lessons (e.g. gpt-5.4-mini, deepseek-v4-flash, grok-4.3, glm-5.2), only from providers with configured auth (logged in or API key present)
- If the chosen model is unreachable (missing key, network or provider errors), it falls back to the model driving the current session and retries
- When context is insufficient, the model waits instead of fabricating cards; within the current session, unchanged rejected context is not requested again
- Learning data lives in `~/.pi/agent/kaomoji-english-tutor.db`; exit Pi before deleting the file so a live SQLite connection cannot keep writing to an unlinked database
