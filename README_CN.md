# ReasoniXlaw

<p align="center">
  <img src="./docs/reasonixlaw-logo.png" alt="ReasoniXlaw Logo" width="600">
</p>

**DeepSeek 兼容模型的 prefix-cache 稳定上下文引擎 — OpenClaw 插件。**

> 灵感来自 [Reasonix](https://github.com/esengine/DeepSeek-Reasonix) — 感谢该项目作者提出的 prefix-stable 上下文管理理念。

[English](./README.md) | 中文

文档：[架构](./docs/ARCHITECTURE.md) | [优化说明](./docs/OPTIMIZATION_PLAN.md)

## 问题

DeepSeek 的 API 提供 **prefix 缓存**：如果你的请求开头与前一次完全相同，缓存的 token 只需正常价格的 ~10% — 节省高达 90%。

但 OpenClaw 默认的上下文管理会在上下文填满时随意压缩/修改消息，这会**破坏 prefix**，导致 DeepSeek 缓存失效。

## 解决方案

一个 **ContextEngine 插件**，用三层管理上下文：

```
┌─────────────────────────────────────┐
│  层 1：锁定 PREFIX                  │  ← 永远不变。缓存在这里命中。
│  系统 prompt + 早期历史             │
├─────────────────────────────────────┤
│  层 2：活跃 TAIL                    │  ← 压缩之间只追加。
│  最近的消息                         │
├─────────────────────────────────────┤
│  层 3：压缩 MIDDLE                  │  ← 唯一会被修改的层。
│  更早消息的摘要                     │
└─────────────────────────────────────┘
```

压缩只动中间层。prefix **永远不会被修改**。
DeepSeek 每轮看到相同的开头 → 缓存命中 → 省 90% 费用。

## 架构

这是一个 **ContextEngine 插件**，不是 AgentHarness。这意味着：

| 组件 | 谁负责 |
|------|--------|
| 上下文组装 & 压缩 | **本插件** (prefix-stable) |
| 工具执行 | OpenClaw PI |
| 认证 & API keys | OpenClaw PI |
| 流式传输 | OpenClaw PI |
| 重试 & 降级 | OpenClaw PI |
| 对话持久化 | OpenClaw PI |
| reasoning effort | PI 直接透传给 DeepSeek |
| 缓存统计 | 通过 `ContextEngineRuntimeContext.promptCache` 获取 |

我们在 PI 执行循环的正确节点（`assemble`、`compact`）插入逻辑，其他一切都交给 PI 处理。没有自建 HTTP client，没有 tool bridge，没有 auth 处理。

## 安装

**通过 ClawHub（推荐）：**

> ⚠️ **注意：** ClawHub 目前存在一个 bug，导致此插件无法发布到 ClawHub。在此问题修复之前，请从源码安装。

```bash
openclaw plugins install clawhub:@dendim0n/reasonixlaw
```

**从源码安装：**

```bash
cd ~/.openclaw/plugins
git clone https://github.com/Dendim0n/ReasoniXlaw.git
cd ReasoniXlaw
npm install
npm run build
```

## 配置

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    entries: {
      "reasonixlaw": { enabled: true }
    },
    slots: {
      contextEngine: "reasonixlaw-prefix-stable"
    }
  }
}
```

就这么简单。当使用匹配的 DeepSeek 兼容目标模型时，PI 会自动使用我们的 prefix-stable 上下文引擎。

插件入口 id 使用 `reasonixlaw`，runtime context engine id 使用 `reasonixlaw-prefix-stable`。代码仍会在新入口没有配置时读取旧的 `plugins.entries.deepseek-harness.config`，方便已有调参配置逐步迁移。旧 slot id `deepseek-prefix-stable` 不是当前 runtime id。

### 自定义目标模型

默认任何包含 `deepseek` 的模型名都会触发 prefix-stable 模式。额外默认目标列表还覆盖 `mimo-v2.5-pro` 和 `mimo-v2.5`。如需添加自己的非 DeepSeek 模型别名：

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    entries: {
      "reasonixlaw": {
        enabled: true,
        config: {
          targetModels: ["mimo-v2.5-pro", "mimo-v2.5", "my-private-r1"]
        }
      }
    },
    slots: {
      contextEngine: "reasonixlaw-prefix-stable"
    }
  }
}
```

`targetModels` 会替换额外目标列表，但不会替换内置的 `deepseek` 字符串规则。如果自定义后仍希望 `mimo-v2.5-pro` 和 `mimo-v2.5` 激活，需要把它们继续写进列表。

### 模型检测

引擎会对 DeepSeek 兼容目标模型激活。检测逻辑有两条：任何包含 `deepseek` 的模型名都会激活；任何匹配 `targetModels` 的模型名也会激活。

| 模型 | Prefix-stable 模式 |
|------|-------------------|
| `deepseek-v4-flash` | ✅ 激活 |
| `deepseek-v4-pro` | ✅ 激活 |
| `mimo-v2.5-pro` | ✅ 激活 |
| `mimo-v2.5` | ✅ 激活 |
| `deepseek/deepseek-v4-pro` | ✅ 激活（provider/model 格式） |
| `deepseek-v3`、`deepseek-r1` | ✅ 激活 |
| `gemini-2.5-flash` | ❌ 透传（PI 默认行为） |
| `gpt-4o` | ❌ 透传（PI 默认行为） |
| unknown/undefined | ✅ 激活（安全默认值） |

非目标模型走 PI 默认上下文管理 — 零开销、零干扰。

### 可选调参

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `prefixLockCount` | 2 | 锁定到 prefix 层的消息数 |
| `recentKeepCount` | 8 | 在 tail 中至少保留的最近消息数 |
| `tailTokenBudget` | 16384 | 用于保留更多最近 tail 消息的 token 预算 |
| `compactRatio` | 0.8 | 触发压缩的上下文比例 |
| `outputReservedTokens` | 32768 | 计算压缩压力前预留的输出 token 预算 |
| `maxSummaryTokens` | 2000 | 累计摘要超过该估算值后重新压缩 |
| `toolResultTrimChars` | 2000 | 旧工具结果被裁剪前保留的字符数 |
| `archiveDropped` | true | 是否将被丢弃的消息归档到磁盘 |
| `targetModels` | `["deepseek-v4-flash", "deepseek-v4-pro", "mimo-v2.5-pro", "mimo-v2.5"]` | 触发 prefix-stable 模式的模型名模式 |

#### `prefixLockCount`（默认：2）

锁进 prefix 层的消息数。这 2 条消息（通常是 system prompt + 第一条用户消息）**永远不变**，是 DeepSeek 缓存命中的核心。设太大浪费 context 空间，设太小锁不住足够的 prefix。一般 2 就够了。

#### `recentKeepCount`（默认：8）

tail 层至少保留的最近消息数。这些消息在压缩时不被摘要，保持原文。只要还在 `tailTokenBudget` 内，引擎会继续多保留一些较新的消息。

#### `tailTokenBudget`（默认：16384）

用于 verbatim tail 的 token 预算，作用在最低保留消息数之外。这样少数大型工具输出不会频繁触发完整压缩，小型最近消息也能尽量保留原文。

#### `compactRatio`（默认：0.8）

当已用 token 达到 context window 的 80% 时触发压缩。0.8 是个平衡点——太早压缩（0.5）浪费空间，太晚（0.95）可能来不及压缩就被 PI 强制截断了。

#### `outputReservedTokens`（默认：32768）

计算压缩压力前预留给模型输出的预算。有效触发阈值近似为 `tokenBudget * compactRatio - outputReservedTokens`，预期输出越大，压缩越早发生。

#### `maxSummaryTokens`（默认：2000）

累计摘要允许的最大估算 token 数。超过后，引擎会把旧摘要和新摘要重新压缩成一个有边界的结构化 briefing，而不是无限追加。

#### `toolResultTrimChars`（默认：2000）

旧工具结果在最近保留窗口之外会被裁剪。裁剪标记会记录原始长度和保留字符数，让模型知道证据被缩短过。

#### `archiveDropped`（默认：true）

压缩时被丢弃的消息是否归档到 `~/.openclaw/reasonixlaw/archive/` 目录（JSONL 格式）。开起来方便事后审计或回溯，关了可以省磁盘 I/O，并减少本地保留的工具输出。

#### `targetModels`

额外的模型名模式。任何包含 `deepseek` 的模型名仍会激活，即使不在这里。自定义这个列表主要影响 `mimo-v2.5-pro`、`mimo-v2.5`，以及不包含 `deepseek` 字符串的私有 DeepSeek 兼容模型名。

> **一般来说默认值就够用。** 除非：context 特别紧张（降 `prefixLockCount`），近期对话需要更精确（提 `recentKeepCount`），上下文经常爆（降 `compactRatio`）。

## 工作原理

1. **首次 `assemble()` 调用**：系统 prompt + 前 N 条消息 → 锁入 Layer 1（prefix）
2. **后续调用**：新消息 → 只追加到 Layer 2（tail）
3. **压缩**：上下文填满时 → token-aware tail 选择 + 结构化中间摘要 → prefix 保持稳定
4. **DeepSeek 看到相同的开头** → 缓存 token 按 10% 计费
5. **循环保护**：如果连续压缩仍无法降到阈值以下，自动压缩会暂停，避免浪费轮次

## 关键设计决策

### 为什么是 ContextEngine 而不是 AgentHarness？

AgentHarness 接口会替换**整个**执行循环。Codex 需要这样做（它有自己的 app-server），但我们不想替换工具执行、认证、流式传输或重试 — 我们只想用不同的方式管理上下文。

ContextEngine 接口是**恰好正确的**抽象：
- `assemble()` → 我们控制 prompt 里放什么
- `compact()` → 我们控制上下文如何压缩
- 其他一切都交给 PI

### 为什么不自建 API client？

PI 的 model transport（`params.model`）已经：
- 处理认证（API key 解析）
- 支持流式传输
- 透传 `reasoning_effort`（DeepSeek 配置有 `supportsReasoningEffort: true`）
- 报告 `promptCache` 信息（缓存命中/未命中统计）

自建 HTTP client 会重复所有这些功能，还失去了 auth 集成。

## 收益与代价

收益：

- DeepSeek prefix cache 命中时，输入成本更低。
- prefix 在压缩时不被改写，缓存命中概率更高。
- 最近 tail 按 token 预算选择，旧工具输出可先裁剪，减少上下文抖动。
- 当 OpenClaw 提供稳定 `sessionFile` 时，层状态会写入 `<sessionFile>.reasonixlaw-state.json`。已有的 `<sessionFile>.deepseek-harness-state.json` 仍会作为旧格式 fallback 读取。
- 不重复造 transport。认证、工具、流式、重试、对话持久化和缓存统计仍由 PI 负责。

代价：

- 锁定 prefix 不容易改变。如果最早几条消息质量差，它们会一直留在可缓存 prefix 中，直到重开会话。
- 摘要是有损的。结构化 prompt 会尽量保留操作状态，但细节仍可能丢失。
- 有 runtime LLM 可用时，压缩会增加一次小模型调用和延迟。抽取式 fallback 更便宜，但精度更低。
- token 估算是 CJK-aware 字符估算，不是 provider tokenizer 的精确值。
- 旧工具结果裁剪可能隐藏证据。裁剪标记会说明发生过裁剪，archive 可以在本地保留原始消息。
- sidecar 和 archive 会在本地保留上下文投影数据和被压缩消息。不希望本地保留时请关闭 `archiveDropped`。
- 如果连续两次压缩仍超过阈值，stuck guard 会暂停自动压缩。这能避免重复浪费，但剩余压力仍可能需要 host 处理。

## 费用对比

| 场景 | 默认 PI | 本引擎 |
|------|---------|--------|
| 100K 对话，缓存命中率 | ~10% | ~80%+ |
| 每轮费用（V4 Pro，1M ctx） | ~$0.15 | ~$0.03 |
| 长会话（50 轮） | ~$7.50 | ~$1.50 |

*仅作估算示例。用于预算前请替换成当前 provider 价格。*

## 测试

```bash
npm test
```

## 文件说明

| 文件 | 用途 |
|------|------|
| `src/types.ts` | 配置、token 估算 |
| `src/context-engine.ts` | ContextEngine 实现（核心逻辑） |
| `src/index.ts` | 插件入口 — 注册 context engine |
| `tests/context-engine.test.ts` | 单元测试 |
| `openclaw.plugin.json` | 插件清单 |
| `docs/ARCHITECTURE.md` | 集成流程、状态持久化与设计取舍 |
| `docs/OPTIMIZATION_PLAN.md` | 已实施优化措施与原理 |

## 许可证

MIT
