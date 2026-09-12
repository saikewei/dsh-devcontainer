# DSH 远程 Dev Container 开发能力 — 侦察结论与架构决策

> 状态：**垂直切片已跑通**（2026-09-11）。传输层与容器内工具链已取得可运行证据。
> 下一步：固化为可安装插件包（方案见文末）。

---

## 1. 目标

让本机 DSH 能够直接在远程 NAS 上的 Docker dev container 内做开发——命令、读、写、改、搜索都作用在容器里，用的是容器内的真实工具链。

## 2. 已探明的环境事实

### 目标主机（x86_64 Linux NAS）

下表只保留**影响架构决策**的事实。侦察原记录里的机器型号、存储容量、共享服务进程数、用户与组 id 等已删除——它们不构成论据，只会暴露一台具体的私有机器。

| 项目 | 值 |
| --- | --- |
| 系统 | Linux / x86_64 |
| Docker | 已装，该用户**免 sudo** |
| 文件共享 | SMB 可用；NFS 守护进程在跑但 **`/etc/exports` 是空模板，未配置任何 export** |
| devcontainer CLI | **未安装** |

### 目标 dev container（已存在，非本次创建）

| 项目 | 值 |
| --- | --- |
| 容器名 | `my-project-devcontainer`（VS Code Dev Containers 生成） |
| 宿主路径 | `/volume1/docker/my-project` |
| 容器路径 | `/workspaces/my-project`（bind mount） |
| devcontainer.json | `<宿主路径>/.devcontainer/devcontainer.json` |
| Features | common-utils:2, git:1, **go:1**, **node:1** |
| 容器内身份 | `root`，Debian 12 (bookworm) |
| 工具链 | **Go 1.25.x**、**Node v22.x**、git |
| 额外挂载 | 若干只读数据卷、一个可写上传卷，以及 `/go`、`/home/vscode/.{codex,claude,npm}` 等容器独有路径 |
| 项目 | 一个普通 Go 项目，bind mount 自宿主的项目目录 |

### 本机（macOS）

* 无 sshfs、无 macFUSE、无 FUSE 库（`brew` 可用）
* 一把常见的 SSH 密钥（`~/.ssh/`）
* 本地**没有 docker**

## 3. 生态现状：已有插件 vs. 空白

检索了 npm registry、GitHub `dsh-plugin` topic 与多份 awesome 列表。**不存在任何 Docker dev container 方案**。

| 插件 | 范式 | 与目标的差距 |
| --- | --- | --- |
| [`dsh-ssh/dsh-ssh`](https://github.com/dsh-ssh/dsh-ssh) | seam 级远程路由，bash/file/search 跑在远程 | SSH 到**宿主机**，不是容器 |
| [`flymysql/dsh-remote`](https://github.com/flymysql/dsh-remote) | 外挂 20 个 `rw_*` 工具 + SFTP 镜像同步 | 工具名不同；镜像与冲突管理是长期负担 |
| [`chai1110/dsh-ssh-remote`](https://github.com/chai1110/dsh-ssh-remote) | 上述的多机分支 | 同上 |
| [`tangjunyi1/dsh-remote-workspace`](https://github.com/tangjunyi1/dsh-remote-workspace) | 把整个 agent 经 SSH stdio 跑在服务器 | 需要在远程装 dsh；不是你本机这套配置 |
| [`6Mikao9/dsh-wsl-workspace`](https://github.com/6Mikao9/dsh-wsl-workspace) | **架构最接近的先例**：继承 `dsh-fs-local`、用 `wsl.exe` 做 shell、派生 preset 变体 | 只支持**本地** WSL；依赖 `\\wsl.localhost` 这个本地挂载 |
| [`STARDUSTLC666/dsh-docker`](https://github.com/STARDUSTLC666/dsh-docker) / `dshoneys/dsh-docker` | docker 容器**管理**工具（ps/logs/exec…） | 是运维工具，不是开发工作区 |

**结论：这是生态空白。**

## 4. 决定性架构约束

读 `@deepseek-ai/dsh-base` 的宿主 composition 后确认：

```
根平面（进程全局，不在任何 isolate realm）：
  subprocess   → dsh-subprocess-local   提供 ctx.subprocess
  sandbox      → dsh-sandbox-local
  bash-sandbox → dsh-bash-sandbox       提供 ctx.shell     ← shell 的提供者
  fs-sandbox   → dsh-fs-sandbox         提供 ctx.fs        ← fs 的提供者
  tool-bash / tool-fs / tool-fs-search  （消费者）
```

`ctx.fs` 与 `ctx.shell` 都是**宿主平面、单实例**服务（"one implementation per context; loading a second throws"）。

**关键推论**：`ctx.fs` 不能被 agent preset 私有化。它的消费者远不止工具——`workspaceRegistry`（`create()` 会走 `fs.realpath`）、`skill-filesystem`、`agent-instructions`、`workspaceFiles`（侧栏文件浏览器）**全都在宿主平面消费它**。把 `fs` 塞进 preset 的 isolate realm 会把这些宿主消费者全部饿死。

这直接排除了"照抄 dsh-wsl-workspace"的捷径——WSL 方案之所以只换 shell，是因为它**复用了本地挂载**（Windows 侧 `\\wsl.localhost` 9P 共享），fs 根本不用换。而远程容器没有本地挂载。

因此，远程容器支持的唯一正确位置是**宿主 composition 的一行**，且该 provider 必须是**多工作区路由**的（单个服务，按路径前缀分派），与 `dsh-fs-sandbox` 按 `workspaceRoot` 逐调用施加策略是同一模式。

## 5. 传输层：为什么不用本地挂载

| 方案 | 评估 |
| --- | --- |
| SSHFS / macFUSE | 本机没有，且 macOS 上要装内核扩展 + 重启 + 降低安全启动等级。**代价过高** |
| SMB 挂载（macOS 原生客户端） | NAS 侧 SMB 在跑，本机无需 kext。但挂到的是**宿主路径** `/volume1/docker/my-project`，而容器视角是 `/workspaces/my-project`，还要加上 `/go`、`/usr/local/go`、`/home/vscode/*` 等容器独有路径。路径翻译会成为永久税 |
| NFS | 未配置 export，且 uid/gid 映射在 macOS 上麻烦 |
| **协议级后端（选定）** | 不挂载，直接讲容器自己的语言。执行世界就是容器，路径就是容器路径，没有翻译层 |

## 6. 核心工程问题：持久化通道

朴素的 `ssh nas docker exec` 每次调用要 **320–340 ms**（Tailscale 往返 + SSH 握手 + 容器启动开销）。一轮对话动辄几十次 read/write，直接不可用。

解法：**一条 SSH 连接 + 容器内一个常驻 helper，讲 JSON-lines RPC**。

实测（`tools/channel-probe.mjs`，每项 20 次）：

| 操作 | 中位延迟 |
| --- | --- |
| ping | 8 ms |
| exec: true | 8 ms |
| exec: pwd | 8 ms |
| stat | 7 ms |
| list | 7 ms |
| read | 7 ms |
| write + rename | 7 ms |
| grep 全项目往返 | 45 ms |
| **对比：每次独立 ssh+docker exec** | **320–340 ms** |
| 一次性建链成本 | 790–870 ms（多次测量区间） |

**约 42× 提升。** 传输层风险已退役。

## 7. 垂直切片：已跑通的证据

以**动态 Cordis Host 插件**（`devc-1`）实现，走官方 `ctx.subprocess` seam（动态 Host 里没有 `process`/`child_process`，必须经此 seam）。注册 8 个模型工具：`devc_status` / `devc_exec` / `devc_read` / `devc_write` / `devc_edit` / `devc_ls` / `devc_grep` / `devc_glob`。

**在 DSH 内实际调用得到的证据：**

```
devc_status →  hostname a1b2c3d4e5f6 / in_container=yes
               go1.25.x linux/amd64 / node v22.x / x86_64

devc_exec   →  git status --short --branch   →  在容器内读到该仓库的分支状态
               go build ./...  →  go build OK   (1m23s, 真实全量编译)
               go vet ./...    →  干净

devc_read   →  go.mod，带行号
devc_glob   →  cmd/**/*.go  →  cmd/gen/main.go, cmd/server/main.go
devc_grep   →  func main  →  cmd/gen/main.go:14, cmd/server/main.go:29
```

这证明的不是"能连上容器"，而是**DSH 里的一次工具调用，真的驱动了 NAS 上容器内的 Go 工具链完成了一次全量编译**。

### 切片过程中发现并修掉的两个真问题

1. **`spawn ENOENT`**：`SubprocessSpawnSpec.argv` 是**含程序名的完整 argv**，首元素必须是 `'ssh'` 而非第一个选项。
2. **容器环境真实缺陷**：容器以 `root` 运行，而 bind mount 目录在宿主上属主是**另一个 uid**，git 报 `detected dubious ownership`，进而让**所有** `go build` 因 VCS stamping 失败。用 `git config --global --add safe.directory <容器路径>` 可以就地修复。这是任何人在这种容器里都会撞上的坑，README 单列了一节说明。

### 已知待修项

* `devc_status` 报告的 `channel` 字段是**进入函数时**的状态：首次调用会显示 `idle (connects on first use)`，而它随后的探针其实已经连上了。属于显示口径问题，不是连接问题。
* helper 的 `grep`/`glob` 固定上限 250 行 / 200 路径，尚无分页。
* 当时尚无客户端 UI、无工作区注册、无容器生命周期管理。**这三项后来都已交付**：工作区选择器（`lib/client.js` + `lib/browse.js`）、`autoWorkspace` 登记，以及 `devc_containers start`。

## 8. 阶段二：已交付的插件包

**形态 B（增量能力包）已交付并安装。**

```
（仓库根目录 = npm 包本体）

lib/
├── index.js              插件入口：工具注册 + 两种模式的装配 + 启动诊断
├── channel.js            常驻 JSON-lines 通道（每目标一条）
├── helper.mjs            容器内常驻 helper（每次连接重写）
├── transport.js          SSH 传输：本地 ssh 二进制（唯一后端）
├── hosts.js              解析 ~/.ssh/config，得到可选主机名册
├── discover.js           文件夹 → 容器：Docker label + inspect 的 bind mount
├── browse.js             /dsh-devcontainer 的 JSON API（config / list / prepare）
├── routing.js            形态 A 的路由 provider（继承 shipped 沙箱实现）
├── search.js             路径分派的 glob/grep
└── client.js             客户端半边：工作区选择器（无构建步骤，loader bundle 格式）
test/                     十一套：config 之外，六个无容器 + 五个需要真实容器
tools/                    诊断工具（channel-probe、dsh-env-probe）
examples/                 可直接复制的 profile 加载层
docs/                     architecture.md（本文档）
```

安装方式是 `dsh plugin --profile <name> add dsh-devcontainer`，随后重启该 profile；bundle 自带
composition row，但 row 里的值是**占位符**，需要按 README 的安装一节填成你自己的主机与容器。

### 交付过程中解决的两个非显然问题

1. **profile 目录里原本没有 `@deepseek-ai/*`**（后来 DSH 增加了 `$DSH_HOME/profiles/node_modules`
   这个共享安装目录，才不成立）——当时官方包从 DSH 自身安装目录解析。而 `dsh plugin add <本地路径>` 装的是**符号链接**，Node ESM 又从
   导入文件的**真实路径**解析裸标识符，于是任何带依赖的链接插件都会解析失败。
   → 解法：让包**零运行时依赖**，工具定义直接以普通 JSON Schema 注册到 `ctx.tools`（`ToolSchema`
   就是 `{name, description, parameters}`，`parameters` 是普通 JSON Schema，与 `defineTool` 的产物同形）。
   副作用是链接与拷贝安装行为完全一致。

2. **验证必须在重启之前完成**。重启用户的 DSH 会杀掉当前会话，而启动一个第二实例会与其
   sessions/storages 冲突。→ 用 `test/boot.mjs` 以真实服务复刻 loader 的装载路径
   （真实 `dsh-subprocess-local` + 真实 `dsh-tools` registry + 真实 `inject` 解析 + 真实
   `ctx.tools.execute()` 派发），在不启动任何服务的前提下取得等价证据。

### 当时的测试结果（当时三套，现为十一套）

全部通过：`boot.mjs`（激活 + registry 派发到容器）、`registry.mjs`（8 个定义被真实 registry 接受 +
逐工具实测）、`smoke.mjs`（独立冒烟）。实测延迟：首次建链约 0.8 s，其后 5–40 ms/次。这些数字是当时那条链路（家用 NAS + Tailscale）的实测值，不代表你的环境。

### 安全语义（已在 README 明确写出）

命令以容器内的用户身份运行，**本机文件沙箱管不到容器内部**——沙箱约束的是本地文件效果，
而这些效果不在本地。容器本身及其 SSH 访问权就是能力边界。审批提示不会为容器内副作用弹出。
参考容器还挂载了几个与项目无关的卷（只读数据卷、可写上传卷），这一点值得用户知情：容器内的
写操作同样落在这些挂载上，而本机沙箱看不到它们。

### 下一步（未做）

形态 A：为宿主平面的 `ctx.fs` 与 `ctx.shell` 实现路由 provider，让现有 `bash` / `read` /
`write` / `edit` / `glob` / `grep` 透明地在容器内工作，并让工作区、侧栏文件浏览器、skills
一并理解容器路径。**通道与 helper 完全复用，不返工。**

---

## 9. 形态 A：已交付（单 profile）

**用户提问"不能直接指定容器作为工作区吗"是整件事的转折点。** 答案是：不能，而且不是配置问题——
而缺的那块正是这节交付的东西。

> 标题里的"独立 profile"曾是必要的：形态 A 早期要在 composition 里关掉三个 row，所以必须有一套
> 专用 profile。路由下沉到工具层之后这个前提消失了——路由按会话生效、不替换任何全局服务，因此
> 一套 profile 就够，多的那套已合并（见附四末）。

### 侦察阶段排除的错误路径

| 想法 | 为什么不行 |
| --- | --- |
| 直接注册容器路径为工作区 | `workspaceRegistry.create()` 走 `realpathNormalize()` + `node:fs` 的 `stat()`，**完全绕开 `ctx.fs`**。容器路径在 Mac 上不存在，注册必然失败 |
| 照抄 dsh-wsl-workspace 只换 shell | WSL 之所以只换 shell，是因为它复用了本地挂载（`\\wsl.localhost`）；远程容器没有本地挂载，fs 必须一起换 |
| 给 fs/shell 做包装器 | `SandboxedFileSystem extends LocalFileSystem`、`SandboxBashExecutor extends LocalBashExecutor`——是**子类不是包装器**。包装会重复实现沙箱语义 |
| SSHFS / NFS 本地挂载 | 本机无 macFUSE（需内核扩展+重启+降安全等级）；NAS 的 NFS 未配 export。且挂载拿到的是宿主路径，容器独有路径（`/go`、`/usr/local/go`）仍不可达 |

### 最终架构

```
FileSystem   → LocalFileSystem   → SandboxedFileSystem → RoutingFileSystem
ShellExecutor → LocalBashExecutor → SandboxBashExecutor → RoutingBashExecutor
```

**继承现有实现、只覆写需要分派的方法**，挂载点之外的路径全部 `super` 透传——本地分支的沙箱语义
一行都没重写，因而不可能漂移。验收测试显式断言了这点（工作区外的本地写仍被拒绝）。

**本地挂载点**：DSH 工作区必须是宿主上的真实目录，所以用一个本地目录（`~/.dsh/devcontainer/my-project`）
整体代表容器根。两种拼写归一到同一 target，工具回报的是**容器路径**（这样模型读到的和容器里 `pwd`、
`go build` 报的一致）。

**安全语义**：容器子树**故意**不走本地沙箱——`ctx.sandboxPolicy` 约束的是本地文件效果，容器内的写不是。
`dsh-sandbox` 自己的模块文档就是这么说的：*"Containers, microVMs, and remote execution replace the
surrounding capability seam instead."*

### 实施中撞到并解决的五个真问题

1. **Cordis 用 Proxy 包裹 service，`#private` 成员穿透不了**，报 *"Receiver must be an instance of class …"*（私有品牌校验失败）。→ 服务类里改用模块级函数。
2. **版本号字段不一致**：helper 的 `stat`/`list` 答 `size`，`write`/`edit` 答 `bytes`。把写入的 `bytes` 当成缺失的 size 会给每次新写入盖上 size 0 的版本，导致紧接着的带守卫编辑误报 `FS_STALE_VERSION`。→ 版本号同时读两个字段。
3. **profile 里没有 `@deepseek-ai/*`**（`node_modules/@deepseek-ai/` 是空的）。之前的担心不成立：探针实测 9 个 specifier 全部解析成功，DSH 的 loader internal 机制覆盖了嵌套解析。
4. **`writableRoots` 本来就包含 `/tmp` 与 `tmpdir()`**——测试里把"写 /tmp 被允许"误判成沙箱回归，实际是设计如此。
5. **后台任务的首个 chunk 会间歇性丢失**（真 bug，不是测试问题）。`start()` 原本在 `exec_start` **响应返回之后**才挂事件监听器；而 helper 把响应帧和首批 chunk 帧写进同一个 TCP 读，channel 的行循环会在同一个同步循环里处理完所有这些帧——那时 `.then` 还是尚未执行的微任务，于是 chunk 被当作无人认领的帧丢掉。是否复现取决于内核如何合并写入，所以表现为偶发。
   → 改为**通道级分派器**：首次启动容器进程时就注册常驻监听器，并为任何 `execId` 预先建缓冲（包括响应尚未读到的那些）。测试也相应加强为 5 轮无 sleep 的突发输出。

   这条值得单独记一笔：它正是那种最容易被当成"flaky 测试"而忽略的偶发失败。

### 整理成仓库时新增的一个认识

`npm install`（只为测试装 devDependencies）之后，仓库根出现了 `node_modules/@deepseek-ai/*`。由于 profile 里的插件是**指向本仓库的软链**，Node 会从模块真实路径解析——插件于是开始用**仓库这份**拷贝，而不是 harness 安装那份。两份版本相同、端到端实测也通过，但这意味着一个"活的"插件仓库会携带自己的一份 harness 包。详见 README 的 Design notes。

### 端到端验收证据

一次性 headless 会话（`dcheadless` profile），让模型用它**自己的**工具：

```
bash  (workdir = 挂载点):
  a1b2c3d4e5f6              ← 容器 hostname
  IN_CONTAINER              ← /.dockerenv 存在
  go version go1.25.x linux/amd64
  /workspaces/my-project   ← 容器路径（不是挂载点）

read  (file_path = 挂载点/go.mod):
  工具自身报告路径为 /workspaces/my-project/go.mod
  1: module my-project
  3: go 1.25.0
```

**没有任何 `devc_*` 前缀，也不需要向模型解释。**

测试全绿：`boot.mjs` / `routing.mjs` / `registry.mjs` / `smoke.mjs`。

### profile 布局（`web` 一行未改）

| profile | 用途 |
| --- | --- |
| `web` | 原有环境，未改动。含增量 `devc_*` 工具 |
| `devcontainer` | 路由模式，端口默认；工作区 = 挂载点 |
| `dcheadless` | 一次性会话验证夹具（无需浏览器即可回归验证路由） |

### 已知限制

* `resolve()` 对容器路径只做**词法**归一，不做 `realpath`（每次 resolve 走一个 RPC 帧代价太高），
  因此容器内的符号链接别名不会被折叠。
* `skill-filesystem` 用 `node:fs` 扫**本地**挂载点，看到的是空目录；只有 skill 正文经 `ctx.fs`。
* 挂载点路径与容器路径是两个字符串，靠 `prompt` section 告诉模型映射关系。

---

## 附二：设计说明（原 README「Design notes」，为精简 README 迁入）

以下每一条都是实现中撞到才发现的约束，写在这里以免下次重踩。

* **零运行时依赖是刻意设计，并且是可行的。** 除 Node 内建模块（`node:fs/promises`、`node:path`、
  `node:os`、`node:child_process`）之外，包不导入任何第三方模块；路由模块另外导入它所扩展的两个
  随包沙箱实现，搜索模块导入随包搜索模块以取得 ripgrep 路径。原因见上一节：profile 安装是符号
  链接，Node 从真实路径解析裸标识符，任何依赖都会解析失败。
* **同级 `node_modules` 会改变解析位置。** 跑了 `npm install`（只为测试存在）之后，插件会从*本
  仓库的* `node_modules` 解析 `@deepseek-ai/*`，而不是从 harness 安装目录。两份版本相同、端到端
  也验证过；但只用于部署的 checkout 应当删掉 `node_modules`，否则它会携带自己的一份 harness 包。
* **service 类里不能有私有成员。** Cordis 通过 `Proxy` 分发服务，`#private` 成员无法穿透 Proxy
  访问——私有 brand 检查会以 *"Receiver must be an instance of class …"* 失败。所以辅助逻辑一律
  放在模块级函数里，`RoutingFileSystem` / `RoutingBashExecutor` 自身没有 `#` 字段（`Worlds` 是
  普通辅助类，不受此限）。
* **版本 token 是 `mtimeMs:size`。** 读取与列举回的是 `size`，写入与编辑回的是 `bytes`；token 取
  两者中存在的那个。若把一次写入的字节数当成"缺失的 size"，每次新写入都会被盖上 size 0 的戳，
  进而让下一次带守卫的编辑误报 stale version。
* **通道自愈。** 掉线不是致命的：挂起的调用以可读消息 reject，下一次调用按需重连。
* **helper 每次连接都重写**，所以容器永远不会与插件漂移，容器里也无须预装任何东西。
* **所有副作用由 Fiber 持有**（`ctx.effect`），停止或更新插件会连带拆除通道、路由器与每个工具。
* **目录选择器 seam 是判别式能力。** `native` 后端提供 `pickDirectory()`；`browse` 后端只提供
  `list()`/`createDirectory()`，其界面是应用内对话框，插件 bundle 无法复现。因此客户端半边在
  占用 directory-flow hole 之前会先探测容器 API，**只把确定的 404 当作"未挂载"**——含糊的失败
  保留占用，避免一次瞬时抖动就悄悄弄丢可用的选择器。
* **两组存储默认共享，且都会泄漏。** `storage-json.root`（工作区注册表）与
  `session-persistence-jsonl.root`（会话日志）默认都在 `$DSH_HOME` 下、被所有 profile 共用。只
  隔离注册表不够：工作区消失了，对话却会落进 UI 的 **Ungrouped** 桶（"不属于任何工作区的会话"
  的去处）继续可见。两个根都要按 profile 覆盖。README 的「把容器世界挡在你的其它 profile 之外」
  一节给了可直接复制的 YAML。

---

## 附三：路由下沉到工具层（2026-09 架构转向）

早期形态 A 用 `RoutingFileSystem`/`RoutingBashExecutor` 替换宿主的 `ctx.fs`/`ctx.shell`，代价是必须在 composition 里关闭 `fs-sandbox`/`bash-sandbox`/`tool-fs-search` 三个 row。这让插件变成**启动路径上的必经环节**：只要插件不在（或用户显式禁用了它自己的 row），profile 就**没有文件系统**，harness 起不来。

### 为什么"替换服务"这条路在设计上就是死的

三条源码事实，逐条实测过：

1. **`provide()` 拒绝二次注册**：`if (this.store[key]) throw new Error('service "..." has been registered at <...>')`。
2. **`set()` 要求同一 fiber**：`if (impl.fiber !== this.ctx.fiber) throw ...` —— 无法跨插件改写别人的服务。
3. **patch 不能改 row 的 `name`**：`applyEntryPatches` 把 `name` 解构成**校验守卫**（不一致就 skip），不是可覆盖字段。所以"让 `fs-sandbox` 这一行自己加载路由实现"也不可行。

`isolate()` 同样救不了：官方工具注册在根作用域，服务解析不随 `agent.ctx` 隔离。

### 最终形态：按会话、在工具层

监听 `agent/created`；仅当 `agent.session.header.cwd` 落在镜像下时，在该 agent 的作用域下建一个**隔离领域** `agent.ctx.isolate('fs').isolate('shell')`，把**官方** `dsh-tool-fs` 与 `dsh-tool-bash` 挂进去——它们的 `ctx.fs`/`ctx.shell` 就是路由器。领域仍携带 agent 的 scope key（`isolate` 与 `createScope` 都是 `extend()`），因此它们的注册落进**该会话的工具层**并遮蔽全局定义。

于是：本地会话在任何注册之前 return（**结构性**保证，不是承诺）；不替换任何全局服务；不关闭任何 row；卸载即恢复。`@dsh-ssh/dsh-ssh` 是同一形态的生产先例，本实现照其配方。

`glob`/`grep` 仍归本插件：随包搜索工具经 `ctx.subprocess` 启动打包的本地 ripgrep，**任何领域都改不了它**。

### 代价（刻意接受）

只有那七个工具被路由。侧边栏文件浏览器（`dsh-api-workspace-files`）、技能发现（`dsh-skill-filesystem`）、`present`、`str_replace_editor` 等十多个直接读 `ctx.fs` 的消费者，对镜像工作区看到的仍是本地替身。这是"永不替换全局服务"的对价；容器内可达性由 `devc_*` 工具补足。

### 踩过的坑（供后来者）

* **测试里必须用同一份 `dsh-scope`**。`kScope = Symbol("dsh.scope")` 是模块内符号；npm 树与 npx 缓存各一份时，`createScope` 写进去的符号与 `dsh-tools` 读的不是同一个，scope 永远读成 `undefined`，注册静默落到全局层。这个假阴性花了很久才定位。
* **`agent/created` 是 emit**，handler 同步抛错会**否决 agent 发布**。全程 try/catch，日志代替报错。
* **被遮蔽的 `bash` 需要 job controller**：官方 `tool-bash` 只调 `ctx.jobs.start`，controller 由 `tool-jobs` 附加；preset 未装它时 `run_in_background` 会抛 "no job controller serves this agent"，需在 agent 作用域补 `jobs.attachController`。
* **官方工具包必须进仓库的 devDependencies**：profile 里插件是符号链接，Node 从真实路径解析 `@deepseek-ai/*`，因此运行时能解析的只有仓库 `node_modules` 里有的那些。

---

## 附四：世界判定不许猜（2026-09 竞态修复）

### 故障

镜像工作区里的一次性 headless 会话，`bash` 打出了 **宿主** 的主机名和 **宿主** 路径。日志显示会话确实被路由了（`session ... routed — cwd <镜像路径>`），只是世界选错了。

根因是时序：`Worlds.locate()` 是**同步**的（每次 fs/shell 调用都要先知道世界；官方 `ShellExecutor.resolve` 由契约规定为同步），所以它只能读一张表；那张表由 `refreshWorlds` 在 `ctx.inject(['workspaceRegistry'])` 之后填充，并且每 10 秒重扫一次。一次性会话在首扫完成前就发起了工具调用。

真正危险的不是竞态本身，而是**失败的方向**：表为空时 `locate()` 退回"镜像路径即宿主路径"的老规矩，**安静地返回宿主世界**。不报错、不告警，只是在错误的机器上执行——机器是对的，工具链和路径全错。

### 修法：占位符与判定分开

`locate()` 仍然同步，但对"镜像路径且尚无判定"的结果打上 `provisional: true`，明确标注**这是占位符，不是答案**。新增异步的 `Worlds.ensure(path)`：命中已有判定就直接返回；否则经 resolver 判定一次（单飞 + 缓存），再据判定结果回答；**判不出来就抛错**。

各调用点的落法：

* `RoutingFileSystem.resolve/lstat` 本就是 `async` —— 直接 `await ensure()`。失败翻译成 `FS_IO_ERROR`，**绝不回退到本地分支**。
* `RoutingBashExecutor.resolve` 是同步的，不能等。未判定的 spec 保留**本地拼写**并挂一个 pending 标记，`run`/`start` 在异步侧 `await ensure()` 后再算远端路径。`start` 的 handle 仍同步返回（请求在 promise 链里发出，各访问器读到的都是"尚未落地 = running"，这是真话）。
* `glob`/`grep` 的 `execute` 是 `async`，同样先 `await ensure()`；判不出来就明说，而不是对着空替身跑 ripgrep 然后回一句 "no matches"——那是关于它根本没看过的目录树的一个错误答案。
* `locate()` 的其余同步调用点（`processPathFromHostPath` 的附件显示映射、picker 的展示）只关心"路径在哪"，占位符无害，保持同步。

### 判定的粒度：文件夹，不是文件

第一版把"被问到的路径"直接当判定单位，随即撞上第二个坑：Dev Containers 把**工作区目录**写进 `devcontainer.local_folder`，所以 `docker ps --filter label=devcontainer.local_folder=<一个文件>` 永远匹配不到，只会回答"没有容器"——又一次安静的宿主降级。

于是 `DevContainers.folders()` 用**一条命令**取回整台机器的 label 索引，纯函数 `foldersContaining()` 在本地按**最长包含前缀**列出候选链；再按长度从长到短，对候选容器逐个做 `docker inspect`（按容器名缓存），取第一个真能承载该目录的——自己那个容器没把目录 bind mount 进去时，答案应该是上一级，而不是宿主。这比原先"每个工作区每 10 秒 3 条命令"更省，而且是路径级的：任意路径都能问。

判定结果记录在**产生它的粒度**上：容器判定记在它 label 的那个文件夹，覆盖整棵子树；"没有容器"的判定只记在被问的那条路径上——把整个目录记成宿主会遮蔽目录里真正的 dev container 项目，那它就再也找不到了。

已经记下的判定**不会被覆盖**。曾经写过"祖先判定取代后代判定"，那是错的：所有判定都出自同一份 label 索引，而 resolver 总是回答**路径上方最具体**的那个文件夹，所以更深的判定对属于它的子树只可能更准。把更深的那条丢掉，等于让嵌套项目走父容器的路径。这条规则靠 `test/worlds.mjs` 的「先决定后代、再决定祖先」顺序钉住——那正是会让错误实现看起来正确的顺序。

候选链是**从长到短**逐个试的：最具体的那个文件夹可能确实有容器，但那个容器没把它 bind mount 进去（`containerPath` 为空），此时正确答案是上一级文件夹，而不是宿主——因为该路径确实落在上一级的 bind mount 里。

`Worlds` 还从判定结果**反推容器根**（`#reindex()`），不再由外部单独喂入：把某条路径路由进容器、却认不出该容器自己的拼写，是一扇单向门——工具回报容器路径，模型原样传回来，而它必须能解析回去。

### 顺带纠正的两条旧注释

* `lib/search.js` 头部写着"调用方必须关闭随包 `tool-fs-search` row"——那是形态 A 的残留。现在这两个工具注册在 agent 作用域里遮蔽同名定义，本地会话根本不会走到它们。
* `refreshWorlds` 从"真相来源"降级为**预热**：`ensure` 让正确性不再依赖任何一遍扫描跑完。它保留下来只买两样东西——让模型首次调用通常不必等待，以及在无人触碰时发现某个目录后来有了容器。已判为容器的目录不再重探（一条 SSH 往返只能确认既有绑定），没有容器的目录才会重问。

### 验收

真实 headless 会话，四个方向各跑一遍：

| 会话 cwd | `bash` 结果 |
| --- | --- |
| 镜像工作区（有容器） | `2cd1e7193d24` / `/workspaces/ShutterSeek` / `IN_CONTAINER` |
| 路由会话内的 `read` / `glob` | 容器内 `go.mod`、容器内 `cmd/**/*.go` |
| 镜像目录（无容器），`workdir=` 指定 | `DX4600-73F2` / `/volume1/docker` / `NOT_CONTAINER` |
| 本地目录 | `macbook-air.…` / 本地路径 / 无路由日志 |

无容器环境里的三条防线：

* `test/worlds.mjs`——`locate` 的占位符必须带 `provisional`；`ensure` 单飞、缓存、失败不缓存、无 resolver 时拒绝；判定结果反推出容器根；祖先判定不覆盖后代判定；resolver 答非所问（folder 不含所问路径）时拒绝而不是相信。
* `test/route.mjs`（新增）——resolver 本身的规则：判定记在**文件夹**上、`--filter` 答不了的文件路径能答、嵌套取最具体、自身容器不可用时退到上一级而不是宿主、整台机器只读一次索引、问不到就抛。
* `test/dispatch.mjs` 「a path no pass has decided yet」——端到端钉死竞态：首次触碰自行判定并落进容器通道、宿主通道一次都没被问过、未判定的 shell spec 保留本地拼写、`start` 的 handle 先返回、判不出来时 fs 抛 `FS_IO_ERROR` 而 shell 回报拒绝、`glob` 既不跑本地 ripgrep 也不答 "no matches"。

每条新断言都做过变异测试（改实现看断言是否变红），其中两条最初**没咬住**：反推容器根的那条用了与 `containerRoot` 相同的路径（旧行为碰巧也对），改成一个 `containerRoot: '/'` 的实例才有效；「失败不缓存」原本测的是 `#settle` 而不是 `probeCache`，补了 `probeCache` 的直接用例，并为此把它导出——没有测试的保证只是注释。

### 收尾：两套 profile 合并成一套

`mountRoot` 为空时插件会填默认值 `$DSH_HOME/devcontainer/root`，而 `hasStandIn` 在赋值**之后**才算——所以 `web` profile 里那段"routing stays OFF here"的注释从工具层转向那一刻起就是假的：三个 profile 解析到的是同一个镜像根，路由一直是开着的。合并时把 `mountPoint`/`mountRoot` 显式写进 `web`，删掉 `devcontainer`（备份在 `~/.dsh/backups/devcontainer-profile-merged/`），并核对了合并前后共享工作区注册表的哈希一致——同时在跑的 GUI 持有它的内存副本，任何一次写入都可能覆盖磁盘。合并后 `web` 的 row 与 `dcheadless` 逐字节相同，而后者已被四个方向的真实会话验证过。

---

## 附五：端口转发为什么不是 `ssh -L`（2026-09）

VS Code 的端口映射，最直觉的实现是让 ssh 把本地端口转到容器端口：

```
ssh -N -L 8000:172.18.0.4:8000 nas     # 容器的网桥地址
ssh -N -L 8000:127.0.0.1:8000 nas      # NAS 自己的 loopback
```

**两条都不成立**，而且不是差一点。实测：

| 检查 | 结果 |
| --- | --- |
| 容器内 `ss -ltnp` | 真实服务**全部只绑 `127.0.0.1`**（uvicorn:8000，另两个 Python 服务），只有 docker 内嵌 DNS 绑在 `127.0.0.11` |
| NAS 上连 `172.18.0.4:8000` | **Connection refused** —— 服务根本没绑那个地址，不是防火墙问题 |
| 容器内 `net.connect(8000,'127.0.0.1')` | **成功**，而且是个活服务（HTTP 404） |

第二条正是 `ssh -L` 会做的事：sshd 在 NAS 的网络命名空间里发起连接，而容器的 loopback 在另一个命名空间里，永远够不着。第一条不行是因为服务压根没监听网桥地址。所以**连接必须在容器内部发起**——这也是 VS Code 能work的原因：它的 server 就跑在容器里。

### 做法：复用已有的常驻通道

helper 本来就在容器里跑，于是让它 `net.connect` 目标端口，字节走已经有连接的那条 JSON-lines 通道：

```
浏览器 → 本地 net.createServer → channel.notify({event:'relay_data',b64})
       → ssh stdin → docker exec stdin → helper → net.connect → 127.0.0.1:8000
```

- **每条 TCP 连接一个 relay**（`relayId`），互不排队，浏览器的并发请求才是并发的。
- **通知帧不带 `id`**：`relay_data` 是唯一一种主机→helper 且**不回帧**的消息。用 `request()` 的话每块数据都要配一个响应，等于把一条管道的流量翻倍。
- **两个方向都做背压**：helper 侧 `process.stdout.write` 返回 false 就 `socket.pause()` 等 `drain`；主机侧 `notify()` 返回 false 就 `socket.pause()` 等 `onceDrain`；helper 收到主机数据时若 socket 写满，则 `lines.pause()`——那会把背压一路传回浏览器。
- 端口探测（`ss -ltnp`，退回到 `/proc/net/tcp*`）**只返回原文**，解析放在主机侧 `lib/ports.js`：带边界情况的那一半因此可以用 fixture 测，不必依赖容器。

### 踩过的三个坑

1. **对端会在 relay 建好之前就开始说话。** 浏览器一连上就写请求，而 helper 要等 `relay_open` 往返回来才有 socket 可写——**先到的字节被丢弃，整个交互死锁**：请求没到，响应就永远不会来，调用方只看到一个光秃秃的超时。修法是 `relay_open` 之前 `socket.pause()`，成功后再 `resume()`，让字节留在 socket 自己的缓冲区里。这条有专门的回归断言（用一道闸门卡住 `relay_open`）。
2. **`pkill -f <path>` 会杀掉自己。** 执行它的那个 shell，命令行里就带着同一个字符串。加方括号（`dsh-fwd-probe[.]js`）只在模式没有以字面量出现在同一命令行里时管用——而同一个 exec 里紧接着的 `nohup node /tmp/dsh-fwd-probe.js` 正好让它失效。改成从 `ss -ltnp` 里读出占用端口的 PID 再 kill，精确且不可能误伤。
3. **Node 的 global agent 默认 keep-alive。** 测试里"停掉转发后端口应该拒连"一度失败：新请求复用了先前那条池化连接，于是拿到一个 200。`agent: false` 才是每次新连接。

### 边界

- 只做容器世界；NAS 宿主自身端口不在范围内。
- 默认只绑 `127.0.0.1`。改 `forwardBind` 是显式操作，面板和工具输出都会带上它。
- 转发不跨进程存活。开机要恢复的端口写进配置的 `forward` 列表，或打开 `forwardAuto`。
- 自动转发默认关闭：一条转发占的是操作者机器上的端口。

## 附六：前端打不开被改动的文件（2026-09）

### 症状

路由会话里 agent 改完文件，前端"本轮文件改动"的 chip 点不动——不报错，也不出内容。

### 根因

不是路径没被"引导"，而是**那条链路根本不经路由**。真实会话日志里，`read`/`write`/`edit` 收到的
`file_path` 是 `/workspaces/ShutterSeek/internal/service/cache.go`，即容器拼法。而：

```
chip 点击 → openFile(path) → 地址 dsh-resource://file/session/<sid>/<path>
          → 右侧栏文本预览 tab → remote.workspaceFiles.readAll
          → dsh-api-workspace-files 的 this.ctx.fs   ← 全局、未路由
          → 本机磁盘 → 那个路径在本机不存在 → 404
```

我们的路由在**工具层**，只遮蔽七个工具。`ctx.fs` 是全局单例，浏览器侧的一切文件读取都走它，
看到的是空的本地替身。

**决定性约束**：`dsh-client-ui-deliverables` 的 `mutationPath(name, argsRaw)` 直接
`JSON.parse` **模型的原始参数**取 `args.file_path`，全文**不引用 `locations`**。
所以 host 侧改写工具输出、或让工具报告别的路径，都改不了这一行显示什么。方向只能是反向的：
**让前端学会打开容器路径**。

### 接缝（均已读源码确认）

`dsh-client-ui-sidebar-right` 用 `ctx.reflect.provide("sidebarRightTabs", …)` 公开注册表，
且已有两个第三方（`documentpreview`、`files`）在用：

* 注册：`ctx.sidebarRightTabs.register({id, kind, patterns, priority, canOpen, title})`，`ctx.effect` 内可回收。
* 解析（`candidates(address)` 注释原文）：*ranked by priority band, then by the length of the
  pattern that matched, then by registration order*，且**跨所有 kind** 遍历。
* 档位：`RANKS = {extension: 3, builtin: 2, fallback: 1}`，默认 `extension`；文本预览是 `fallback`。
* **kind 不能共用**：`coexists()` 明确 *a fallback shares its kind with nothing*，抢 `kind:"text"`
  会直接抛。所以必须用独立 kind——而跨 kind 遍历让这没有副作用。
* 地址语法：`dsh-resource://file/session/<sid>/<encodePath(path)>`。
* pane 的 key 是 definition 的 **`id`**（不是 kind）；body 直接注册为 pane occupant，
  不需要 `children` 子槽（那是给"一个类型多种 viewer"用的）。

### 做法

1. **Host**：`GET /dsh-devcontainer/file`。路径**自己就能定目标**——`worlds.locate` 的最后两个循环
   已经把 `containerRoot` 当作已知根，所以原始容器拼法能解析回 `{host, world, container}`。
   浏览器不指定机器也不指定容器，因此它送来的东西无需被信任。
   先 `stat` 再读（`read` 会整文件载入）；超 2 MB 走 `read_b64` 有界窗口并标 `truncated`；
   二进制 415、不存在 404、通道失败 502——各自独立文案。
2. **Client**：注册 tab 类型，`kind` 独立、`priority: 'extension'`、`canOpen` 用**同一个根列表**
   否决非容器路径。根列表由 `/config` 的 `knownRoots` 提供，保证两侧不会各说各话。
3. 客户端若 `canOpen` 返回 false，地址回落到随包文本预览器——**本地会话行为逐字节不变**。

### 踩到的坑

`containerPathOfAddress` 第一版直接把 `rest.slice(separator)` 解码，结果绝对路径得到**双斜杠**
（`encodePath` 保留首个空段），前缀比较差一个斜杠，容器路径被误判为本地。
源码级断言抓不到这个——测试因此**真正加载了 bundle**（桩一个四方法的 React，`apply()` 不渲染），
对 `canOpen` 做行为断言。这是本轮唯一由测试暴露的设计错误。

另外 `coexists` 的 `fallback` 互斥是**抛异常**而不是"低优先级"，读起来像可以共存；注释里那句
"shares its kind with nothing" 才是权威。

### 查看器：两次走错，第三次才找对

**第一版**把内容塞进手写的 `<pre>`。能用，但折行、行号、分页、变更提示全丢了——等于在侧边栏里
塞了一个比原版差的查看器。

**第二版**改成把内容交给 `sidebar.right.tab.document` 槽，以为那就是"复用原版"。**这一步错了，
而且错在两处**：

* 那个槽**默认派发到 `TextBody`，而 `TextBody` 根本没有可见行号**。它的 CSS 只有
  `.dhJKeW_line{padding:0 10px}`，全文没有任何 `:before{content:attr(data-textpreview-line)}`——
  那个 `data-` 属性是**滚动定位用的 DOM 钩子，不是数字**。当时 README 里写的"行号是原实现的"
  是错的，已更正。
* 整条委托链（`ctx.get('documentPreviews')` → `renderSlot` → keyed 派发）**没能确认生效**，
  于是静默落到自家 `<pre>`，看起来就和第一版一样。

**真正带行号和高亮的是另一个 occupant**：`CodeBody`。它渲染

```js
primitives.CodeBlock({ code, lang: languageForPath(path), lineNumbers: true,
                       copyLabel, copiedLabel, streaming: !content.eof, contentRef })
```

`CodeBody` 本身只是它外面一层很薄的壳（加 `data-code-preview` / `data-wrap`）。

**第三版（现行）**：不走槽，**直接要那个组件**。`@deepseek-ai/dsh-client-ui-primitives` 由 app
shell（`dsh-web-frontend`）提供，是任何客户端 bundle 都能按名字 `require` 的运行时模块，已有几十个
随包插件这么用（声明在 `dsh.client.inject` 里）。于是：

* 行号、语法高亮、复制按钮、滚动全是原实现的——因为**就是同一个组件**。
* 不再依赖 `documentPreviews` 服务可达性、槽派发、keyed entryKey 这三个不确定环节。
* `require` 包在 try/catch 里：取不到就退回自家 `<pre>`，文件仍可读。

**语法表**是原版那张表（26 种语言）的副本——它没被导出。注意高亮器要的是**语法名**（`typescript`），
不是后缀（`ts`）；直接传后缀就是"渲染了但不高亮"的典型错法。

**折行**通过该 block 读的 `--dsl-code-block-line-white-space` 自定义属性驱动，设在自己的滚动容器上。
选择器写成 `.dshDc_fileScroll.dshDc_fileWrapped`（双类，特异性 0,2,0）以压过它自己的
`.<hash>_code pre`，否则谁赢取决于样式表插入顺序。

顺带：客户端测试因此升级成**真正的渲染**——桩 React 是一个迷你 hook 运行时（hook 槽数组 + effect
收集 + `createElement` 返回普通对象），`require` 桩按模块实例返回或不返回 primitives，于是
"用 `CodeBlock` 且 `lineNumbers: true`"和"没有 primitives 时退化"两条分支都是**跑出来**验证的。

**变异测试本身也踩了一个坑**：最初的变异脚本用 `String.replace`（只替换第一处），而
`lineNumbers: true` 在注释里也出现过一次——变异打在注释上，等于没变异，报了两条假 MISS。
改成全局替换后，9 条变异全部咬住。

### 真机验证抓到的两个 bug（单测没覆盖）

1. **超限二进制绕过了二进制守卫。** helper 只在整文件 `read` 上拒绝二进制；超 2 MB 走的是
   `read_b64` 窗口，那条路径**没有任何守卫**。实测容器里 48 MB 的 `server` ELF 返回 **200 +
   一屏乱码**——正是守卫存在的理由。修法：对窗口用同一个判据（NUL 字节）。单测补了
   "超大二进制 → 415 且不携带 text"。
2. **`knownRoots` 重复。** `#reindex` 故意同时种入配置的 `containerRoot` 与解析出的同名映射
   （配置必须能在任何发现发生前作答），于是对外暴露的列表里同一个根出现两次。`locate` 只需要
   命中，无所谓；但把列表转发给浏览器就不对了。在 getter 里按 `host|path` 去重。

两个都是**只有在真实容器上打这条路由**才会暴露的——`/tmp` 里造个假 channel 不会。这是本轮
最值得记的一条：host 路由的验收必须打到真机上。

### 仍未修（同类"路径被当作本地"）

| 面 | 原因 |
| --- | --- |
| 侧边栏**文件树** | 根就是空替身，需要目录代理 + 懒物化 |
| `present` 工具 | 声明经 Session 文件系统解析 |
| `@` 文件引用 | `dsh-file-reference-local` 本地解析 |
| 技能发现 | `node:fs` 遍历本地挂载点 |
| **`fs-observation-policy`** | 它只听全局 `fs/*` 事件；路由读写不经过 `ctx.fs`，**策略被静默旁路**——这是安全相关分歧，不是显示问题 |

## 附七：宿主边界与 ssh 目标的两道闸（2026-09）

有人问"容器工作区是不是也有权限执行容器外的宿主机命令"。查下来答案是**是，而且有三条路**——
顺带发现工具侧的 ssh 目标**完全没有闸门**。

### 三条到宿主的路

1. **`devc_host_*` 四个工具**（`hostTools: true` 默认开）。它们注册在插件 ctx 上，是**全局**的——
   连本地会话也有。本会话就是活证据：cwd 是本地仓库，工具列表里照样有 `devc_host_exec`。
2. **路由本身**：`worlds.locate()` 对镜像下解析成 `world: 'host'` 的路径，让被影子化的
   `bash`/`read`/`write` 直接在宿主上执行。容器工作区只是让 cwd 落在容器那棵子树里，
   **没有把宿主路径排除掉**——`capabilityText` 也是这么告诉模型的。
3. **传输层就是 `ssh <host>`**，用操作者自己的 ssh 配置，所以权限 = 那个 ssh 用户的权限。

### 沙箱为什么不拦

`RoutingBashExecutor extends SandboxBashExecutor`，但 `run()` 里：

```js
const marked = spec[REMOTE_WORLD]
if (marked === undefined) return super.run(spec)   // 只有本地路径走到这里
// 远端分支直接 channel.request(...)，从不调用 super.run()
```

所以 `dsh-bash-sandbox` / `fs-sandbox` **只看得到本地路径**。远端（容器与宿主）命令一律不过沙箱。

### 发现的问题：工具侧的 ssh 目标是直通的

`browse.js` 的注释明确把 `-oProxyCommand=…` 列为威胁，并为此加了 roster 校验：

> It becomes an argv element for the `ssh` binary, where a leading `-` is parsed as an OPTION —
> `-oProxyCommand=…` runs a local command

但**工具侧没有这道防御**：`registerHostTools` 的 `pickHost` 是直通，`RemoteTransport.#destination()`
只拒绝空串。实测（假 ssh，只回显 argv，未真执行）：

```
ssh -T -o BatchMode=yes -o ServerAliveInterval=15 -o ConnectTimeout=10 \
    -oProxyCommand=touch /tmp/… true
```

真实 ssh 会把 `-oProxyCommand=…` 当选项解析，`ProxyCommand` 在**本机**执行。也就是说：
**一个工具参数就能在本机执行任意命令**，不需要 `bash`。

同一个字符串还有第二条来源：镜像路径的第一段就是机器名（`mountRoot/<host>/…`），
而那个名字同样可以是 `-oProxyCommand=…` 形状的目录名。**两条来源都被同一个闸门覆盖。**

### 修法：两道闸，各管一件事

* **`RemoteTransport.#destination()`** —— 拒绝以 `-` 开头的目标。这是**安全**闸，放在 argv 之前
  的最后一步，所以不管字符串来自工具参数还是镜像路径都被覆盖。选择**拒绝**而不是净化：
  没有任何合法 ssh 别名以短横开头，而 ssh 也没有 `--` 来终止自己的选项解析。
* **`pickRosterHost(cfg, requested)`** —— 工具参数必须落在本 profile 提供的名单里
  （`~/.ssh/config` + `extraHosts` + 配置的 `sshHost`），也就是工作区选择器展示的同一份。
  这是**策略**闸。名单读不出来时**不当成空名单**：配置的 host 仍然作答，其余拒绝并附上原因。

接进 `pickRosterHost` 的有六处：`devc_host_exec/read/write/ls`、`devc_containers`、`devc_forward`
（顺带确认了 `devc_forward` 的 `host` 参数确实生效，不是被忽略）。`devc_host_exec` 原先在
`catch` 里**又解析一次 host**，host 非法时那一次自己会抛并逃出处理器——改成持有已解析的 channel。

### 刻意**没有**改的

镜像路径里的机器名**不做 roster 校验**。`mountRoot` 的设计就是"机器名是第一段，所以任何宿主目录
都能成为工作区，不需要登记映射"；加校验等于把这个特性删掉。那个名字不在 ssh 配置里时，ssh 自己
会失败、判定抛错、调用**大声失败**——与"失败不是答案"的既有原则一致。真正危险的形态（看起来像选项）
已经由上面第一道闸挡住。

### 顺带发现：四个宿主工具的**报错路径从来没工作过**

改这条闸的时候真机跑了一遍，`devc_containers` 的失败返回是：

```
tool "devc_containers" returned invalid output: value is not lossless JS
```

`registerHostTools` 里的 `report` 是**柯里化**的：

```js
const report = (channel) => (error) => '[dsh-devcontainer error] ' + ...
```

而它的五个 catch 里有**四个**写成 `report(error)`——单次调用返回的是**内层箭头函数**，
于是工具失败时返回一个函数，注册表序列化失败，报出一条既不说工具也不说原因的错。
只有 `devc_host_exec` 用的是正确的 `report(channelFor(...))(error)`（而它在 catch 里又解析一次
host，host 非法时那一次自己会抛并逃出处理器）。

这是**既有 bug**，不是这次改出来的；是这次改动让这条路径更容易被走到才暴露。五个 catch 现在统一
持有已解析的 channel 并走 `report(channel)(error)`；`devc_containers` 解析的是 target 而非 channel，
显式写 `report(undefined)(error)`（helper 本来就容忍）。

`test/hosts.mjs` 新增 5 条断言，把**每个**宿主工具都推过它自己的失败路径——happy path 全绿，
这是唯一能咬住它的写法。

### 验收（ssh 目标）

`test/hosts.mjs` 新增 13 条断言：名单的接受/拒绝/trim/空参数语义、配置读不出来时的行为，
以及用一个**假 ssh 记录 argv**证明被拒的目标**根本没有 spawn**——没发生的 spawn 不可能被执行成
ProxyCommand。5 条变异全部咬住。

## 附八：与 dsh-ssh 解耦（2026-09）

问的是"用了多少 dsh-ssh 的东西，能不能解耦"。查下来：**零声明依赖，一段从未执行的运行时分支**。

### 清点

| 位置 | 量 |
| --- | --- |
| `package.json` 的 deps/peer/devDeps | **0** |
| profile 的 `dsh.profile.bundles` / `dependencies` | **0** |
| `transport.js` 里因它存在的代码 | **71 行**（全文 276 行） |
| 构造点 | `lib/index.js` 一处 + 4 个测试 |

耦合本身只是一个软查找：`this.#ctx.get('ssh')`，由 `#ctxSshHost` 是否等于本 transport 的 host
把关。没装 `dsh-ssh` 就返回 `undefined`，走 spawn `ssh`——本机一直如此。

### 为什么删而不是留作可选加速

它**从来没有执行过**。而且它是**按"存在与否"自动选中**的：挂了 `dsh-ssh` 的部署会拿到这段
没人跑过的代码，其余部署拿到另一段。`#runtime()` 还是二选一——一旦它返回了个"存在但行为不同"
的对象，**不会回退**到 spawn，而是直接失败。

拆掉会失去的，说得准确一点只有一条：**只在该插件自己的 registry 里配置的主机，以及密码认证的
主机**。我们 spawn 的是 `ssh -o BatchMode=yes`，没有回答密码提示的途径。其余都打平或更好——
ProxyJump 在 OpenSSH 配置里本来就支持（destination 交给真的 `ssh`），host key 走 OpenSSH 自己的
known_hosts，而连接复用本来也只发生在每个 (host, world, container) 的一条常驻通道上。

### 改了什么

* `RemoteTransport(ctx, host, ctxSshHost)` → `RemoteTransport(host)`；删掉 `#ctx`、`#ctxSshHost`、
  `#runtime()`、`backend` getter，以及 `collect()` 与 `open()` 各一个分支。
* `describe()` 一并删掉：它只回答"哪个后端应答的"，只剩一个后端后无话可说，且全仓库无调用者。
* `withTimeout()` 一并删掉：它存在是因为另一条分支的 `client.exec` 没有自己的超时；现在每条路径
  都 spawn 进程并自带定时器。
* **276 行 → 178 行。** 5 个构造点与 `test/discover.mjs` 的 `backend` 断言随之更新——那条断言
  改成检查 transport 报出的机器名，不再是恒真的 `=== 'ssh' || === 'ctx.ssh'`。

### 保留的一处引用

`lib/agent-hook.js` 里仍写着 *"The pattern is the one `@dsh-ssh/dsh-ssh` ships and documents"*。
那说的是**路由形态的出处**，指的是 `@dsh-ssh/dsh-ssh`（提供 `ctx.sshPool`）——与本次删掉的
`ctx.ssh`（来自另一个包 `dsh-ssh`）不是同一个。这是文献引用，不是依赖，留着。

## 附：本次产出文件

| 文件 | 说明 |
| --- | --- |
| `lib/` + `package.json` + `cordis.patch.yml` | **交付物**：可安装插件包（仓库根目录） |
| `lib/routing.js` | 路由 provider（世界判定 + fs/shell 路由器） |
| `lib/agent-hook.js` | 按会话在工具层挂载官方工具包（形态 A） |
| `lib/discover.js` | dev container 发现：label 索引、容器描述、候选文件夹链 |
| `lib/route.js` | 世界判定 resolver + 会话级分类（本地/宿主/容器） |
| `lib/search.js` | `glob`/`grep`：容器内走通道，本地走随包 ripgrep |
| `lib/browse.js` + `lib/client.js` | 工作区选择器（远程/本机两个选项卡）、端口面板、容器文件预览 tab |
| `test/browse.mjs` | 选择器 + `/file` 路由的单元测试（伪通道，无容器） |
| `test/client.mjs` | 客户端 bundle 的加载式断言（桩 React，含 `canOpen` 行为） |
| `examples/profile.cordis.patch.yml` | profile 加载层模板 |
| `lib/channel.js` | 常驻 helper 通道：帧协议、握手校验、终态清理、通知帧与背压 |
| `lib/ports.js` | 端口转发：监听端口解析 + 转发管理器（每条连接一个 relay） |
| `test/ports.mjs` | 转发与解析的单元测试（伪通道，无容器） |
| `test/worlds.mjs` | 世界映射与 `ensure` 判定的单元测试 |
| `test/channel.mjs` | 通道帧协议与终态路径的单元测试（伪 transport） |
| `test/route.mjs` | 世界判定 resolver 的单元测试 |
| `test/dispatch.mjs` | 无容器的世界分发测试（含解析竞态） |
| `test/routing.mjs` / `test/discover.mjs` / `test/smoke.mjs` | 需要真实容器的验收测试 |
| `tools/dsh-env-probe/` | 环境探针插件（回答基类/解析/覆写面三个问题） |
| `tools/channel-probe.mjs` | 持久化通道可行性 + 延迟基准 |
| `docs/architecture.md` | 本文档 |


