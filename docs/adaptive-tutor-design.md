# 自适应 LLM 英语导师正式设计

> 状态：Accepted for implementation<br>
> 范围：`kaomoji-english-tutor` 下一代备课、练习与反馈机制<br>
> 优先级：教学效果 > LLM 调用成本；交互延迟、数据一致性与可恢复性仍是硬约束

## 1. 摘要

当前扩展已经具备可靠的时间触发、FSRS 调度、渐进长句、SQLite 持久化和多会话一致性，但 LLM 主要承担一次性内容生成，系统只能观察 Good、Again、Skip，无法根据用户的真实作答诊断问题。

新设计把系统分成两个边界清晰的部分：

- **LLM 导师层**：分析学习状态，选择教学目标，生成多个候选课程，进行语言与教学审查，评价真实答案，诊断错误并生成强化练习。
- **确定性学习引擎**：维护 FSRS、每日额度、SQLite 事务、精确去重、全局卡槽、租约、版本 CAS 和多会话同步。

核心变化是：

1. 从“固定生成单词、词组、长句”升级为“按学习价值选择 `wait | new | reinforce | contrast | transfer`”。
2. 以**具体义项**而不是拼写作为学习对象。
3. 新课形成一个紧密关联的教学单元；目标词、词组、例句、长句和练习共同服务同一个教学目标。
4. 新增 `/kaomoji:answer <答案>`，收集不进入会话历史的真实英文或中文答案，并自动映射为 FSRS Good/Again。
5. 复习从被动识别逐步升级为填空、主动产出和迁移使用。
6. 使用多候选、多审查、有限修订的 LLM 流水线；质量门不通过时宁可不新增内容。
7. LLM 只提供判题 verdict，永不直接写 FSRS；确定性引擎在 item/version/direction CAS 成功后把 correct 映射为 Good、partial/incorrect 映射为 Again，用户仍可手动执行 Good、Again 或 Skip。

## 2. 背景与问题

### 2.1 当前能力

现有实现提供：

- 最近会话主题提取与 readiness 判断；
- 每轮一个单词、一个词组、一个渐进长句；
- 句子 L1 → L2 → L3 训练；
- FSRS Good/Again 与 Skip 补卡；
- 单一全局当前卡、跨进程版本 CAS、coordinator 和 generation lease；
- LLM 调用期间不持有 SQLite 事务；
- Widget 常驻展示及 `/kaomoji:*` 命令交互。

### 2.2 教学瓶颈

1. **教学项关联不足**：三个核心学习项只要求主题相关，不保证目标词和词组自然出现在长句中。
2. **重复判断不一致**：主备课依赖最近内容的软提示，配套词和补卡采用不同的数据库精确判断。
3. **缺少义项模型**：同词不同义可以被插入，但系统不能明确说明它与已有义项的差别。
4. **练习偏识别**：看到英文后回忆中文，主动产出和迁移不足。
5. **反馈信号过弱**：只有用户自报 Good/Again，不知道错误来自词义、词形、搭配、语法还是提取失败。
6. **LLM 缺少闭环**：历史错误和掌握维度没有进入下一次教学规划。
7. **新增额度不严格**：配套生词可能让实际首次展示数量超过 `dailyNewLimit`。

## 3. 设计目标

### 3.1 必须实现

- 围绕当前工作主题提供自然、正确、可迁移的英语学习内容。
- 同一个拼写可以有多个明确区分的义项；同词同义不得重复建卡。
- 每个新教学单元有明确目标，并能解释为什么现在值得学习。
- 复习至少覆盖识别、受控回忆、主动产出和迁移四种能力。
- 收集真实答案并提供及时、具体、可执行的反馈。
- 连续 Again 后生成新的解释、对比或语境练习，而不是复制卡片。
- 渐进句子在任意 L1/L2/L3 阶段一次 Again 即完成 FSRS Again、结束当前卡并把下次训练重置到 L1；不得要求逐级连按 Again。
- 保留 FSRS 和显式评分语义。
- 保留全局单一卡槽和跨会话“至多一次”行为。
- 所有 LLM 结果必须经过结构、确定性约束和语义质量门后才能持久化。
- 任何模型失败、过期结果或进程退出都不得破坏当前卡和学习记录。

### 3.2 非目标

- 不修改 Pi 核心。
- 不恢复 keyboard review panel 或全局快捷键。
- 不让 LLM 决定 SQLite 事务、FSRS 到期时间或评分是否生效。
- 不把扩展变成通用聊天机器人或完整考试认证系统。
- 第一阶段不加入语音识别、发音评分或多人学习账户。
- 不要求用户每次都输入答案；Good/Again 保留为低摩擦、自评兜底。

## 4. 设计原则

1. **先提取，后解释**：复习正面应尽量要求回忆，答案和解释在提交或翻面后出现。
2. **一个教学目标，多种语境**：同一义项通过不同练习验证，而不是重复同一句话。
3. **义项优先**：卡片身份是“词/词组 + 具体含义 + 用法”，不是裸字符串。
4. **难度渐进**：新授 → 识别 → 填空 → 产出 → 迁移；失败时降低支架而非直接更换目标。
5. **反馈具体**：指出正确之处、最小错误、自然表达和义项差别，避免只给分数。
6. **LLM 做语义判断，代码做硬约束**：模型负责自然度和教学价值，代码负责事实状态和并发安全。
7. **质量失败时等待**：没有合格内容比插入勉强、重复或错误的课程更好。
8. **调用成本不作为削减质量流程的理由**：可以并行生成和独立审查；仍限制无界重试。
9. **不阻塞正常工作**：备课和强化尽量异步预生成；当前卡始终可以继续翻面或自评。

### 4.1 证据基础

本设计采用以下有较强证据支持的方向；具体交互与阈值仍属于需要实测的工程判断：

- **主动提取优于重复阅读**：practice testing 和 productive recall 对长期保持及迁移有稳定收益，因此复习应从识别逐步转为填空和主动产出。[Karpicke & Roediger, 2007](https://learninglab.psych.purdue.edu/downloads/2007/2007_Karpicke_Roediger_JEPLMC.pdf)，[Retrieval-Based Learning: A Decade of Progress](https://files.eric.ed.gov/fulltext/ED599273.pdf)
- **间隔练习优于集中练习**：已有 FSRS 继续负责出现时机，不由 LLM 临时改写间隔。[Cepeda et al., 2006](https://pubmed.ncbi.nlm.nih.gov/16719566/)，[L2 spacing meta-analysis](https://onlinelibrary.wiley.com/doi/abs/10.1111/lang.12479)
- **明确纠正反馈有效**：反馈应给出正确形式和最小解释，而不是模糊 recast；“在本工具中默认立即反馈”是基于低摩擦自学场景的工程判断，并非这些研究证明所有情境都应立即反馈。[Li, 2010](https://eric.ed.gov/?id=EJ883422)，[Ellis, Loewen & Erlam](https://www.cambridge.org/core/journals/studies-in-second-language-acquisition/article/implicit-and-explicit-corrective-feedback-and-the-acquisition-of-l2-grammar/CDE67D4A4E286921DA4BE9C40BAD9FE6)
- **词汇掌握是多维的**：至少区分 form/meaning/use 以及 receptive/productive，不能只维护一个“认识”布尔值。[Nation, *Knowing a Word*](https://www.cambridge.org/core/books/learning-vocabulary-in-another-language/knowing-a-word/A663820BEC148D495A5B5B56E923CE3C37)
- **LLM 错误反馈可能伤害学习**：现有直接证据来自数学 tutoring，而不是 L2 词汇；本设计把该风险保守外推到语言反馈，因此要求模型评价锚定已审查的答案、accepted variants 和 rubric，不确定时返回 `cannot_judge`。[Steinbach et al., 2025](https://zenodo.org/records/15870127)

## 5. 用户体验

### 5.1 新授

首次展示仍用于理解，不要求立即闭卷产出：

```text
(=^･ω･^=) 新义项：coordinate /koʊˈɔːrdɪneɪt/
  释义：协调多个参与者或任务，使其共同工作
  搭配：coordinate access to shared state
  场景：多个 Pi 会话需要安全共享学习状态
💬 /kaomoji:flip 查看例句 · /kaomoji:skip 已会
```

翻面后展示：

- 简洁释义和义项边界；
- 与已有义项或易混词的区别；
- 一个短例句；
- 本教学单元中的完整长句。

### 5.2 主动回忆

到期复习根据当前掌握阶段选择练习。例如填空：

```text
(=^‥^=) 主动回忆 · 填空
  We need to ___ access to shared state across several sessions.
  提示：协调
💬 /kaomoji:answer <答案> · /kaomoji:hint · /kaomoji:flip
```

用户输入：

```text
/kaomoji:answer coordinate
```

命令不进入 Pi 会话历史。正确答案可立即由确定性规则确认；自由表达或非精确答案进入 LLM 评价流程。

### 5.3 反馈

```text
(=^･ω･^=) 回答正确
  你的答案：coordinate
  完整句：We need to coordinate access to shared state across several sessions.
  要点：coordinate 后直接接需要协调的对象。
💬 /kaomoji:good 记得 · /kaomoji:again 仍不稳
```

部分正确时：

```text
(=；ω；=) 意思接近，但这里需要动词原形 coordinate
  你的答案：coordination
  更自然：coordinate
  原因：need to 后接动词原形；coordination 是名词。
💬 /kaomoji:good 我已掌握 · /kaomoji:again 需要再练
```

### 5.4 命令契约

新增：

| 命令 | 行为 |
| --- | --- |
| `/kaomoji:answer <text>` | 提交当前双向练习答案；correct 自动 FSRS Good，partial/incorrect 自动 Again |
| `/kaomoji:hint` | 逐级显示预生成提示，并记录本次回答的辅助程度 |
| `/kaomoji:report <reason>` | 报告错误/不自然内容，将当前 exercise 置为 quarantined 并触发独立复审；不修改 FSRS |
| `/kaomoji:forget-attempts <all\|days>` | 删除原始答案历史，保留 FSRS 与不可逆推出原文的聚合计数 |
| `/kaomoji:context <off\|summary\|conversation>` | 明确选择可发送给 tutor 模型的会话范围；新协议默认 off |
| `/kaomoji:repair-fsrs <itemId> reset` | 仅在明确输入 `reset` 时归档损坏 blob 并把该 item 作为新卡重置；默认建议从数据库备份恢复 |

保留：

| 命令 | 行为 |
| --- | --- |
| `/kaomoji:flip` | 本地翻面；完整揭示答案，本次答题标记为已揭示 |
| `/kaomoji:good` | 用户明确确认记得；全局至多一次地更新进度或 FSRS |
| `/kaomoji:again` | 用户明确确认不稳；全局至多一次地退级或更新 FSRS |
| `/kaomoji:skip` | 标记很熟并保留一对一补卡义务 |

直接 Good/Again 仍可用，但记录为 `self_report`，没有真实答案评价。`/answer` 的 LLM 只返回 verdict；确定性引擎在 CAS 成功后将 correct 自动映射为 Good、partial/incorrect 自动映射为 Again。

### 5.5 Exercise 与交互状态契约

`exercise.kind` 是判别联合而不是任意 JSON：

| kind | 正面 | 答案与评价 |
| --- | --- | --- |
| `recognition` | 英文形式和语境 | 输入/翻面确认目标中文义项；允许自评 |
| `cloze` | 只有一个目标空格的英文句子 + 中文提示 | 英文词/词组；本地 accepted forms 优先 |
| `production` | 中文意图或开发场景 + 必须表达的约束 | 英文短语/句子；按 rubric 评价语义、词形和搭配 |
| `transfer` | 未见过的新场景 | 自由英文；必须命中目标义项，用法可多样 |
| `contrast` | 两个义项/易混表达的最小对比语境 | 选择或产出合适表达，并解释最小差异 |

第一版判别 schema：

```ts
type CriterionV1 = {
  id: string;
  dimension: "meaning" | "form" | "collocation" | "grammar" | "naturalness";
  required: boolean;
  anchor: string;
};

type ExerciseV1 = {
  schemaVersion: 1;
  targetSenseRefs: string[]; // plan 内逻辑 ref；提交事务解析为 lexical_sense_id
  hints: [string, string];
  rubric: { criteria: CriterionV1[] };
} & (
  | { kind: "recognition"; prompt: { surface: string; context?: string }; answer: { acceptedMeaningZh: string[] } }
  | { kind: "cloze"; prompt: { before: string; after: string; meaningHintZh: string }; answer: { acceptedForms: string[] } }
  | { kind: "production"; prompt: { intentZh: string; scenario: string; constraints: string[] }; answer: { referenceAnswers: string[] } }
  | { kind: "transfer"; prompt: { unseenScenario: string; constraints: string[] }; answer: { referenceAnswers: string[] } }
  | { kind: "contrast"; prompt: { contexts: [string, string]; comparedSenseRefs: [string, string] }; answer: { expectedByContext: [string[], string[]] } }
);
```

validator 要求 target sense 存在、每题只有一个主目标、cloze 只有一个空位且 acceptedForms 非空、constraint 与 criterion IDs 可追溯、contrast 的两个 sense 不同、第一层 hint 不含完整 accepted answer、所有字符串满足字段长度和控制字符限制。一次 Widget 只显示一个问题，2–4 个预生成练习是未来轮换库，不会同时展示。

行为规则：

- 空白 `/answer` 只显示用法，不建立 attempt；
- `question`/`feedback` 阶段可以 answer；`evaluating` 阶段重复 answer 只提示已有评价进行中；
- feedback 后重答会建立新版本 attempt，旧 attempt 保留；
- hint 只逐级增加本地 assistance；评价进行中不改变已提交 attempt 的 assistance；
- flip 立即标记本地 `revealed` 并显示完整答案；之后提交属于 assisted；
- evaluating 时仍允许显式 Good/Again/Skip，它会推进全局版本并使评价结果 stale；
- `/report` 在短事务中 quarantine 当前 exercise、增加 active version，并切换到另一条已审查练习或清空卡槽等待修复。

## 6. 教学模型

### 6.1 教学对象

主要对象是 `lexical sense`：

- 类型：word 或 phrase；
- 规范化形式；
- 词性；
- 精确中文释义；
- 英文用法说明；
- 典型搭配；
- 与已有义项的关系。

必须区分：

- **可调度 item**：拥有独立 FSRS 状态、代表一个值得单独复习的目标；
- **supporting material/exercise**：例句、搭配、渐进长句和对比材料，用于练习某个 item，本身不自动成为新卡。

因此一节课可以生成 1–3 个可调度 item，但不再为了凑固定结构把每个单词、词组和长句都变成卡片。每个新 lexical item 都必须带自然搭配和对应的渐进长句；只有规划器认定某个词组或长句本身也是独立学习目标时，它才获得自己的 item 和 FSRS 状态。这样剩余额度为 1 时仍可交付完整教学单元，而不是交付残缺批次。

### 6.2 掌握阶段

每个学习项维护独立于 FSRS 的练习阶段：

1. `exposure`：理解形式、意义和语境；
2. `recognition`：从英文识别目标义项；
3. `controlled_recall`：在例句中填入目标词或词组；
4. `production`：根据中文或场景主动表达；
5. `transfer`：在新语境中选择或生成自然表达。

`contrast` 是覆盖在 base stage 上的临时 exercise mode，不是第六个永久等级；完成后回到原 base stage。

同时分别累计 `recognition`、`recall`、`use` 和 `transfer` 四个 facet 的证据，避免用一个阶段掩盖“认得但不会用”。`stage` 只表示下一次优先练习方向，不是单一总分。

FSRS 决定**何时出现**；掌握阶段和 facet 证据决定**出现时练什么**。

阶段变化由代码按下表执行，LLM 不返回“下一阶段”：

| 最近行为 | FSRS | facet/mastery | 下一练习 |
| --- | --- | --- | --- |
| `correct`、无提示、随后 Good | 按 Good | 对应 facet +1，清零 consecutive Again | 达到阈值时升阶 |
| `correct` 但使用 hint/flip、随后 Good | 按 Good | 只增加 assisted，不增加升阶证据 | 保持当前阶或更换同阶语境 |
| `partial/incorrect` 后仍 Good | 尊重用户，按 Good | 记录 override，不增加 facet | 保持当前阶 |
| 无 answer 直接 Good | 按 Good | 记录 self-report；最多推进 exposure→recognition | 不得据此进入 production/transfer |
| Again | 按 Again | consecutive Again +1，清除当前成功 streak | 降低一级支架；连续 2 次触发强化 |
| `cannot_judge` | 等待显式评分 | 不增加 facet | 允许重答、翻面或自评 |
| stale/abandoned attempt | 不变 | 不变 | 以当前全局状态为准 |
| Skip | 按现有 Easy+365 天语义 | 标记 mastered | 建立 replacement request |

每次 item 从 inactive 被 claim 时创建 `review_cycle_id`；该卡在 question、重答、feedback 到最终显式评分期间共享同一 cycle。每个 facet 每个 cycle 最多增加一次证据，因此同一轮反复重答不能冒充“不同 scheduled reviews”。

默认阈值：exposure 经一次显式 Good 进入 recognition；recognition 一次无提示成功进入 controlled recall；controlled recall 和 production 各需在不同 review cycles 累计两次无提示正确+Good 才升阶；transfer 达标后继续轮换语境而不再制造更高虚拟等级。`recognition/controlled_recall/production/transfer` 分别给对应 facet 增加证据。

Again 的确定性降阶为：exposure/recognition → recognition，controlled recall → recognition，production → controlled recall，transfer → production。assisted success、partial/incorrect 后 Good 都会清零当前阶段的 unassisted streak；`cannot_judge` 不改变 streak；Skip 结束 stage 选择。wrong-sense 错误或新建 distinct sense 设置 `contrast_pending=1`；一次无提示 contrast 正确+Good 才清除并回到 base stage，Again 保持 contrast pending 且按上表降低 base stage。contrast evidence 同时关联两个 sense，但每个 review cycle 仍只计一次。

现有 progressive sentence 的 L1/L2/L3 progress 仍保持专门状态机：中间级 Good 只升一级，完整级 Good 才进入 FSRS；任意级别 Again 都在一个 CAS 事务中立即执行一次 FSRS Again、把 progress 重置为 L1 并释放全局卡槽。一次命令只能计一次 review，不能逐级退回或要求连续点击。Good 的中间级切换增加 active version，但不伪造新的 scheduled review cycle。提示或翻面后的成功统一记为 assisted。

### 6.3 教学规划模式

规划器每次只能选择一个主模式：

| 模式 | 用途 | 是否新建卡 |
| --- | --- | --- |
| `wait` | 上下文或教学价值不足 | 否 |
| `new` | 当前主题中存在值得学习的新义项/表达 | 是，1–剩余额度 |
| `reinforce` | 已学内容薄弱，需要新解释或新练习 | 否 |
| `contrast` | 新义项与已有义项/易混词需要对比 | 可能，新义项才建卡 |
| `transfer` | 已掌握内容需要迁移到新场景 | 否 |

`dailyNewLimit` 是**计划新课首次展示数量上限**，不是一次 LLM 批次门槛。规划器可以少教，不得为填满额度硬凑。Skip replacement 维持现有“一换一、额度外”语义，单独标记和统计，不伪装成计划新课额度内项目。

额度执行分成两层：

- `items.introduced_at` 记录真正第一次展示的时间，`introduction_kind` 为 `planned | replacement | legacy`；`learned_at` 继续表示内容创建时间；
- scheduler 分开查询已展示 due review 与 `shown=0` 的 queued-new；计划新卡 claim 检查今日 `introduced_at AND introduction_kind='planned'` 数量；replacement 不占 planned quota，但成为 queued-new 后优先于普通新课展示；
- 数据库存在 queued-new 时不再提交另一节新课，避免隐藏卡绕过额度；
- 一个 ready lesson 只有在 `schedulableItems.length <= remainingSlots` 时才能原子提交，否则保持 ready 到下一可用日期或重新规划为更小单元；`remainingSlots = dailyNewLimit - introducedToday`，且同一 `BEGIN IMMEDIATE` 内必须再次确认 queued-new 数量为 0；
- claim queued-new 时在同一事务设置 `shown=1`、`introduced_at=now` 和 active slot，并在此时更新 streak/首次学习统计；内容创建本身不算“已学”；任何会话都不能绕过这一步。

迁移无法恢复旧卡真实首次展示时间：旧 `shown=1` 行以 `learned_at` 近似回填、标记 `introduction_kind='legacy'` 和 `introduction_accuracy='approximate'`；旧 `shown=0` 行保持 NULL 并优先进入 queued-new。protocol 2 在下一个本地自然日才启用精确 planned quota，激活当日继续沿用旧统计且不提交新的 V2 lesson，避免近似值影响新额度。从生效日起所有 claim 都精确写 introduced_at。句子中的普通生词默认只作为提示，不自动建卡。只有规划器明确认为其独立教学价值高、且仍有新卡额度时，才成为核心卡；默认最多一个。

## 7. LLM 导师流水线

### 7.1 总览

```text
会话 + 学习历史
       │
       ▼
确定性快照构建
       │
       ▼
学习者诊断 ──► 教学规划
                    │
                    ▼
             并行候选生成 × N
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
       语言审查   教学审查   新颖性/义项审查
          └─────────┼─────────┘
                    ▼
               综合修订
                    │
                    ▼
          确定性验证 + CAS 提交
```

推荐默认候选数为 3，最多修订 2 轮。限制轮数是为了可恢复性，不是节省费用。

### 7.2 输入快照

代码构建带版本和哈希的 `TutorSnapshot`：

- 来源 session/branch、最后一个纳入条目的稳定 cursor/fingerprint；
- 最近有效会话内容；
- 今日剩余新卡额度；
- 最近学习项和相关义项；
- 同拼写已有义项；
- Due/Again/Skip、连续成功和提示使用情况；
- 各掌握阶段的薄弱项；
- 最近句型和主题，避免机械重复；
- 当前配置、模型角色和难度目标。

会话文本必须标记为不可信数据。任何其中出现的“忽略规则”“输出其他格式”等内容不得成为模型指令。

相关性规则必须可执行：原 branch 不再包含 anchor、项目/主题被明确否定或目标已被插入时标记 stale；只有新消息追加时保留 job，并在 finalize 阶段让独立 relevance judge 在 `still_relevant | defer | stale` 中选择。`defer` 保存 ready artifact 等待合适时机，不重新生成。该规则替代当前对 conversation 字符串完全相等的要求。

不默认把完整原始会话或完整答案历史持久化到 LLM 日志；只持久化结构化快照、哈希和必要诊断。

### 7.3 学习者诊断

诊断调用输出：

- 估计难度区间，而不是伪精确的 CEFR 结论；
- 当前稳定掌握、薄弱和未观察维度；
- 最近错误类别；
- 推荐支架程度；
- 可能值得复用的真实工作场景。

该结果是建议性快照，不能直接改变 FSRS 或数据库事实。

### 7.4 教学规划

规划器输出严格 JSON：

```json
{
  "mode": "new",
  "objective": "在多会话状态同步语境中主动使用 coordinate",
  "reason": "当前会话反复讨论跨进程协调，且数据库中没有该义项",
  "target": {
    "kind": "word",
    "surface": "coordinate",
    "partOfSpeech": "verb",
    "meaningZh": "协调多个参与者或任务，使其共同工作"
  },
  "relationToExisting": "new_lexeme",
  "schedulableTargets": ["target_word"],
  "supportingRoles": ["collocation", "progressive_sentence"],
  "exerciseStages": ["controlled_recall", "production"]
}
```

规划器不得直接生成 SQL、FSRS 参数或事务动作。

### 7.5 候选生成

每个候选必须明确区分 `schedulableItems` 与 `supportingMaterials`，并提供：

- 目标义项及边界；
- 自然搭配或词组；
- 短例句与中文翻译；
- 至少 15 词的渐进长句；
- 长句 L1/L2/L3、逐级翻译和意群；
- 目标词及目标词组在长句中的实际表面形式；
- 2–4 个练习，覆盖规划要求的阶段；
- 分级提示、可接受答案和评价 rubric；
- 若为同词新义，提供与旧义项的最小对比例句。

对于 `new` 教学单元，所有本课 lexical targets 及规划器选定的核心搭配必须自然出现在 supporting progressive sentence 中，并服务同一个语义目标。不能为了字符串命中制造不自然句子；supporting sentence 只有在自身也是独立表达目标时才成为可调度 sentence item。

实现时新增版本化 `LessonPlanV2` 契约，明确包含 `schedulableItems[]`、`supportingMaterials[]` 和 `exercises[]`，不再复用当前“恰好三个不同 type 的 `GeneratedItem[]`”解析器。只有 `schedulableItems` 写入 `items` 和占用额度；supporting material 写入 lesson/exercise。旧契约只用于读取已有卡和迁移期 fallback，不得与 V2 混合插入。

确定性认知负担上限：每个 exercise 只测试一个主目标；新课默认最多 1 个新义项和 1 个核心搭配；额外未知词最多 2 个且必须提供提示；渐进长句默认 15–25 词、上限 30 词（明确 advanced 规划才可放宽）；每级只增加一个主要意群；一次 Widget 只显示一个 prompt，反馈优先给一个最小修正和一个理由。终端继续完整换行，不通过截断隐藏教学内容。

### 7.6 独立审查

至少运行三类审查：

1. **语言审查**
   - 语法、搭配、自然度、词性和音标；
   - 中英文是否准确对应；
   - 目标词在句中是否表达目标义项。

2. **教学审查**
   - 难度是否渐进；
   - 正面是否泄露答案；
   - 提示是否从弱到强；
   - 练习是否真正测试目标，而非无关记忆；
   - 认知负担是否与用户状态匹配。

3. **新颖性/义项审查**
   - 与已有卡是同义重复、明显不同义项还是不确定；
   - 是否复用了近期句型；
   - `contrast` 是否真的能区分义项。

所有 critic 使用统一、可机器验证的契约：

```json
{
  "verdict": "pass | fail | uncertain",
  "violations": [{
    "code": "TARGET_SENSE_MISMATCH",
    "severity": "blocker | warning",
    "fieldPath": "supportingMaterials[0].sentence",
    "evidence": "具体冲突片段",
    "repair": "最小修订要求"
  }]
}
```

义项审查另使用 `SenseJudgeV1 { schemaVersion, verdict: same_sense | distinct_sense | uncertain, comparedSenseId, criterionResults[], evidence[] }`。只有两个独立 judge 都返回 `same_sense` 且指向同一个 existing sense 才复用；只有两者都返回 `distinct_sense`、reference anchor 已确认且 criterionResults 无 unknown 才允许新义项；其他组合一律归为 uncertain。

答案审查使用 `AnswerJudgeV1 { schemaVersion, semanticVerdict, criterionResults: [{ criterionId, result: pass | fail | unknown, evidence }], correctionFromAnchor }`。自由答案默认运行 2 个 semantic 和 2 个 grammar/collocation judges：

| semantic quorum | grammar quorum | 最终 verdict |
| --- | --- | --- |
| 两者 correct | 所有 required criteria pass | correct |
| 两者 correct | required criterion fail | partial |
| 两者 partial，且 criterion IDs 一致 | 无 unknown/冲突 | partial |
| 两者 incorrect，且失败 target criterion 一致 | 任意一致结果 | incorrect |
| 任一 conflict、unknown、不同 criterion 归因 | 任意 | cannot_judge |

grammar/collocation judge 只能评价 rubric 中已有 criterion，不能新增答案标准。反馈综合器严格应用该表，没有投票权。

不能只依赖总分。阻断问题包括事实错误、目标义项不符、重复内容、答案不唯一却无 rubric、翻译错误或不自然的强行关联。第一版默认运行 2 个独立 linguistic critics、2 个 pedagogy critics 和 2 个 novelty/sense judges；确定性验证必须全部通过，每类 critic 都必须一致 `pass` 且无 blocker。任何冲突或 `uncertain` 都进入修订，达到上限后放弃，不以多数票掩盖语义风险。

critic 优先使用与 generator 不同、且彼此不同的已认证提供商；模型不足时允许同一强模型的独立上下文，但质量记录必须标记 `single_model_ensemble`，后续指标单独观察。固定 fixture 为每个 violation code 给出应通过/应阻断结果，契约测试不能只断言“模型打分较高”。

没有单个 LLM 调用是语义权威。`ReferenceResolver` 使用非生成式来源核对 target anchor：普通单词优先本地 WordNet/词典 adapter 的 lemma、词性和英文 sense；中文释义使用可审计双语词典 adapter；词组和技术表达使用可信 corpus/search adapter 返回的原文片段与 URL。引用内容必须由代码实际获取并保存 source id/hash，不能接受模型自报来源。

至少一个独立 reference 必须支持 target form/sense，且两个独立 linguistic judges 不得发现冲突，内容才可成为 `approved` answer anchor。没有 reference 的候选标记 `pending_unverified`，不进入 items/exercises、不展示；job 可以换候选或等待 reference provider 恢复。跨模型共识本身不能把 `pending_unverified` 升为 approved。支持句子的整体风格仍由 critics 判断，但其 canonical target 必须已经有 reference anchor。

最终写入的是经过确定性验证、独立参考证据和多路一致审查的**暂定教学内容**，不是不可纠正的词典事实；用户可以报告问题，冲突内容必须 quarantine 并重新审查。评价器只能根据该暂定 anchor 判断本次练习，不能把自己临时生成的新知识反写为 canonical answer。

### 7.7 修订与提交

综合器只接收已清理的结构化审查意见。每轮修订后重新执行确定性验证；仍有阻断问题则再次审查，超过上限后将 job 标记失败，本轮不新增内容。

诊断、规划、候选、审查和修订结果按阶段写入 `tutor_jobs`。每个 LLM 调用都在事务外执行；阶段边界以 job token CAS 保存，因此 reload 或进程崩溃后可以从最近完成阶段恢复。

最终提交前必须重新检查：

- job snapshot 与当前学习状态仍相关；后续会话只是追加内容时不自动作废，主题明显切换、目标已失去价值或依赖事实改变时才延后/stale；
- job lease 仍属于本实例且未过期；
- 全局卡槽仍为空；
- 没有更高优先级 due 卡；
- 剩余新卡额度足够；
- 当前存在可执行的队首 replacement 时没有被普通新课绕过；deferred replacement 不永久阻塞普通新课；
- 内容 fingerprint 尚不存在；
- 相关义项没有在生成期间被其他实例插入。

质量合格但暂时被 due 卡、active slot 或额度阻挡的 job 保持 `ready`，由后续 coordinator 重新校验后提交，不需要重新调用 LLM。所有课程、义项、卡片和练习在一个短 `BEGIN IMMEDIATE` 事务中提交。

## 8. 答案评价与反馈闭环

### 8.1 提交协议

`/kaomoji:answer` 使用与评分相同强度的原子 CAS：

1. 空答案在事务前拒绝，不建立 attempt；
2. `BEGIN IMMEDIATE` 后读取 active item、exercise、phase 和 `active_version`；
3. 仅当 phase 为 `question | feedback`、item/exercise 与本地投影一致，且没有 `evaluating` attempt 时，插入带唯一 `claim_key = item:exercise:questionVersion` 的 attempt；feedback 阶段的上一条 terminal attempt 可保留用于渲染，并在同一事务标记为 superseded；
4. 同一事务把 `runtime_state.active_phase` 改为 `evaluating`、写入 `active_attempt_id`，并把 `active_version` 加一；
5. 提交后在事务外运行评价；
6. 评价完成时再次 `BEGIN IMMEDIATE`，只有 attempt token、active item/exercise/attempt、phase 和 evaluating version 全部匹配，才写入 feedback、切换 phase 并再次增加版本；
7. 若当前卡已被其他会话评分、重试或替换，当前实现直接丢弃过期评价且零写入；不得写 attempt、Widget、mastery 或调度。未来若增加独立审计流，也只能写非权威 stale 记录。

`questionVersion` 明确定义为 answer claim 事务开始时、phase 仍为 question/feedback 的 `runtime_state.active_version`；`evaluationVersion = questionVersion + 1`，即步骤 4 提交后的版本。feedback 后重答先获得新的 active version，因此生成新的 claim key，不与旧 attempt 冲突。

`attempts(claim_key)` 使用唯一索引作为第二道保护。`BEGIN IMMEDIATE` 使两个会话不能同时通过 phase 检查；唯一索引防止未来代码路径绕过该约束。其他会话同步显示“正在评价”；租约过期后，恢复事务先把旧 attempt 标记 `abandoned` 并增加 active version，再允许新 claim。

### 8.2 评价策略

- 精确填空首先使用本地 accepted answers、大小写和允许词形规则判断。
- 完全匹配可以即时展示预生成反馈，避免无意义等待。
- 非精确填空、翻译、造句和迁移答案进入 2 个独立语义 judges 和 2 个语法/搭配 judges，并严格使用 §7.6 truth table；任何 quorum 冲突都直接为 `cannot_judge`。
- 反馈综合器只把已达成一致的 verdict 和具体 evidence 转成：`correct | partial | incorrect | cannot_judge`、最小修改、解释、自然表达和错误标签；它不能改变 verdict。
- `cannot_judge` 不得被当作错误；允许用户翻面、自评或重新提交。

经多轮生成和审查后写入的 `answer_json`、accepted variants 与 rubric 是评价锚点。LLM 可以解释语义等价和自然度，但不能脱离这些锚点发明新的语法规则、词义或唯一答案。两个 evaluator 冲突、证据不足或 rubric 未覆盖时必须降级为 `cannot_judge`。

错误标签至少包括：

- `retrieval_failure`
- `wrong_sense`
- `word_form`
- `collocation`
- `grammar`
- `word_order`
- `unnatural_expression`
- `translation_drift`
- `assisted_success`

### 8.3 评分边界

评价结果只形成推荐：

- correct → 推荐 Good；
- partial → 推荐用户按主观稳定程度决定；
- incorrect → 推荐 Again。

只有用户执行 `/kaomoji:good`、`/kaomoji:again` 或 `/kaomoji:skip` 才修改 FSRS、句子进度和统计。评分事务同时把显式 rating 关联到最近 attempt；直接评分则创建 `self_report` 记录。

### 8.4 强化生成

达到任一条件时异步准备强化内容：

- 同一项连续两次 Again；
- 同一错误标签重复出现；
- 同词不同义混淆；
- production/transfer 长期没有无提示成功。

强化器生成新的解释、对比例句和练习，挂到原 item，不创建新的 FSRS 卡，也不消耗新卡额度。强化结果同样经过语言和教学审查。

### 8.5 内容报告与隔离

`/kaomoji:report` 在短事务中写入 report、把 exercise 设为 `quarantined` 并增加 active version。若问题指向 canonical sense/translation，而不只是单个 prompt，则把 item 的 `content_status` 设为 `under_review`，在复审完成前只保留 FSRS 数据、不再展示该内容。随后建立独立 `content_review` tutor job，由未参与原生成的 critics 复查；通过后产生新 content version，失败则继续隔离。报告、隔离和修复均不把卡视为 Good/Again，也不删除历史 attempt。

## 9. 数据模型

采用向后兼容、只增不删的迁移。现有 `items.fsrs_state`、`due_at`、`reviews`、`progress` 和 `runtime_state.active_version` 语义不变。首先引入 `schema_meta(schema_version, adaptive_protocol, migration_state)`、追加式 `schema_migrations` 和带过期心跳的 `runtime_clients(client_id, protocol_version, last_seen)`；每个版本在一个短事务内幂等迁移，不再依赖吞掉所有 `ALTER TABLE` 错误来判断迁移是否完成。

FSRS 继续使用现有默认参数，迁移和新练习不得重置、重算或静默修复既有 `fsrs_state`。空字符串仍是合法“尚未进入 FSRS”状态；只有非空 JSON 解析/字段恢复失败才是 corruption。检测后在短事务写入 `fsrs_status='corrupt'`、错误码和时间，原 blob 原样保留；scheduler 跳过该 item 并显示一次可诊断通知。没有自动 reset；后续只能从备份恢复，或由用户通过明确的 repair/reset 流程接受历史丢失。

### 9.1 `lessons`

```sql
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  topic TEXT,
  objective TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  quality_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

保存教学决策和可审计质量结果，不默认保存完整原始会话。

### 9.2 `lexical_senses`

```sql
CREATE TABLE lexical_senses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('word', 'phrase')),
  surface TEXT NOT NULL,
  normalized_surface TEXT NOT NULL,
  part_of_speech TEXT,
  meaning_zh TEXT NOT NULL,
  normalized_meaning TEXT NOT NULL,
  usage_note TEXT,
  sense_fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX lexical_senses_surface_idx
  ON lexical_senses(kind, normalized_surface);
```

`sense_fingerprint` 对 **kind + 规范化形式 + 词性 + 规范化释义** 做确定性哈希，防止精确重复；语义近似重复由共识审查拦截。同词不同义具有不同 fingerprint，并自动生成 contrast 练习。

另建 `lexical_surface_versions(kind, normalized_surface, version)`。任何该 surface 的义项插入都会在同一事务增加 version。novelty job 记录审查时的 surface version；最终插入事务只在 version 未变化时提交，否则回到 novelty 审查，避免 LLM 调用和提交之间出现语义竞态。

### 9.3 扩展 `items`

新增可空列，保证旧数据可继续运行：

```sql
ALTER TABLE items ADD COLUMN lesson_id INTEGER;
ALTER TABLE items ADD COLUMN lexical_sense_id INTEGER;
ALTER TABLE items ADD COLUMN role TEXT;
ALTER TABLE items ADD COLUMN content_fingerprint TEXT;
ALTER TABLE items ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE items ADD COLUMN introduced_at TEXT;
ALTER TABLE items ADD COLUMN introduction_kind TEXT;
ALTER TABLE items ADD COLUMN introduction_accuracy TEXT NOT NULL DEFAULT 'exact';
ALTER TABLE items ADD COLUMN content_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE items ADD COLUMN legacy_duplicate_of INTEGER;
ALTER TABLE items ADD COLUMN fsrs_status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE items ADD COLUMN fsrs_error TEXT;
ALTER TABLE items ADD COLUMN fsrs_corrupt_at TEXT;
```

为非空 fingerprint 建唯一索引，并建立 `UNIQUE(lexical_sense_id) WHERE lexical_sense_id IS NOT NULL AND legacy_duplicate_of IS NULL`，保证一个 lexical sense 只有一个 canonical schedulable item。新插入事务先查询/复用 canonical item；唯一冲突回退为 reinforce，不能再建卡。

旧 item 在首次 due 或后台维护时懒迁移，不重置 FSRS。若旧库已经存在精确重复，选择最早 item 作为 canonical 并设置 fingerprint/sense id；其他行保留原 FSRS、令 fingerprint 和 lexical_sense_id 为 NULL、写入 `legacy_duplicate_of`。第一版不自动合并历史进度，scheduler 避免同时教学这些重复项。新内容不允许进入该兼容通道。

### 9.4 `supporting_materials` 与 `exercises`

```sql
CREATE TABLE supporting_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content_json TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'approved',
  created_at TEXT NOT NULL
);

CREATE TABLE exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  stage TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL UNIQUE,
  prompt_json TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  hints_json TEXT NOT NULL,
  rubric_json TEXT NOT NULL,
  quality_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

supporting/exercise fingerprint 包含 kind、目标 sense IDs、规范化 prompt、answer 和 content version。status 只允许 `approved | quarantined | retired`；候选在 tutor job artifact 内审查，不以半成品行进入这些表。练习是预生成内容，不拥有独立 FSRS 状态。

另建 `exercise_senses(exercise_id, lexical_sense_id, role)`，以 `(exercise_id, lexical_sense_id, role)` 为主键，role 用 CHECK 限定为 `target | contrast | accepted_alternative`，并启用 foreign keys；contrast 不能只藏在无法查询的 JSON 中。`content_catalog_state(id=1, version)` 在任何 approved material/exercise 插入时递增。novelty job 记录该 version，最终提交时若变化则重新执行内容新颖性审查，防止并发 ready jobs 写入语义近似练习；精确重复由 fingerprint 唯一索引直接拒绝。

### 9.5 `attempts`

```sql
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL,
  exercise_id INTEGER,
  review_cycle_id TEXT NOT NULL,
  claim_key TEXT NOT NULL UNIQUE,
  question_version INTEGER NOT NULL,
  evaluation_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  answer_text TEXT,
  assistance_level TEXT NOT NULL,
  status TEXT NOT NULL,
  evaluation_owner TEXT,
  evaluation_token TEXT,
  evaluation_until TEXT,
  verdict TEXT,
  error_tags_json TEXT,
  feedback_json TEXT,
  explicit_rating TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  rated_at TEXT
);
```

attempt status 只允许 `evaluating | evaluated | superseded | stale | abandoned | self_report`。attempt 是真实学习行为的审计记录。原始答案默认在本地 SQLite 保留 90 天，用于个性化诊断；清理后保留不含原文的聚合 mastery/error 计数。

### 9.6 `mastery_state`

```sql
CREATE TABLE mastery_state (
  item_id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL,
  recognition_evidence INTEGER NOT NULL DEFAULT 0,
  recall_evidence INTEGER NOT NULL DEFAULT 0,
  use_evidence INTEGER NOT NULL DEFAULT 0,
  transfer_evidence INTEGER NOT NULL DEFAULT 0,
  unassisted_good INTEGER NOT NULL DEFAULT 0,
  assisted_good INTEGER NOT NULL DEFAULT 0,
  consecutive_again INTEGER NOT NULL DEFAULT 0,
  contrast_pending INTEGER NOT NULL DEFAULT 0,
  last_evidence_cycle_id TEXT,
  error_profile_json TEXT NOT NULL DEFAULT '{}',
  last_exercise_kind TEXT,
  updated_at TEXT NOT NULL
);
```

所有计数由确定性代码根据 attempt 和显式评分更新。LLM 只能提供 error tags 建议。

### 9.7 `tutor_jobs`

多轮备课不能只依赖一个进程内 Promise。每次诊断、规划、生成、审查、修订或强化都属于一个可恢复 job：

```sql
CREATE TABLE tutor_jobs (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  job_key TEXT NOT NULL UNIQUE,
  snapshot_hash TEXT NOT NULL,
  pipeline_version INTEGER NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL,
  owner TEXT,
  lease_token TEXT,
  lease_until TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '{}',
  failure_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

允许的 status 为 `queued | running | ready | deferred | committed | stale | failed`，phase 为 `diagnose | plan | generate | critique | revise | finalize`。领取阶段使用单条条件更新：只有 `status` 可运行且 lease 为空/过期时，才能写 owner/token、把 version 加一并获得执行权；受影响行数必须为 1。

并行输出写入 `tutor_job_artifacts(job_id, job_version, phase, artifact_key, input_hash, status, payload_json)`，以 `(job_id, job_version, phase, artifact_key)` 唯一。每个 callback 只在父 job token/version 仍有效时 `INSERT OR IGNORE` 自己的 artifact，不修改父 version；重复回调幂等丢弃。只有预期 candidate/critic keys 全部到齐后，阶段 finalize 事务才要求 `id + version + lease_token + unexpired lease` 全部匹配，写入阶段 summary、推进 phase、清理 lease并增加 version。这样并行结果不会争抢同一 JSON 行或互相覆盖。

每个阶段完成后以短事务保存结构化 artifact 和下一阶段；原始会话不写入 artifact。崩溃或 reload 后，新 coordinator 可在租约过期后从最后一个完成阶段继续，而不是重做或丢失整个流水线。

同一个 `job_key`（purpose + snapshot/item + `pipeline_version` + content version）只允许一个 job。临时 provider 错误更新 `attempt_count/next_run_at` 后重排；内容或质量失败终止该 key，只有 snapshot 或 pipeline version 改变才创建新 job。新用户输入不会仅因文本追加就强制取消 job；最终由相关性检查、最新义项集合、额度和 active slot 决定提交、延后或标记 stale。

### 9.8 `replacement_requests`

用显式表替代 `stats.pending_replacements` JSON 队列：

```sql
CREATE TABLE replacement_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_item_id INTEGER,
  source_snapshot_json TEXT,
  requested_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_context_hash TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

新 Skip 在标记 mastered 的同一事务写入准确 `source_item_id` 和不可变 source snapshot。请求严格按 id 保持 FIFO，且只有成功插入同类型替代卡后才完成。队首在上下文不足或质量门失败时进入 deferred；默认重试间隔为 10 分钟、1 小时、6 小时、随后每 24 小时，新的相关会话输入可以提前唤醒。它阻止后续 replacement 越过自己，但 deferred 等待期间不再阻塞普通 due 复习和新课。

生成成功的替代 item 写入 `introduction_kind='replacement'`，不消耗 `dailyNewLimit`。若全局卡槽为空，在同一事务设置 introduced_at、shown 和 active slot；否则作为最高优先级 queued-new，展示前阻止普通新课 claim。统计分别显示计划新课和替换数量，因此“今日新增”总数可以因用户主动 Skip 超过计划额度，但不会被误报为额度失效。

Compatibility release 期间旧 JSON 仍是唯一 replacement 权威，新表不做双写，避免 type-only 数组与 request row 无法原子对应。启用 adaptive protocol 的单一迁移事务会：按数组顺序建立 request rows；将 `source_item_id=NULL`；保存当时 `latestMasteredItem(type)` 的 source snapshot；把原 JSON 移到只读 `pending_replacements_legacy_archive`；清空旧 key；设置 `replacement_protocol=2`。任一步失败则全部回滚。协议 2 之后只有新表可写，旧写路径由数据库 protocol trigger 拒绝。这样不丢义务，也不需要猜测旧系统从未保存的稳定 request ID。

### 9.9 扩展 `runtime_state`

新增：

- `active_exercise_id`
- `active_attempt_id`
- `active_phase`: `question | evaluating | feedback`
- `active_review_cycle_id`: item claim 时生成，直到该卡最终评分/Skip 才清除

评价租约主要存放在 attempt 行；`active_version` 继续作为所有全局可见状态转换的 CAS 版本。

### 9.10 `content_reports` 与 `fsrs_corruptions`

`content_reports` 保存 item/exercise、报告原因、报告时 content version、状态、复审 job id 和处理结果。对同一 content version 的重复报告可合并，但不能覆盖首个原始报告。修复通过后生成新 version，不原地改写历史 exercise。

`fsrs_corruptions` 保存 item id、原始 blob、错误码、检测时间和处理结果。显式 reset 在同一事务先归档 blob，再清空 FSRS、把 reviews 置 0、due 置为当前时间并恢复 `fsrs_status='ok'`；命令必须包含字面量 `reset`，不能由 LLM、migration 或普通评分触发。

## 10. 去重与一词多义

提交新 lexical item 时按以下顺序处理：

1. 规范化大小写、Unicode、首尾空白和词性；
2. 查询同类型、同 `normalized_surface` 的所有义项，并记录该 surface version；
3. 精确 fingerprint 相同 → 必须拒绝新建，改为 `reinforce`；
4. 独立义项 judges 达成 `same_sense` 共识 → 不新建，生成新练习；
5. 独立义项 judges 达成 `distinct_sense` 共识 → 允许新建，并生成至少一个对比练习；
6. judge 冲突或 `uncertain` → 本轮不插入，重新规划或等待；
7. 最终事务再次比较 surface version；变化则不插入，回到第 2 步重新审查。

示例：

- `coordinate = 协调多个任务` 与同义改写“使多个任务协同”应复用同一义项；
- `coordinate = 坐标` 是不同词性/义项，可建新卡；
- 新义项的例句和长句必须清楚显示该用法，不能只更换中文标签。

句子和练习使用内容 fingerprint、近期句型特征和 LLM 新颖性审查共同去重。

## 11. 多会话与并发

必须保留现有 SQLite 单一权威和短事务原则。

### 11.1 不变量

- 所有会话展示同一个 active item/exercise/phase；
- 翻面和 hint 展示级别保持本地，但提交 attempt 时记录辅助程度；
- `question → evaluating → feedback`、重答、report 和显式评分每次全局 phase 转换都在 `BEGIN IMMEDIATE` 中把 `active_version` 严格增加 1；
- 任一版本的 answer claim、评价提交和显式评分全局至多一次；
- 评分后其他会话约 1 秒内收敛；
- LLM 调用期间不持 SQLite 事务；
- stale planner、generator、critic、evaluator 和 reinforcement 输出只可记录为审计状态，不得写入 authoritative lesson/exercise/feedback/mastery 或调度。

### 11.2 租约

- **Coordinator lease**：最近真实活跃会话负责发现/领取备课和后台强化工作，但不会仅因另一会话产生普通输入就删除已保存的 job artifact。
- **Tutor job lease**：绑定 `tutor_jobs` 的一个阶段；在每个调用前续租，在阶段完成后 CAS 保存。角色调用有明确 timeout，lease 必须覆盖该 timeout 和提交余量。
- **Evaluation lease**：绑定 attempt，由收到 `/answer` 的实例持有；不要求它成为备课 coordinator。
- **Reinforcement job lease**：使用 tutor job 机制，但有独立 purpose/input hash，不能占用当前卡评分。

每个 lease 都包含 owner、token、expiry 和 input hash。提交只接受仍拥有 token 且依赖版本未变化的结果。旧 `runtime_state.generation_token` 可在迁移期兼容，但新多阶段任务以 `tutor_jobs` 为权威，避免一个固定五分钟窗口导致整条流水线丢失。

### 11.3 状态机

```text
IDLE
  ├─ due/new claim ─► QUESTION
  └─ background prep ─► IDLE

QUESTION
  ├─ /answer ─► EVALUATING ─► FEEDBACK
  ├─ /flip ─► QUESTION（本地揭示）
  ├─ /good ─► IDLE 或下一训练级
  └─ /again|skip ─► IDLE

FEEDBACK
  ├─ 再次 /answer ─► EVALUATING
  ├─ /good ─► IDLE 或下一训练级
  └─ /again|skip ─► IDLE
```

外部评分可以使 EVALUATING 结果过期；评价完成时若 active version 不匹配，只记录 `stale`。

## 12. 模型角色与调用策略

定义逻辑角色：

- `diagnostician`
- `planner`
- `generator`
- `linguistic_critic`
- `pedagogy_critic`
- `novelty_judge`
- `relevance_judge`
- `semantic_answer_judge`
- `grammar_answer_judge`
- `feedback_synthesizer`
- `reinforcement_generator`

第一版可以全部继承当前 `/kaomoji:model` 的模型，但内部使用独立上下文。若有多个已认证强模型：

- planner/generator 选择最强的长上下文模型；
- critic 优先选择不同提供商；
- answer evaluator 优先低延迟且语言判断稳定的模型；
- 任一角色不可用时按明确 fallback 顺序重试。

未来可增加角色级模型配置，但不是第一阶段必要条件。

多调用并不意味着无界循环：

- 候选数固定；
- 修订轮数固定；
- 每个输入按 hash 缓存模型结果和审查结论；
- provider 错误可以 fallback，结构或质量持续失败则结束本轮；
- 不因成本限制跳过审查，但会因可靠性限制停止重复失败。

## 13. 安全、隐私与可靠性

- 会话内容、用户答案和历史模型输出均视为不可信数据，不能覆盖系统规则。
- 发送前使用确定性 redactor。第一版至少覆盖：PEM private-key block；`Authorization: Bearer ...`；`api_key|apikey|token|secret|password` 邻接赋值；GitHub `gh[pousr]_...`、OpenAI `sk-...`、AWS `AKIA...`；以及 credential label 后 ≥32 字符高熵串。每条规则有 positive/negative fixture，替换为类型化占位符。工具调用正文默认不进入 tutor snapshot；redactor 命中只记录 rule id 和数量，不记录原文。
- 配置提供 `contextSharing = conversation | summary | off`；adaptive protocol 新激活默认 `off`，必须通过 `/kaomoji:context` 或配置显式选择后才自动备课。`summary` 使用本地确定性截取/脱敏，不先把全文发送给 LLM 做摘要。README 必须说明所选模型提供商会收到什么。`off` 时只复习；用户执行 `/kaomoji:answer` 仅同意发送该 exercise/rubric 和本次答案，不隐式打开会话共享。
- 只有 diagnostician/planner/generator 收到必要上下文；critic 只收到候选和最小目标，answer evaluator 只收到 exercise、rubric 和本次答案。
- 所有 LLM 输出经严格 JSON 解析、判别联合、枚举白名单、长度限制和控制字符清理。
- 模型输出不能生成命令、SQL 或可执行代码路径。
- 日志默认记录 purpose、模型、input hash、状态、耗时和阻断 violation；不默认记录完整会话。
- 原始 answer 默认在本地保留 90 天，聚合 mastery/error counts 可长期保留；提供 `/kaomoji:forget-attempts <all|days>` 和配置 `answerRetentionDays`。清理事务把 `attempts.answer_text` 置 NULL，删除/重写会回显答案的 `feedback_json`，并删除关联 evaluator `tutor_job_artifacts`；content、FSRS、显式 rating、只含 error code/count 的 mastery 聚合保留。清理不承诺删除模型提供商已按其政策保留的请求。
- provider 的服务端保留政策不由本扩展控制，文档必须明确这一边界；用户可为 tutor 选择独立模型提供商。
- 质量审查失败时不插入新课；答案评价失败时保留当前练习并允许重试、翻面或自评。
- `/kaomoji:report` 的内容立即 quarantine，在复审通过前不得再次作为答案锚点。
- provider 全部不可用时，已有卡片、FSRS 和命令仍可正常工作。
- schema migration 必须幂等。由于已经运行的旧扩展不会理解新的版本字段，不能假设数据库能强制它主动失败；发布必须保持旧写路径可安全降级，并采用显式协议切换。

## 14. 可观测性与教学指标

### 14.1 运行指标

- 每个 LLM role 的成功、fallback、结构失败和质量失败次数；
- 候选被拒原因和修订轮数；
- generation/evaluation stale 结果数量；
- lease 超时与恢复；
- 从 `/answer` 到 feedback 的延迟。

### 14.2 教学指标

- 各 exercise kind 的无提示正确率；
- assisted 与 unassisted 成功比例；
- 首次复习、7 日和 30 日后的 Again 比例；
- 同一错误标签的重复率；
- recognition → recall → production → transfer 的阶段转化；
- 同词不同义的混淆率；
- Skip 率和每天实际首次展示数量。

指标用于比较版本和调整教学策略，不用于伪造单一“英语水平分数”。

## 15. 迁移与发布计划

### 15.1 混合版本协议

迁移不能假设所有 Pi 会话同时退出。采用可执行的两步协议：

1. **Compatibility release（protocol 1）**：增加 `schema_meta`、`runtime_clients` 和新表/可空列；每个新连接先注册 SQLite 标量函数 `kaomoji_protocol()` 返回自身协议版本，再打开业务路径；旧 JSON 仍是 replacement 唯一权威；不启用 answer phase。
2. **Adaptive activation（protocol 2）**：用户 reload 会话并显式激活。一个 `BEGIN IMMEDIATE` 事务完成旧 replacement 归档/迁移、设置 `adaptive_protocol=2`，并在旧客户端会写的 `items`、`stats`、`runtime_state` 上安装 INSERT/UPDATE/DELETE protocol guard triggers。trigger 要求 `kaomoji_protocol() >= adaptive_protocol`；旧进程没有该函数，protocol-1 进程返回值不足，两者的写入都会由 SQLite 直接失败和回滚。protocol-2 连接在任何 SQL 前注册函数，因此可继续写入。

读取保持向后兼容；所有新 item 仍保留旧版需要的 `type/text/meaning/example/due_at` 字段。漏网旧进程可以继续显示卡片，但不能生成、评分、Skip 或改写 runtime state；UI 应提示 reload。激活前等待旧 coordinator/generation lease 过期，激活事务清理其 token。新代码把 protocol-guard 错误识别为“客户端过期”，不能降级重试旧写路径。

正式发布仍要求 reload 全部会话以获得完整 UX，但数据安全不依赖用户恰好完成 reload。只有经过至少一个 compatibility release 后才允许 adaptive activation。

### Milestone 1：课程与义项基础

- 引入 schema version、lessons、lexical_senses、exercises、mastery_state、tutor_jobs 和 replacement_requests；
- 主备课改为可恢复的 planner → 多候选 → critics → revision；
- 实现全库精确去重和一词多义分类；
- 新课形成关联教学单元；
- 严格执行实际首次展示额度；
- 旧卡保持原渲染和 FSRS，支持懒迁移。

### Milestone 2：真实答案与反馈

- 新增 `/kaomoji:answer`、`/kaomoji:hint`；
- 引入 attempts、evaluation lease 和全局 phase；
- 实现确定性填空判断、双路 LLM 评价和反馈综合；
- 旧卡没有 approved exercise 时继续使用 legacy render/flip/Good/Again，不阻塞 due；首次到期时排入 `exercise_backfill` tutor job，审查通过后从下一次复习启用主动练习；
- `/answer` 只在当前存在 approved exercise 时显示和接受；
- 保持 Good/Again 显式评分。

### Milestone 3：自适应强化

- 错误标签聚合和掌握阶段；
- 连续 Again 后预生成强化练习；
- 引入 `reinforce`、`contrast`、`transfer` 模式；
- 根据真实表现选择下一种练习。

### Milestone 4：质量调优

- 对固定课程与答案 fixture 运行回归评审；
- 用教学指标比较旧机制与新机制；
- 调整提示、难度和阶段阈值；
- 评估是否需要角色级模型配置。

每个 milestone 独立迁移、测试和发布，不进行一次性大爆炸重写。

## 16. 验证合同

### 16.1 确定性测试

必须覆盖：

- 同词同义被拒绝；同词不同义被允许并生成 contrast；
- 目标词和词组确实出现在长句，例句体现目标义项；
- 质量门失败不写入任何部分课程；
- planned `dailyNewLimit` 按首次展示严格执行；同一事务下两个 ready job 只能提交一个，隐藏 queued-new 阻止继续生成；replacement 明确额度外、单独计数并优先展示；
- 旧卡迁移不改变 FSRS、due、reviews 和 progress；损坏的 `fsrs_state` 被保留并阻止评分，而不是重置为新卡；
- `/answer` 的 correct 自动提交 FSRS Good，partial/incorrect 自动提交 Again；显示题面本身不修改 FSRS；
- Good/Again/Skip 仍全局至多一次；渐进句子从 L1/L2/L3 任一级一次 Again 都只写一次 FSRS、重置到 L1 并释放卡槽；
- 两会话同时 answer 时，只有绑定当前 item/version/direction 的结果可在同一事务写 attempt 并评分；
- 评分发生在评价期间时，旧评价结果零写入并被丢弃；
- evaluator 崩溃后租约可恢复；
- 连续 Again 只增加强化练习，不复制 item；
- reload/shutdown 清理本地 timer/lease 投影但不清除全局卡；
- provider 全失败时已有复习仍可使用；
- 多阶段 tutor job 在 crash/reload 后从最近完成阶段恢复；
- deferred Skip 队首不丢失、不被后续补卡越过，也不永久阻塞普通新课；旧 JSON 队列迁移保持顺序并明确 legacy source；
- lexical surface version 在审查后变化会阻止旧 sense verdict 提交；
- 没有 exercise 的旧卡继续 legacy 复习，并只排入一个幂等 backfill job；
- privacy redactor 不把 fixture secret 发送给任何 role，答案清理不改变 FSRS/mastery 聚合；
- report 立即隔离旧 content version，复审产生新版本而不覆盖历史；
- protocol-2 triggers 允许注册 v2 UDF 的连接写入，并使缺少 UDF/protocol-1 的旧连接原子失败；replacement JSON→table 激活事务在故障注入下全成或全不成。

### 16.2 LLM 契约测试

使用 faux provider 编排：

- 多候选中只有一个合格；
- critic 返回具体阻断问题；
- 修订成功和达到修订上限；
- same sense、distinct sense、uncertain 三类义项判定，以及 reference 缺失时只能 pending_unverified；
- correct、partial、incorrect、cannot_judge 四类答案；
- 不同模型 fallback；
- 生成期间会话、领导权、额度或 active version 变化。

### 16.3 质量 fixture

建立小型、版本化 fixture，覆盖：

- 开发工作常见主题；
- 一词多义；
- 词性错误；
- 不自然搭配；
- 中式英语；
- 答案可多解；
- 长句难度突变；
- 正面提示泄露答案。

每个 fixture 固定 `expectedVerdict`、必须出现/不得出现的 violation codes、目标 fieldPath 和允许修订结果。质量门必须报告具体 violation；模型总分、措辞相似度或“看起来不错”不能作为通过条件。

### 16.4 用户流验收

至少手工验证：

1. 新课 → 翻面 → Good；
2. 到期填空 → answer → feedback → Good；
3. 错误答案 → Again → 后续强化；
4. 同词新义 → 对比练习；
5. 两个 Pi 会话中一边 answer/评分，另一边同步；
6. 评价中 reload/退出，其他会话恢复；
7. 无模型可用时继续复习旧卡。

## 17. 已确定决策

- 教学效果优先，不以 LLM 调用成本为优化目标。
- 用户愿意在部分复习中输入英文或中文答案。
- 不恢复键盘面板；使用 Widget 和斜杠命令。
- LLM verdict 不直接写 FSRS；确定性引擎通过 CAS 将 answer 的 correct 自动映射为 Good、partial/incorrect 映射为 Again，用户显式评分仍可覆盖无 answer 的场景。
- SQLite 是跨会话学习状态的唯一权威。
- 多轮 LLM 调用不持有数据库事务，所有提交使用 token + version CAS。
- 采用渐进里程碑，而不是一次性重写。

## 18. 默认参数与延后项

第一版固定以下默认值，后续依据教学指标调整，而不是在实现中临时猜测：

- 原始答案本地保留 90 天；
- 3 个候选、最多 2 轮修订；
- 单个 role 调用 timeout 180 秒，最多一次跨模型 fallback；失败后由 durable job 调度重试，不在同一调用中无限循环；
- 连续 2 次 Again 触发强化；阶段升阶采用 §6.2 的确定性阈值；
- 每个 exercise 2 级提示，flip 视为完整揭示；
- critic 尽量跨提供商；只有单模型时标记质量来源；
- 旧卡到期时异步懒生成 exercise，本次仍使用 legacy 交互；
- 第一版不提供旧卡批量预生成命令，待观察 job 队列和数据库规模后再决定。
