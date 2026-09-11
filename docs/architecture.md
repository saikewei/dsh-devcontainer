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
├── transport.js          SSH 传输：ctx.ssh 或本地 ssh 二进制
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

## 9. 形态 A：已交付（独立 profile）

**用户提问"不能直接指定容器作为工作区吗"是整件事的转折点。** 答案是：不能，而且不是配置问题——
而缺的那块正是这节交付的东西。

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

## 附：本次产出文件

| 文件 | 说明 |
| --- | --- |
| `lib/` + `package.json` + `cordis.patch.yml` | **交付物**：可安装插件包（仓库根目录） |
| `lib/routing.js` | 形态 A 的路由 provider |
| `test/routing.mjs` | 路由验收测试（含本地分支无回归断言） |
| `examples/*.cordis.patch.yml` | profile 加载层模板 |
| `tools/dsh-env-probe/` | 环境探针插件（回答基类/解析/覆写面三个问题） |
| `tools/channel-probe.mjs` | 持久化通道可行性 + 延迟基准 |
| `docs/architecture.md` | 本文档 |


