# DeepSeek Chat

参考豆包聊天页实现的本地 Web 界面，通过服务端代理连接 TokenHub / X-API 的 OpenAI Chat Completions 接口。

## 启动

需要 Node.js 22.12+（已在 Node 26.7.0 验证）。

```sh
npm install
cp .env.example .env # 仅首次安装，已有 .env 时不要覆盖
# 编辑 .env，填写网关、模型和 Key
npm run build
npm start
```

打开 http://127.0.0.1:3210/chat 。本次已将用户提供的测试环境写入本机 `.env`，无需重复配置。该文件已加入忽略规则，权限为 600。

开发时执行 `npm run dev`，访问 http://127.0.0.1:5173/chat ，Vite 会将 `/api` 代理到 3210 端口。

## 模型配置

```dotenv
TOKENHUB_BASE_URL=http://YOUR-GATEWAY:8080/v1
TOKENHUB_MODEL=deepseek-flash
TOKENHUB_API_KEY=YOUR_KEY
PORT=3210
```

- 截图中的 X-API 网关模型 ID 为 `deepseek-flash`，上游 TokenHub 模型为 `deepseek/deepseek-flash`。
- Base URL 应包含 `/v1`，不要包含 `/chat/completions`，程序会追加该路径。
- 网关 Key 只在服务端使用；`GET /api/config` 不返回 Key。
- `.env` 的模型配置在每次请求时读取；修改 `PORT` 后需重启。
- 右上角「模型设置」支持临时配置。Key 保留在服务端内存，重启后回到 `.env` 配置；切换网关必须填写新网关的 Key。
- 普通模式发送 `thinking: { type: "disabled" }`；深度思考发送 `enabled`。多轮消息保留模型真实返回的 `reasoning_content`。
- 输出预算为 `max_tokens: 200000`（包含推理输出）；流式空闲超时为 3 分钟，持续收到内容时自动续期。
- 创建任务使用固定任务 ID 幂等重试，进度订阅自动重连；不会因刷新或订阅失败重新调用模型。上游模型本身断流后可手动继续生成或重新生成。

## 功能

流式回复、深度思考折叠区、多轮上下文、保留原稿的重新生成、停止生成（同时取消上游请求）、Markdown / 代码块 / 表格、本机历史记录、搜索、删除确认、复制、Markdown 导出、文本文件输入、写作快捷入口、工作模式、移动端侧栏。

对话和推理内容按会话保存到浏览器，并自动备份到本机服务端 `.data/conversations/`，通过原子写入保留磁盘副本。服务重启后可恢复，多个页面会同步更新；浏览器存储空间不足时继续使用服务端保存。旧版 localStorage 记录自动迁移，原始旧记录保留，单条坏记录不会清空其余记录。工作模式通过系统提示词帮助拆解任务和生成文本，不执行外部工具、操作系统命令或定时任务。

生成由本机服务持有，任务状态与进度保存在 `.data/runs/`。刷新或关闭页面只断开进度订阅，后台仍生成并保存；重新打开后按任务 ID 和序号自动接回同一次任务。订阅有 15 秒心跳、45 秒无响应检测和退避重连，恢复时发送最新完整快照，不会重复拼接正文。点击「停止生成」才取消任务。服务进程退出后原上游连接无法继续，重启会保留正文并明确标记中断，不自动发起新模型请求。升级前已经中断的旧回答需点击一次「继续生成」，新任务才具备刷新自动恢复能力。

## Skills

点击侧栏「技能库」或输入框下方「技能」，搜索、预览 `SKILL.md`，点击「在当前对话使用」。也可输入 `/技能名 你的任务`，输入 `/` 时会显示命令建议。

选择按会话保存，刷新仍保留；新建会话不会继承其他会话技能。输入框上方显示当前技能，可查看或取消。每条技能回答保留技能标识，重新生成使用原问题绑定的技能。

默认按顺序读取以下目录内的 `名称/SKILL.md`：

- 项目 `.claude/skills/`、`.agents/skills/`、`skills/`
- 个人 `~/.claude/skills/`、`~/.codex/skills/`、`~/.agents/skills/`
- `.env` 中 `SKILL_DIRS` 配置的额外目录，多个目录使用系统路径分隔符（macOS/Linux 为冒号）

新增或修改技能后点击刷新按钮；`SKILL_DIRS` 改动后重启服务。技能目录可为符号链接，按真实目录去重。YAML 头部支持名称、描述、`argument-hint`、`allowed-tools`、`user-invocable`；禁止手动调用的技能会隐藏，格式错误会显示加载诊断。`$ARGUMENTS` 替换为本轮任务文本，不执行技能内的动态命令。

服务端根据技能 ID 读取真实文件并加载指引。只有手动选中的技能会发送给模型，不会把整个本地技能库发给网关。DeepSeek 可调用 `read_skill_file` 按需读取所选技能目录内的文本参考，网页显示实际读取记录。禁止目录穿越、隐藏文件和指向技能目录外的符号链接；单个参考文件上限 48KB，最多 4 轮模型调用。

当前支持文本指引和技能参考只读工具，不执行 Bash/Python、写入项目文件、Hooks、子代理、MCP 或技能要求的外部插件操作。`allowed-tools` 等字段用于展示原技能的要求，不为宿主授予额外执行权限。平台内置/插件技能及其工具不会自动迁移到这个独立网页。

## 代码结构与边界

| 路径 | 用途 |
| --- | --- |
| `web/src/main.tsx` | React 聊天界面与会话状态 |
| `web/src/styles.css` | 豆包风格布局与响应式样式 |
| `server/conversations.mjs` | 按会话原子持久化、版本合并与删除标记 |
| `web/src/conversationStore.ts` | 多页面同步、旧记录迁移、浏览器与服务端保存状态 |
| `server/app.mjs` | 本地 API、配置、OpenAI 流代理、静态文件服务 |
| `server/completion.mjs` | 旧流接口与后台任务共用的模型、推理和技能工具调用 |
| `server/runs.mjs` | 幂等后台生成、任务快照持久化、订阅与显式取消 |
| `web/src/generationClient.ts` | 创建任务、事件序号恢复、心跳检测与订阅重连 |
| `server/skills.mjs` | 本地技能发现、YAML 解析、技能指引和参考文件边界 |
| `server/skill-tools.mjs` | 只读参考工具与流式调用参数拼接 |
| `web/src/SkillsDialog.tsx` | 技能搜索、预览、目录来源和选择 |
| `shared/sse.js` | 增量 UTF-8 / CRLF SSE 解析 |
| `tests/api.test.mjs` | 模拟网关的回归测试 |
| `tests/live.mjs` | 实际网关的三轮调用验证 |
| `docs/research/doubao/` | 参考观察记录、页面截图与验证结果 |
| 原有 `src/` | 保留原 CLI 源码 |

原目录仅提供了 CLI 的 `src/`，没有 package manifest、完整内部依赖、构建入口和可执行程序。本次新增独立可运行的 Web 工程与模型接入层，未声称原 CLI 的工具执行、权限系统、终端、MCP 已迁移到浏览器。本地聊天已可独立运行。

## 验证

```sh
npm run build     # TypeScript 检查与生产构建
npm test          # 网关协议、取消、异常、敏感字段回归
npm run test:live # 真实网关调用，使用 .env，产生实际模型用量
npm run test:live:skills # 真实模型技能指引 + 参考读取，含普通和思考模式
```

`test:live` 不输出 Key。它验证普通流式回复、上下文记忆、深度思考、usage 和 `[DONE]`。浏览器验证与结果见 `docs/research/doubao/implementation.md`。

默认仅监听本机 `127.0.0.1`，适用于个人本地使用。

聊天页底部显示保存状态。“已保存到本机服务”表示服务端磁盘副本已写入；服务暂不可用时保留浏览器副本并重试，不清空历史。重新生成会追加一个新版本，保留旧回答；后续发送只将最新成功回答作为上下文。

长回答按批次更新，生成中先显示文本，结束后自动排版 Markdown；已完成回答不会因输入或历史同步而重复解析。连接中断或主动停止后，已有正文的最后一条回答可点击「继续生成」，将保存的正文作为上下文请求模型续写并追加到原回答。这是一次新的模型请求，可能产生额外用量，不是原连接的字节级断点重传。
# claude_agent
