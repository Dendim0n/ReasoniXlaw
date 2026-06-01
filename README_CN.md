# ReasoniXlaw

<p align="center">
  <img src="./docs/reasonixlaw-logo.png" alt="ReasoniXlaw Logo" width="600">
</p>

**DeepSeek 模型的 prefix-cache 稳定上下文引擎 — OpenClaw 插件。**

> 灵感来自 [Reasonix](https://github.com/esengine/DeepSeek-Reasonix) — 感谢该项目作者提出的 prefix-stable 上下文管理理念。

[English](./README.md) | 中文

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
      "deepseek-harness": { enabled: true }
    },
    slots: {
      contextEngine: "deepseek-prefix-stable"
    }
  }
}
```

就这么简单。当使用 DeepSeek 模型时，PI 会自动使用我们的 prefix-stable 上下文引擎。

### 自定义目标模型

默认 `deepseek-v4-flash` 和 `deepseek-v4-pro` 会触发 prefix-stable 模式。如需添加自己的模型：

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    entries: {
      "deepseek-harness": {
        enabled: true,
        config: {
          targetModels: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v3", "my-custom-deepseek"]
        }
      }
    },
    slots: {
      contextEngine: "deepseek-prefix-stable"
    }
  }
}
```

`targetModels` 会**替换**默认列表 — 需要保留默认值的话请一并写上。

### 模型检测

引擎**仅对** DeepSeek 模型激活。检测逻辑：

| 模型 | Prefix-stable 模式 |
|------|-------------------|
| `deepseek-v4-flash` | ✅ 激活 |
| `deepseek-v4-pro` | ✅ 激活 |
| `deepseek/deepseek-v4-pro` | ✅ 激活（provider/model 格式） |
| `deepseek-v3`、`deepseek-r1` | ✅ 激活 |
| `gemini-2.5-flash` | ❌ 透传（PI 默认行为） |
| `gpt-4o` | ❌ 透传（PI 默认行为） |
| unknown/undefined | ✅ 激活（安全默认值） |

非 DeepSeek 模型走 PI 默认上下文管理 — 零开销、零干扰。

### 可选调参

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `prefixLockCount` | 2 | 锁定到 prefix 层的消息数 |
| `recentKeepCount` | 8 | 在 tail 中保留的最近消息数 |
| `compactRatio` | 0.8 | 触发压缩的上下文比例 |
| `archiveDropped` | true | 是否将被丢弃的消息归档到磁盘 |
| `targetModels` | `["deepseek-v4-flash", "deepseek-v4-pro"]` | 触发 prefix-stable 模式的模型名模式 |

#### `prefixLockCount`（默认：2）

锁进 prefix 层的消息数。这 2 条消息（通常是 system prompt + 第一条用户消息）**永远不变**，是 DeepSeek 缓存命中的核心。设太大浪费 context 空间，设太小锁不住足够的 prefix。一般 2 就够了。

#### `recentKeepCount`（默认：8）

tail 层保留的最近消息数。这些消息在压缩时不被摘要，保持原文。8 条意味着你最近 4 轮对话不会丢细节。设太大 → 上下文膨胀快；设太小 → 近期记忆模糊。

#### `compactRatio`（默认：0.8）

当已用 token 达到 context window 的 80% 时触发压缩。0.8 是个平衡点——太早压缩（0.5）浪费空间，太晚（0.95）可能来不及压缩就被 PI 强制截断了。

#### `archiveDropped`（默认：true）

压缩时被丢弃的消息是否归档到 `~/.openclaw/deepseek-harness/archive/` 目录（JSONL 格式）。开起来方便事后审计或回溯，关了省磁盘 I/O。

#### `targetModels`

哪些模型名触发 prefix-stable 模式。**替换**（不是追加）默认列表，所以你自定义时要把默认的也写上，否则 `deepseek-v4-flash` 之类的默认模型就不激活了。

> **一般来说默认值就够用。** 除非：context 特别紧张（降 `prefixLockCount`），近期对话需要更精确（提 `recentKeepCount`），上下文经常爆（降 `compactRatio`）。

## 工作原理

1. **首次 `assemble()` 调用**：系统 prompt + 前 N 条消息 → 锁入 Layer 1（prefix）
2. **后续调用**：新消息 → 只追加到 Layer 2（tail）
3. **压缩**：上下文填满时 → 只有 Layer 3 改变 → prefix 保持稳定
4. **DeepSeek 看到相同的开头** → 缓存 token 按 10% 计费

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

## 费用对比

| 场景 | 默认 PI | 本引擎 |
|------|---------|--------|
| 100K 对话，缓存命中率 | ~10% | ~80%+ |
| 每轮费用（V4 Pro，1M ctx） | ~$0.15 | ~$0.03 |
| 长会话（50 轮） | ~$7.50 | ~$1.50 |

*基于 DeepSeek 定价：$0.14/M 输入，$0.028/M 缓存。*

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

## 许可证

MIT
