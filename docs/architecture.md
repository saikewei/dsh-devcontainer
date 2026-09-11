# DSH 远程 Dev Container 开发能力 — 侦察结论与架构决策

> 状态：**垂直切片已跑通**（2026-09-11）。传输层与容器内工具链已取得可运行证据。
> 下一步：固化为可安装插件包（方案见文末）。

---

## 1. 目标

让本机 DSH 能够直接在远程 NAS 上的 Docker dev container 内做开发——命令、读、写、改、搜索都作用在容器里，用的是容器内的真实工具链。

## 2. 已探明的环境事实

### NAS（SSH 别名 `nas`，Tailscale 直连）

| 项目 | 值 |
| --- | --- |
| 系统 | Linux 6.1.27 / x86_64，**UGREEN DX4600**（ugos，`ughomeusers` 组） |
| Docker | 26.1.0 + Compose v2.26.1 |
| 用户权限 | `saikewei` 在 `docker` 组（gid 121）→ **docker 免 sudo** |
| 存储 | `/home` 7.2T，可用 2.0T |
| 文件共享 | SMB 运行中（6×smbd）；NFS 守护进程在跑但 **`/etc/exports` 是空模板，未配置任何 export** |
| devcontainer CLI | **未安装** |

### 目标 dev container（已存在，非本次创建）

| 项目 | 值 |
| --- | --- |
| 容器名 | `epic_mirzakhani`（VS Code Dev Containers 生成） |
| 镜像 | `vsc-shutterseek-6e1a3b72...-uid`（3.81 GB） |
| 宿主路径 | `/volume1/docker/ShutterSeek` |
| 容器路径 | `/workspaces/ShutterSeek`（bind mount） |
| devcontainer.json | `/volume1/docker/ShutterSeek/.devcontainer/devcontainer.json` |
| Features | common-utils:2, git:1, **go:1**, **node:1** |
| 容器内身份 | `root`，hostname `2cd1e7193d24`，Debian 12 (bookworm) |
| 工具链 | **Go 1.25.11**, **Node v22.23.1**, git |
| 额外挂载 | `/photos`(ro), `/photos_uploads`(rw), `/go`, `/home/vscode/.{codex,claude,npm}` |
| 项目 | Go 模块 `shutterseek`，分支 `dev`（领先 origin/dev 13 个提交） |

### 本机（macOS）

* 无 sshfs、无 macFUSE、无 FUSE 库（`brew` 可用）
* SSH 密钥 `~/.ssh/id_ed25519`
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
| SMB 挂载（macOS 原生客户端） | NAS 侧 SMB 在跑，本机无需 kext。但挂到的是**宿主路径** `/volume1/docker/ShutterSeek`，而容器视角是 `/workspaces/ShutterSeek`，还要加上 `/go`、`/usr/local/go`、`/home/vscode/*` 等容器独有路径。路径翻译会成为永久税 |
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
| list（29 项） | 7 ms |
| read（3289 B） | 7 ms |
| write + rename | 7 ms |
| grep 全项目往返 | 45 ms |
| **对比：每次独立 ssh+docker exec** | **320–340 ms** |
| 一次性建链成本 | 870 ms |

**约 42× 提升。** 传输层风险已退役。

## 7. 垂直切片：已跑通的证据

以**动态 Cordis Host 插件**（`devc-1`）实现，走官方 `ctx.subprocess` seam（动态 Host 里没有 `process`/`child_process`，必须经此 seam）。注册 8 个模型工具：`devc_status` / `devc_exec` / `devc_read` / `devc_write` / `devc_edit` / `devc_ls` / `devc_grep` / `devc_glob`。

**在 DSH 内实际调用得到的证据：**

```
devc_status →  hostname 2cd1e7193d24 / in_container=yes
               go1.25.11 linux/amd64 / node v22.23.1 / x86_64

devc_exec   →  ## dev...origin/dev [ahead 13]
               M .gitignore
               go build ./...  →  go build OK   (1m23s, 真实全量编译)
               go vet ./...    →  干净

devc_read   →  go.mod，3289 bytes / 82 行，带行号
devc_glob   →  cmd/**/*.go  →  cmd/gen/main.go, cmd/server/main.go
devc_grep   →  func main  →  cmd/gen/main.go:14, cmd/server/main.go:29
```

这证明的不是"能连上容器"，而是**DSH 里的一次工具调用，真的驱动了 NAS 上容器内的 Go 工具链完成了一次全量编译**。

### 切片过程中发现并修掉的两个真问题

1. **`spawn ENOENT`**：`SubprocessSpawnSpec.argv` 是**含程序名的完整 argv**，首元素必须是 `'ssh'` 而非第一个选项。
2. **容器环境真实缺陷**：容器以 `root` 运行，而 bind mount 目录在 NAS 上属主是 `saikewei`，git 报 `detected dubious ownership`，进而让**所有** `go build` 因 VCS stamping 失败。已用 `git config --global --add safe.directory /workspaces/ShutterSeek` 修复。这是任何人在这个容器里都会撞上的坑，插件应当开箱处理。

### 已知待修项

* `devc_status` 报告的 `channel` 字段是**进入函数时**的状态，首次调用会显示 `disconnected` 而实际随后连接成功——属于显示 bug。
* helper 的 `grep`/`glob` 固定上限 250 行 / 200 路径，尚无分页。
* 尚无客户端 UI、无工作区注册、无容器生命周期管理。

## 8. 阶段二：已交付的插件包

**形态 B（增量能力包）已交付并安装。**

```
（仓库根目录 = npm 包本体）

lib/
├── index.js              插件入口：常驻通道 + 8 个 devc_* 工具 + 两种模式的装配
├── channel.js            常驻 JSON-lines 通道
├── helper.mjs            容器内常驻 helper（每次连接重写）
├── routing.js            形态 A 的路由 provider（继承 shipped 沙箱实现）
└── search.js             路径分派的 glob/grep
test/
├── config.mjs            测试目标配置（环境变量 / gitignored 本地文件）
├── boot.mjs              按 loader 的方式装载，验证 inject 解析 + 真实 registry 派发
├── routing.mjs           路由验收测试（含本地分支无回归断言）
├── registry.mjs          真实 dsh-tools registry 接受全部定义 + 逐工具实测
└── smoke.mjs             替身 subprocess seam 的独立冒烟测试
tools/                    诊断工具（channel-probe、dsh-env-probe）
examples/                 可直接复制的 profile 加载层
docs/                     architecture.md（本文档）
```

已安装进 `~/.dsh/profiles/web`（`dsh.profile.bundles` 现为 `[dsh-base, dsh-web-app, dsh-devcontainer]`），
`dsh --profile web --dump-config` 确认 `devcontainer` row 正确出现在组合树中。
**下次重启 `dsh web` 时激活。**

### 交付过程中解决的两个非显然问题

1. **profile 里没有 `@deepseek-ai/*`**。`~/.dsh/profiles/web/node_modules/@deepseek-ai/` 是空的——
   官方包从 DSH 自身安装目录解析。而 `dsh plugin add <本地路径>` 装的是**符号链接**，Node ESM 又从
   导入文件的**真实路径**解析裸标识符，于是任何带依赖的链接插件都会解析失败。
   → 解法：让包**零运行时依赖**，工具定义直接以普通 JSON Schema 注册到 `ctx.tools`（`ToolSchema`
   就是 `{name, description, parameters}`，`parameters` 是普通 JSON Schema，与 `defineTool` 的产物同形）。
   副作用是链接与拷贝安装行为完全一致。

2. **验证必须在重启之前完成**。重启用户的 DSH 会杀掉当前会话，而启动一个第二实例会与其
   sessions/storages 冲突。→ 用 `test/boot.mjs` 以真实服务复刻 loader 的装载路径
   （真实 `dsh-subprocess-local` + 真实 `dsh-tools` registry + 真实 `inject` 解析 + 真实
   `ctx.tools.execute()` 派发），在不启动任何服务的前提下取得等价证据。

### 三套测试结果

全部通过：`boot.mjs`（激活 + registry 派发到容器）、`registry.mjs`（8 个定义被真实 registry 接受 +
逐工具实测）、`smoke.mjs`（独立冒烟）。实测延迟：首次建链 790 ms，其后 5–40 ms/次。

### 安全语义（已在 README 明确写出）

命令以容器内的用户身份运行，**本机文件沙箱管不到容器内部**——沙箱约束的是本地文件效果，
而这些效果不在本地。容器本身及其 SSH 访问权就是能力边界。审批提示不会为容器内副作用弹出。
参考容器挂载了 `/photos`(ro) 与 `/photos_uploads`(rw)，这一点值得用户知情。

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

**本地挂载点**：DSH 工作区必须是宿主上的真实目录，所以用一个本地目录（`~/.dsh/devcontainer/ShutterSeek`）
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
  2cd1e7193d24              ← 容器 hostname
  IN_CONTAINER              ← /.dockerenv 存在
  go version go1.25.11 linux/amd64
  /workspaces/ShutterSeek   ← 容器路径（不是挂载点）

read  (file_path = 挂载点/go.mod):
  工具自身报告路径为 /workspaces/ShutterSeek/go.mod
  1: module shutterseek
  3: go 1.25.0
```

**没有任何 `devc_*` 前缀，也不需要向模型解释。**

四套测试全绿：`boot.mjs` / `routing.mjs` / `registry.mjs` / `smoke.mjs`。

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


