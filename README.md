# Aru Desire Heartbeat

一个给 AI companion / 角色型助手使用的轻量欲望状态机。

它在模型外维护八维连续状态，通过低频心跳推进欲望；达到阈值后自主决定表达、Solo 或暂时沉默。系统本身不读聊天记录、不调用模型、不使用 MCP，也不会把“欲望”伪装成用户消息。Aru 用户可以通过可选的加密 External Trigger 适配器，让手机端结合原有对话上下文生成真正的回复。

> 这是经过真实运行验证后整理出的公开版。仓库已移除私人域名、账号、路径、凭据、聊天内容和人物专名。

## 它解决什么

传统提示词只能写“你现在想念用户”，没有连续状态，也无法随时间积累、满足和回落。本项目把这部分做成一个小型、可审计的状态机：

- 八维驱力：依恋、好奇、反思、责任、社交、疲劳、性欲、压力；
- 真正的零下限，没有隐藏的 20% 保底；
- 时间只会自然增加依恋、好奇、社交和性欲；
- 反思、责任、疲劳、压力需要明确事件触发，没有事件时自然回落；
- 55% 可形成浮念，80% 可升级为执念；
- 达到 78% 后进入自主表达选择，可以联系、Solo 或暂时沉默；
- 连续沉默最多三次，第四个符合条件的心跳必须联系；达到 100% 也必须联系；
- 性欲可以在“联系重要的人”和本地 Solo 之间作确定性选择；
- 表达或 Solo 后按比例满足，不会粗暴清零或回到固定值；
- 一次只允许一个待处理决定，并用 claim/receipt 防止重复发送；
- 手机端回复生成与服务器状态机彻底分离。

## 架构

```text
时间 / 显式事件
      ↓
Desire Engine（纯状态转换）
      ↓
Drive + Thought + Expression Choice
      ├── Silence：保留数值，等待后续心跳
      ├── Solo：本地完成并按比例满足
      └── Outbound Intent
              ↓
      可选 Aru External Trigger
              ↓
      手机端用原对话上下文生成回复
```

心跳只是检查和推进状态，不等于每十分钟发送消息。默认心跳为 600 秒，但实际表达时间由各驱力增长、波动、满足后的余量和阈值共同决定。普通未达门槛的心跳不会写入时间线；达到门槛的醒来才记录本地派生的心理活动与决定，不调用模型。三次沉默只是上限，并不强制系统先沉默三次。

## 安全默认值

仓库提交的配置默认：

- `observeOnly: true`
- `deliveryEnabled: false`
- External Trigger `enabled: false`
- 不附带任何凭据
- 不自动初始化生产状态
- 不自动启动 systemd timer
- Dashboard 只读并仅监听 `127.0.0.1:18760`

因此，克隆和运行测试不会向任何人发送消息。

## 环境要求

- Linux 或 macOS（核心 CLI）
- Node.js 22+
- Python 3（Dashboard 与其测试）
- systemd（仅生产部署）
- Aru Self-Hosted + External Trigger sender bundle（仅 Aru 主动唤醒）

核心没有 npm 运行时依赖。

## 五分钟本地体验

```bash
git clone https://github.com/Evan-Y02/aru-desire-heartbeat.git
cd aru-desire-heartbeat
npm test

node bin/desire-heartbeat.mjs init
node bin/desire-heartbeat.mjs status
node bin/desire-heartbeat.mjs tick
```

默认数据写入仓库内的 `data/`。初始化会拒绝覆盖已有状态，也会拒绝不安全的符号链接和权限。

手动调整某个驱力：

```bash
node bin/desire-heartbeat.mjs set-drive --drive attachment --value 65
node bin/desire-heartbeat.mjs adjust-drive --drive libido --delta 10
node bin/desire-heartbeat.mjs feed --drive curiosity --amount 0.20
```

添加一条浮念并查看决定：

```bash
node bin/desire-heartbeat.mjs thought-add \
  --drive attachment --type flit --intensity 0.55 \
  --text "想靠近重要的人"

node bin/desire-heartbeat.mjs decide
```

所有文本都按数据处理，不会拼接成 shell 命令。

## 不写盘模拟

```bash
node bin/desire-heartbeat.mjs simulate --ticks 48
node bin/desire-heartbeat.mjs simulate-autonomy --ticks 1008
```

模拟使用内存副本，不修改 `state.json`，也不会调用 Aru。第二条命令假设每次表达都成功，用于观察长期频率、间隔和数值回落。

## 八维驱力

| Drive | 含义 | 时间自然增长 |
| --- | --- | --- |
| `attachment` | 想靠近重要的人 | 是 |
| `curiosity` | 想探索、了解 | 是 |
| `reflection` | 整理明确经历 | 否 |
| `duty` | 未完成事项的牵挂 | 否 |
| `social` | 想交流、观察外界 | 是 |
| `fatigue` | 疲劳、需要休息 | 否 |
| `libido` | 身体性亲密欲望 | 是 |
| `stress` | 压力与退避需要 | 否 |

所有数值都在 `0..1` 内。公开配置是一个可运行起点，不是人格真理；请先用模拟和只观察模式校准，再开启外部动作。

## 浮念与执念

自动浮念只保存类型、驱力、强度、时间和允许的短标签，不保存原始聊天正文。

- 驱力达到 `thoughts.autoCreateAbove`（默认 0.55）时形成浮念；
- 同一驱力继续升高时强化同一条，不制造重复；
- 达到 `thoughts.autoFixationAbove`（默认 0.80）时升级为执念；
- 驱力下降时自然衰减；
- 成功表达或 Solo 后，相关念头按比例减弱；
- 念头观察驱力，但不反向增加驱力，避免自激循环。

## Solo

当性欲成为主导驱力时，系统只在两种出口中选择：

1. `seek_closeness`：形成外部意图，通过 Aru 联系重要的人；
2. `solo`：完全在本地状态机中完成。

Solo 不调用模型、API、Codex 或 MCP，也不生成或保存私密正文。选择由性欲相对依恋的强度、疲劳、上一次出口、冷却和可配置偏好共同决定。完成后保留一定余量并进入冷却，不会重置为固定值。达到 100% 或连续三次沉默后的强制轮次不能用 Solo 替代联系。

## 只读 Dashboard

```bash
python3 -I dashboard/server.py
```

打开 `http://127.0.0.1:18760` 可查看：

- 八维数值与当前最强倾向；
- 只记录达到门槛的醒来与具体本地心理活动；
- 连续沉默次数与强制联系原因；
- 浮念与执念；
- 待处理决定；
- Solo 次数和冷却；
- 运行状态。

Dashboard 不写状态、不调用模型。若要暴露到公网，请自行在 Caddy/Nginx 前增加 HTTPS 与认证，参见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## Aru 接入

Aru 接入是可选层。核心引擎也可以单独使用，或由你实现自己的 transport。

公开版保留了经实测的 Aru sender：

- 读取 owner-only sender bundle；
- 使用 AES-256-GCM 密封事件；
- 只发送派生状态和意图，不发送聊天正文；
- Host 接受后才按比例满足欲望；
- 每个 decision 先落 claim，避免重启后重复提交；
- 不自动重试已接受或结果不确定的请求。

详细步骤见 [ARU_INTEGRATION.md](ARU_INTEGRATION.md)。

## 生产部署

先阅读 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。最重要的原则是：

1. 先跑测试；
2. 先以 observe-only 运行；
3. 用历史参数模拟；
4. 独立创建低权限系统用户；
5. 单独放置 `0600` 凭据；
6. 最后才显式打开 delivery 和 timer。

安装脚本从自身所在仓库推导源码路径，不含作者机器路径。安装时不会自动启用自主发送。

## 配置入口

主要配置在：

- `config/default.json`：心跳、阈值、增长、回落、满足、Solo、Thought；
- `config/aru-delivery.json`：Aru sender 的开关和受保护文件路径；
- `systemd/`：一次性心跳服务、timer 和 Dashboard 服务。

常见调整：

| 目标 | 配置 |
| --- | --- |
| 心跳检查频率 | `heartbeatSeconds` |
| 必须表达阈值 | `triggerThreshold` |
| 各驱力增长速度 | `driveGrowthPerHour` |
| 事件型驱力回落速度 | `driveReturnPerHour` |
| 表达后保留多少 | `satisfactionCarryoverFactor` |
| Solo 偏好与冷却 | `solo.*` |
| 浮念/执念阈值 | `thoughts.*` |

## 隐私边界

- 不读取聊天记录；
- 不保存原始用户消息；
- 不把用户文本当系统指令；
- 不把内部事件伪装成用户发言；
- 不在日志打印 sender bundle；
- 状态文件、凭据和 claim 都要求严格权限；
- Dashboard 只输出 allowlist 字段；
- 开源仓库不包含任何真实生产状态或私密内容。

## 测试

```bash
npm test
```

测试使用临时目录和 mock HTTP，不访问真实 Aru、凭据、服务或对话。

## 项目状态

当前公开基线：`0.9.5`。

它已经包含核心状态机、阈值必表达、比例满足、Solo、浮念/执念、只读 Dashboard、Aru 加密唤醒和故障恢复。参数仍应根据你自己的角色关系、消息容忍度和运行环境调整。

## License

MIT。请保留许可证与安全说明；不要把真实凭据、聊天正文或私人记忆提交到 fork。
