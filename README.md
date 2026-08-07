# kaomoji-english-tutor

**🌐 语言 / Language：** **[中文](#zh)** · [English](#en)

<a id="zh"></a>

## 中文说明

一只用颜文字当形象的英语小宠物，住在 pi 编辑器下方的 widget 里。它默默看着你的会话，根据你当前的工作主题教你英语——不用任何命令，一切自动发生。

```
(=^･ω･^=) 单词：overfitting /ˌəʊ.vəˈfɪt.ɪŋ/
  释义：过拟合
  例：Dropout can help reduce overfitting in neural networks.（Dropout 可以帮助减少神经网络中的过拟合。）
📚 已学 12 · 今日复习 3 · 连续学习 5 天
```

### 机制

- **自动触发**：每 3 个会话回合（可配置）宠物活动一次
- **主题教学**：宠物从最近对话中识别主题，围绕主题自动备好一节课——1 个单词、1 个词组、1 个句子，之后几个回合逐个展示
- **遗忘曲线复习**：学习项用 [FSRS](https://github.com/open-spaced-repetition/fsrs.js)（Anki 同源算法）调度复习；到期优先复习，间隔随复习次数自动拉长（约 1 天 → 2 天 → 4 天 → …）
- **持久化**：学习记录存在 SQLite（`~/.pi/agent/kaomoji-english-tutor.db`，WAL 模式防损坏），跨会话累积；每天新学上限 3 个（可配置）
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

### 配置

创建 `~/.pi/agent/kaomoji-english-tutor.json`（全局）或 `.pi/kaomoji-english-tutor.json`（项目覆盖）。所有字段可选：

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "thinkingLevel": "off",
  "debounceTurns": 3,
  "dailyNewLimit": 3,
  "maxTokens": 600,
  "showWidget": true,
  "verbose": false
}
```

| 设置项 | 默认值 | 说明 |
| --------- | --------- | ------------- |
| `provider` | *(自动检测)* | 备课模型提供商 |
| `model` | *(自动检测)* | 备课模型 ID |
| `thinkingLevel` | *(provider 默认)* | 推理强度：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `debounceTurns` | `3` | 每多少个会话回合宠物活动一次 |
| `dailyNewLimit` | `3` | 每天新学学习项上限 |
| `maxTokens` | `600` | 备课 LLM 响应的最大 token 数 |
| `showWidget` | `true` | 是否显示宠物 widget |
| `verbose` | `false` | 每次教新内容时显示通知 |

### 说明

- 未手动指定时，宠物会自动挑选适合的模型备课（如 gpt-5.4-mini、deepseek-v4-flash、grok-4.3、glm-5.2），仅从已登录或已配置密钥的提供商中选择
- 若选中的模型无法访问（密钥缺失、网络或服务端错误），自动降级到当前会话正在使用的模型重试
- 复习为展示式（宠物展示卡片，默认按「Good」推进 FSRS 调度）；数据结构保留评分入口，未来可加交互
- 学习数据位于 `~/.pi/agent/kaomoji-english-tutor.db`，删除该文件即清空学习记录

---

<a id="en"></a>

## English

A kaomoji pet that lives in a widget below the editor and teaches you English based on your conversation topic — fully automatic, no commands needed.

### How it works

- **Auto-triggered**: the pet acts every N conversation turns (default 3)
- **Topic-based lessons**: it picks the topic from your recent conversation and automatically prepares a lesson — 1 word, 1 phrase, 1 sentence — shown one by one in the following turns
- **Spaced repetition**: items are scheduled with [FSRS](https://github.com/open-spaced-repetition/fsrs.js) (the algorithm behind Anki); due reviews come first, intervals grow automatically (~1d → 2d → 4d → …)
- **Persistent**: learning history lives in SQLite (`~/.pi/agent/kaomoji-english-tutor.db`, WAL mode), accumulated across sessions; daily new-item cap defaults to 3
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

### Configuration

Create `~/.pi/agent/kaomoji-english-tutor.json` (global) or `.pi/kaomoji-english-tutor.json` (project override). All fields optional:

| Setting | Default | Description |
| --------- | --------- | ------------- |
| `provider` | *(auto-detect)* | Lesson model provider |
| `model` | *(auto-detect)* | Lesson model ID |
| `thinkingLevel` | *(provider default)* | Reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `debounceTurns` | `3` | Pet acts every N conversation turns |
| `dailyNewLimit` | `3` | Max new items taught per day |
| `maxTokens` | `600` | Max tokens for lesson generation |
| `showWidget` | `true` | Show the pet widget |
| `verbose` | `false` | Notify whenever a new item is taught |

### Notes

- Without explicit config, the pet automatically picks a suitable model for lessons (e.g. gpt-5.4-mini, deepseek-v4-flash, grok-4.3, glm-5.2), only from providers with configured auth (logged in or API key present)
- If the chosen model is unreachable (missing key, network or provider errors), it falls back to the model driving the current session and retries
- Reviews are display-based (the pet shows the card and advances FSRS with a Good rating); the data model keeps a rating hook for future interactivity
- Learning data lives in `~/.pi/agent/kaomoji-english-tutor.db`; delete it to wipe all progress
