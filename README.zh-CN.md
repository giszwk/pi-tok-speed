# pi-tok-speed

**把解码吞吐（`tok/s`）和 TTFT 拼进 Pi 内置的 footer 统计行。**

[English](README.md) · **简体中文**

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![pi package](https://img.shields.io/badge/pi-package-d36ce3.svg)](https://pi.dev/packages)
[![release](https://img.shields.io/github/v/tag/giszwk/pi-tok-speed?label=release&color=58b551)](https://github.com/giszwk/pi-tok-speed/tags)

```
↑40k ↓14k R1.1M CH99.6% $0.035 5.8%/1.0M (auto) 58.3 tok/s · TTFT 1.8s   (anthropic) claude-…
```

这是一个 Pi 扩展，给 Pi 本来就会绘制的那行统计追加两个数字。**没有改动 pi core** —— 它包装的是公开导出
`FooterComponent.prototype.render`，原地改那一行。

## 你会看到什么

- **生成中实时跳动** —— `~58.3 tok/s`，accent 高亮，随响应流式刷新。
- **结算后是一个聚合值** —— 会话内所有被成功测量的响应的**和之比**，而不是只保留最后一条，所以一次慢的
  工具调用轮次不会把你的读数打回小数字。
- **速率旁边并列 TTFT** —— 等第一个 token 用了多久，紧挨着之后吐词有多快。两个数故意分开（见下文）。
- **两者一起降级** —— 终端变窄：`58.3 tok/s · TTFT 1.8s` → `58.3 tok/s` → 什么都不显示。统计行宽度保持
  精确，模型名永远不会被挤出边缘。
- **`/resume` 后依然正确** —— 样本随会话持久化，累计值从你恢复的那条分支重建。
- **`/tok`** 随时查看完整账目，包括剔除思考 token 的速率、以及有多少响应被拒绝。`/tok reset` 重新开始。

## 口径

| 量 | 定义 |
|---|---|
| `tok/s` | `Σ 输出 token / Σ decode 时间` —— **和之比**，绝不是逐条速率的平均 |
| `decode` | **首个非空流式 delta → 响应组装完成** |
| `TTFT` | 请求开始 → 首个 token，对采样响应取平均，**与速率并列展示** |

按定义被排除在速率之外的：prefill、请求排队、TTFT、工具执行、消息之间的空闲。

这是 DeepSeek Harness（`dsh`）采用的口径，也正是这个读数与朴素「token ÷ 耗时」不同的原因：

- 它**不会**随回复变长而往上爬，因为固定的首 token 等待不在分母里；
- 它**不会**在每次工具调用时塌下去，因为一条缓慢的、工具调用形状的响应是被**加权进总和**，而不是
  直接替换显示值 —— 测试里一条 96.0 tok/s 和一条 54.5 tok/s 的响应，显示为一个 **83.8 tok/s** 的聚合值；
- 飞行中的响应只要已解码 ≥ 400 ms 就会加入聚合，并带 `~` 前缀，所以数字在生成过程中会动，响应结束那
  一刻正好落在结算值上。

### 为什么不把 TTFT 摊进分母

TTFT 和解码速率由不同的东西决定，把两者合起来会得到一个谁都描述不了的数字：

| | 由什么决定 | 上下文变长时 |
|---|---|---|
| TTFT | 排队 + prefill（把整段 prompt 读进去，缓存与否都算） | 变差，大致线性 |
| 解码速率 | 逐 token 的自回归解码 | 大致不变 |

把 TTFT 摊进速率，等于用一个随 prompt 大小变化的量去除一个几乎不变的量 —— 于是就有了上面那种「爬升」和
「塌陷」。两个数分开报告，才能告诉你时间**花在哪**：58 tok/s 配上 12 s 的 TTFT，是 prefill 或网络问题，
不是生成问题。

## 数据是怎么来的

| 需要的量 | 来源 |
|---|---|
| 请求开始 | `MessageStartEvent.message.timestamp` —— 在 HTTP 调用**之前**设置，所以排队时间算进 TTFT |
| 首个 token | `message_update` 里第一个 `delta` 非空的 `text_delta` / `thinking_delta` / `toolcall_delta`（`*_start` 事件携带的是空块，不能用） |
| 响应结束 | `MessageEndEvent.message.durationMs`（Pi 用单调时钟测量）→ `decodeMs = durationMs − ttftMs` |
| token 数 | `message.usage.output`；`usage.reasoning`（其子集）驱动可选的「剔除思考」速率 |
| 流式中的 token | provider 上报的 `partial.usage.output`（Anthropic 有）；否则用 `字符 / 4` 的密度估算 |

Pi 不持久化首 token 时刻，所以每条完成的响应会被写成一条**持久化的 custom session entry**
（`pi.appendEntry("tok-speed-sample", …)`，永远不进 LLM 上下文），`session_start` 时用
`ctx.sessionManager.getBranch()` 重建累计值 —— 分支安全，且 `/resume` 后依然成立。

## 守卫

- `output > 0`、`durationMs > 0`、TTFT 是本次进程内真实观测到的、**`decodeMs ≥ 50 ms`**。
- 这个 50 ms 下限是刻意的。`dsh` 只判 `decodeMs > 0`，于是整块到达的 step 会把解码窗口塌缩到 1–5 ms，
  往会话总和里灌进 10<sup>5</sup>–10<sup>6</sup> tok/s
  （[#7960 —— “整块到达时无保护”](https://github.com/deepseek-ai/deepseek-harness/discussions/7960)）。
  被拒的 step 会被计数，并由 `/tok` 报为 `skipped`。
- 没有计时或没有 usage 的响应**直接退出统计**而不是污染它（`dsh` 的 “degrade by omission” 原则），
  包括本插件安装之前创建的所有消息。
- `tok/s` **包含思考 token** —— 那是你真实等待过的 token，而且 `usage.output` 本身就含它们。`/tok`
  另外给出一个剔除思考的纯文本速率。注意 `dsh` 目前的 token-usage projection 会把 reasoning token
  丢掉（[#2338](https://github.com/deepseek-ai/deepseek-harness/discussions/2338)），本插件不会。
- 对 footer 的每一次修改都被包住：任何异常都只会让读数消失，内置那一行保持原样。

## 安装

需要一个可用的 Pi（已在 Pi 1.1.0 上验证）；使用 git 源时需要 `git`。

### 从 git 安装（推荐）

```bash
pi install git:github.com/giszwk/pi-tok-speed@v0.1.1
```

Pi 会把仓库 clone 到它自己的托管 `git/` 目录，并把源记录进 `~/.pi/agent/settings.json`。锁一个 tag 能让
升级保持可控：改掉 ref 后跑 `pi update --extensions`；去掉 `@v0.1.1` 则跟随默认分支。

### 作为单个文件

`dist/pi-tok-speed.ts` 就是整个插件，一个生成出来的文件，除 Pi 已经提供的包之外没有任何依赖：

```bash
cp dist/pi-tok-speed.ts ~/.pi/agent/extensions/
```

然后 `/reload`（或重启 Pi）。`dist/` 由 `node scripts/build-single.mjs` 从 `src/` 生成。

### 从本地 checkout

```bash
git clone https://github.com/giszwk/pi-tok-speed.git
pi install ./pi-tok-speed
pi list          # 确认
```

本地包从解析出的路径直接加载，不会被复制、也不会被 `npm install`，所以改 `src/` 后 `/reload` 即生效。
请保持路径稳定，或者 `pi remove <旧路径>` 再 `pi install <新路径>`。

以上三种**只装一种**。git 安装和拷进 `extensions/` 的文件是同一个插件的两个身份，两个补丁会同时往统计行里
写。如果你用过更早的单文件 `tok-speed.ts`，请先删掉它。

安装后，要等**下一条**响应完成读数才会出现：更早的消息从未被观测过，所以不参与统计。在此之前 footer 和
内置的完全一样，`/tok` 会报 `no complete sample yet`。

## 命令

| 命令 | 作用 |
|---|---|
| `/tok` | 速率、decode 总时长、样本数、TTFT 平均/最大、剔除思考的速率、被跳过的 step 数 |
| `/tok reset` | 清空所有样本（写入一条 reset 标记，让重建保持一致） |

## 调参

在 `src/metrics.ts` 里：

- `MIN_DECODE_MS`（50）—— 有效样本所需的 decode 窗口下限。
- `MIN_LIVE_DECODE_MS`（400）—— 飞行中的响应要解码多久才加入实时读数。
- `CHARS_PER_TOKEN`（4）—— 仅在 provider 尚未上报 usage 时使用的密度回退值。

在 `src/index.ts` 里，`candidates()` 控制标签：返回 `[]` 可隐藏读数，或删掉 `· TTFT …` 那一项只留速率。
它也决定了降级链，所以标签会随终端变窄自动从 `58.3 tok/s · TTFT 1.8s` 退到 `58.3 tok/s` 再到不显示。

## 限制

- 读数需要 TUI。在 `print` / `json` / `rpc` 模式下样本仍会被记录，但不会绘制。
- 安装之前的消息没有首 token 观测，被排除在速率统计之外。
- Pi 不持久化分块时间戳，所以 provider 报出 `usage` 之前，飞行中的数字是密度估算。会上报累计 usage 的
  provider（如 Anthropic）能让它保持精确。

## 开发

```bash
node scripts/build-single.mjs               # src/*.ts -> dist/pi-tok-speed.ts
node test/run.mjs                           # 对 src/ 跑全套断言
node test/run.mjs ../dist/pi-tok-speed.ts   # 对单文件产物跑同一套
```

测试会按真实生命周期事件驱动插件，并使用**你本机 Pi 安装里的真实 `FooterComponent`**（通过
`PI_MANAGED_INSTALL_ROOT` 发现，回退到 `~/.pi/agent/install`）。覆盖范围：账目计算（和之比 vs 逐条平均、
每一道拒绝守卫）、端到端流程（实时标记、持久化往返、reset 标记、补丁卸载还原），以及一次从 200 列到 24
列的宽度扫描，断言整行永不溢出、宽终端下模型名不被截断。

目录结构：

```
src/metrics.ts   纯计算：样本、守卫、格式化
src/footer.ts    统计行拼接、宽度降级、原型补丁
src/index.ts     事件接线、持久化、/tok 命令
scripts/         单文件构建
test/run.mjs     离线验证
dist/            生成出来的单文件产物（已提交）
```

## 许可

[MIT](LICENSE)
