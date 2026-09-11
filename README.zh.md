# dsh-devcontainer

[English](README.md) | 中文

直接在**远程机器上的 Docker dev container** 里开发，由 DeepSeek Harness 驱动。

容器就是执行世界：命令、文件读写与编辑、grep 和 glob 全部在容器内运行，用它自己的工具链、走它自己的路径。容器里**不需要预装任何东西**——插件自带 helper，并在每次连接时把它复制进去。

```
dsh（你的笔记本）  ──ssh──▶  宿主  ──docker exec──▶  dev container  ──▶  你的项目
```

两种模式，可以叠加：

| 模式 | 你得到什么 | 对 harness 的影响 |
| --- | --- | --- |
| **工具模式**（默认） | 一组 `devc_*` 工具，直接用容器内路径寻址 | 纯增量——不改动任何东西 |
| **路由模式** | harness **原有的** `bash`、`read`、`write`、`edit`、`glob`、`grep` 对挂载点下的路径在容器内执行 | 替换 `ctx.fs` 与 `ctx.shell`；需要独立 profile |

真正让容器"像一个工作区"的是路由模式：没有 `devc_` 前缀，不需要向模型解释任何东西，侧边栏文件浏览器和工作区注册表也一并跟随。

## 为什么要常驻通道

最直观的实现——每次工具调用都跑一次 `ssh host docker exec …`——在典型 Tailscale 链路上要 **320–340 ms**（SSH 握手 + 启动容器 + 往返）。而一个对话轮次轻易就会发出几十次文件操作，这个代价无法接受。

本插件改为保持**一条 SSH 连接**，其上承载容器内**一个常驻 helper 进程**，彼此用 JSON-lines RPC 通信。同一条链路上实测每次操作：

| 操作 | 常驻通道 | 一次性 `ssh docker exec` |
| --- | --- | --- |
| `exec`（空命令） | 8 ms | 320–340 ms |
| `stat` / `list` / `read` | 7 ms | — |
| `write`（原子写） | 7 ms | — |
| 全项目 `grep` | 45 ms | — |

首次建链约 870 ms，延迟到第一次调用时才付出。

## 两个执行面

插件经 SSH 抵达远程机器，可以在**两个世界**之一执行工作：

| 执行面 | 是什么 | 工具 |
| --- | --- | --- |
| **host** | 远程机器本身——项目目录所在处，也是 Docker 运行处 | `devc_host_exec`、`devc_host_read`、`devc_host_write`、`devc_host_ls`、`devc_containers` |
| **container** | dev container，经 `docker exec` 抵达 | `devc_status`、`devc_exec`、`devc_read` 等 |

host 面是刻意做小的。开发发生在容器里；host 面是用来"看看有什么、决定接入什么"的。在路由模式下，这两者会按路径收敛成一个世界——见[安装 — 路由模式](#安装--路由模式)。

### SSH 层是独立的，但在 `ctx.ssh` 存在时搭它的车

一套传输、两个后端，由部署实际装配了什么决定，而不是靠配置开关：

* **`ctx.ssh`**——当部署装载了 [dsh-ssh](https://github.com/UynajGI/dsh-ssh) 的共享连接所有者时使用。它带来一个已认证的 ssh2 客户端，自带 `~/.ssh/config` 解析、主机密钥策略、ProxyJump 与 keepalive。
* **本地 `ssh` 二进制**——回退路径，也是本插件**零依赖**的原因。交给 OpenSSH 去执行，就免费继承了你的 `~/.ssh/config`、密钥、agent 和跳板机。

调用方永远不知道是哪一个应答的；其上的通道协议完全一致。

### 发现 dev container，而不是构建它

由 `.devcontainer` 启动的容器本身就是自描述的——Dev Containers 会在它身上写 `devcontainer.local_folder=<宿主目录>`，Docker 也记录了把该目录映射进容器的 bind mount。所以对于一个**已经存在**的容器，**不需要实现 `devcontainer up`**：

```
folder /volume1/docker/my-project
   │  docker ps --filter label=devcontainer.local_folder=/volume1/docker/my-project
   ├─▶ container my-project-devcontainer  (running)
   │  docker inspect … --format '{{range .Mounts}}…'
   └─▶ container path /workspaces/my-project
```

`devc_containers` 回答的正是这件事，可以针对单个目录，也可以列出宿主上所有 dev container。它同时会报告该目录究竟有没有 `.devcontainer`。

它**刻意不做**的是*构建*容器。把 `.devcontainer` 变成一个运行中的容器意味着 Dockerfile 构建、Features、`mounts`、`runArgs` 和 `postCreateCommand`——那是 `@devcontainers/cli` 的职责，不是插件的。已经存在的容器会被接入；已停止的用 `docker start` 启动；带 `.devcontainer` 但尚无容器的目录会被如实报告，在 VS Code 里打开一次或跑一次 `devcontainer up` 它就会出现。

## 前置条件

* **dev container 已经在远程宿主上运行。** 本插件接入容器，不构建也不创建容器。VS Code Dev Containers 生成的容器可直接使用。
* **到该宿主的 SSH 访问权**，用你自己的 `~/.ssh/config`——插件调用 `ssh`，所以别名、密钥、agent、跳板机和 Tailscale 的行为与你终端里完全一致。
* **非交互 SSH 必须可用**：`ssh <host> true` 必须无提示成功。
* **容器内有 `node`**（任意现代版本即可——它负责运行 helper）。dev container 镜像几乎都自带；若没有，`devc_status` 会告诉你。
* **宿主上你的 SSH 用户有 Docker 权限**（`docker exec` 免 `sudo`）。

不需要：本地 Docker、macFUSE、sshfs、任何形式的本地挂载，或 `devcontainer` CLI。

## 安装 — 工具模式

```sh
dsh plugin --profile web add dsh-devcontainer              # 从 npm 安装
dsh plugin --profile web add /path/to/dsh-devcontainer     # 或用本地 checkout
```

bundle 自带 composition row，所以*安装*本身无需手改任何文件——但这个 row 到手时是**未配置**的，必须指向你的机器才能工作。把下面这段加进 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: devcontainer
  config:
    sshHost: my-nas                      # 你自己 ~/.ssh/config 里的别名
    container: my-project-devcontainer   # 该宿主上一个已在运行的容器
    containerRoot: /workspaces/my-project
    hostRoot: /volume1/docker/my-project # 可选；同一目录在宿主上的样子
    tools: true
    provideFs: false
    provideShell: false
    prompt: false
```

patch 会**整体替换** `config` 对象，所以要改某个键就把需要的键全部重述一遍，而不是只写改动的那一个。重启该 profile；启动日志会点名仍然缺失的键。之后你会得到八个 `devc_*` 工具，用容器内路径寻址——见[工具](#工具)。

## 安装 — 路由模式

路由会替换两个**宿主平面**的服务，所以给它一个独立 profile，别动你日常用的那个：

```sh
# 1. 从随包的 web 模板派生一个独立 profile
dsh --profile devcontainer --from-default-profile web --dump-config

# 2. 装插件
dsh plugin --profile devcontainer add dsh-devcontainer

# 3. 复制示例 patch 并填入你自己的值
cp examples/devcontainer.cordis.patch.yml ~/.dsh/profiles/devcontainer/cordis.patch.yml
$EDITOR ~/.dsh/profiles/devcontainer/cordis.patch.yml
```

`examples/devcontainer.cordis.patch.yml` 是完整的 patch，值得读一遍而不是照抄。除上面那份配置之外，它还做三件事：关闭被路由器取代的三个随包 row（`fs-sandbox`、`bash-sandbox`、`tool-fs-search`）；打开 `provideFs`/`provideShell`/`provideSearch`/`prompt`；以及给该 profile **独立的工作区与会话存储**，让容器的工作区和对话不渗进你的其它 profile。最后一条在实践中不是可选项——见[把容器世界挡在你的其它 profile 之外](#把容器世界挡在你的其它-profile-之外)。

然后启动它：

```sh
dsh --profile devcontainer
```

用"新增工作区"登记一个项目，之后照常工作：bash、read、write、edit、glob 和 grep 全部在容器内执行。

`web` profile 占用默认端口 3080，所以两个 profile 要同时运行就得有一个让位；上面的 patch 因此把 `webserver.port` 固定到 3099。命令行上的 `--port` 仍然优先。

### 三个世界，以及任意多台机器

DSH 工作区必须是**真实的本地目录**——工作区注册表用 `node:fs` 的 `realpath` 做规范化，而它永远看不到远程机器。于是用本地**替身**代替，一条路径会落到三个世界之一：

```
/Users/you/.dsh/devcontainer/root/nas/volume1/docker/my-project/x.go   （mountRoot：宿主 `nas`）
/Users/you/.dsh/devcontainer/my-project/x.go                           （mountPoint：该项目）
        ↕
        nas:/volume1/docker/my-project/x.go                            （宿主）
        ↕  bind mount，从 Docker 发现
        /workspaces/my-project/x.go                                    （容器）
```

`mountRoot` 是一棵**镜像所有可达机器文件系统**的子树，以**机器名**作为第一段，因此仅凭前缀就能从替身还原出是哪台机器、哪条路径——这正是"任意宿主上的任意目录都能成为工作区、而无需在任何地方记录映射"的原因：

```
mountRoot + '/' + host + hostPath  =  替身
```

机器名必须在里面：多台机器可以持有同一条路径，而 `/etc/hosts` 在每台上都是不同的文件。

`mountPoint` 是指向容器路径的显式一对一配对，用于你事先就配置好的项目。二者可以任配其一，也可以都配。

**镜像工作区最终落在哪个世界是"判定"出来的，不是配置出来的。** 目录会拿去和 Docker 自己的 label 比对；如果某个容器是由它创建的，该工作区就*在那个容器内*、按 bind mount 给出的路径抵达。否则走宿主。这个判定按定时器完成、而非每次调用——因为每一次文件系统与 shell 操作都需要先知道世界才能行动。

因此目标键会携带它的世界（`host:<path>` / `container:<path>`）：同一条路径在两台机器上都存在，而 `/etc/hosts` 在各自那里是不同的文件。包含关系的判定只在一个世界内才有意义。

### 可选哪些机器

这份名单就是操作者自己的 `~/.ssh/config`，在 DSH 所在机器上读取。其中的 `Host` 别名成为选择器的机器下拉项；通配与取反模式（`Host *`、`Host *.example.com`）会被跳过，因为它们并不指向任何具体机器。`extraHosts` 用来补充不在该文件里的目标，而 `sshHost` 永远可选——哪怕它两个地方都没出现，因为别名也可以是一个裸主机名或地址。

这里不需要理解任何密钥材料：命令执行时，由 OpenSSH 自己去解析它被配置的别名、身份文件、端口和跳板机。

### 从宿主上挑选工作区

随包的"新增工作区"流程本身不选目录。它声明一个 **directory-flow hole**，然后向注册在该空洞上的占用者索要一条绝对宿主路径。本插件同时占用两个空洞（侧边栏浏览器与空白会话的 hero 选择器），提供两个选项卡：

* **远程容器**——从名册中选一台**机器**，浏览它的目录，并标出每一个含 `.devcontainer` 的目录。选中一个即解析整条链路并交回替身路径。
* **本机**——直接交还给部署自己的目录选择器，不做任何改动；那是 DSH 所在机器上的目录。

对话框总是从**远程容器**打开，且每次交互都从干净状态开始。本机选择器只在点击时启动，取消它会回到对话框、选项卡仍然可用——它绝不终结整个流程，所以一次取消不会卡死下一次。对话框内唯一的退出方式是你主动要求的那个：取消、Escape，或选中一个目录。

对话框刻意借用随包目录选择器的设计语言——同样的宽度、行高与字号档——并且只用 `--dsw-alias-*` 主题 token 着色，因此在浅色和深色模式下都与周边 UI 一致。唯一刻意的差异是高度：本对话框 520px，随包选择器 500px。

目录列举与登记走的是**纯 POSIX shell**，而不是常驻 helper，因为 helper 是一个 Node 脚本，而选择器必须能在任何可经 ssh 抵达的机器上工作——包括完全没有 Node 的机器，那同样是放项目的好地方。更"重"的 `devc_host_*` 工具确实使用 helper，并且在宿主没有 Node 时直说，而不是抛出一个 `exit 127`。

选择器浏览的是宿主而不是容器，因为因果方向就是如此：目录是项目，dev container 是从它派生出来的执行环境。列举每层花两次调用，而不是每个条目探一次——一层可能有几十个目录，逐条探测就是逐次往返。

选择器只出现在配置了替身的 profile 里。那些正是能路由容器路径的 profile，也是这类工作区唯一有意义的地方——见[把容器世界挡在你的其它 profile 之外](#把容器世界挡在你的其它-profile-之外)。

browse API 是 loopback web 服务器上 `/dsh-devcontainer` 之下的一小块 JSON 接口（`config`、`list`、`prepare`）。只要配置了替身它就会注册——也仅在此时，因为替身正是让容器目录变得可寻址的前提。

只装插件、不配替身的 profile（纯工具模式）不提供该 API，客户端半边会先探测它，再决定是否占用 directory-flow hole。这次探测比看上去重要：目录选择器 seam 是一个**判别式能力**，`native` 后端应答 `pickDirectory()`，而 `browse` 后端为应用内浏览器提供列举原语、本 bundle 无法复现。手上没有可提供的东西却占住空洞，会挤掉唯一能渲染 `browse` 部署的组件。让位则让部署自己的选择器留在原位，与没装本插件时一模一样。只有确定的 `404` 才算"不存在"；含糊的失败保留占用，因此一次瞬时抖动不会悄悄弄丢一个可用的选择器。

### 把容器世界挡在你的其它 profile 之外

DSH 工作区必须是真实的本地目录，所以路由 profile 必然会登记一些离开路由器就毫无意义的路径——`/Users/you/.dsh/devcontainer/root/nas/volume1/docker/proj` 是一个真实但**空**的目录，代表某条容器路径。

默认有两个根被所有 profile 共享，而它们都会泄漏：

| 根 | 默认值 | 泄漏什么 |
| --- | --- | --- |
| `storage-json.root` | `$DSH_HOME/storages` | 工作区注册表（`workspace.json`）。在此登记的一个替身会出现在无法路由它的 profile 里，打开后什么都没有。 |
| `session-persistence-jsonl.root` | `$DSH_HOME/sessions` | 会话日志。在这里开始的对话会一直留在无法路由它的 profile 中可见——而且由于不再有工作区可归属，它会落进 **Ungrouped** 桶，那正是"不属于任何工作区的会话"的去处。 |

给每个路由 profile 各自的根：

```yaml
- id: storage-json
  config:
    root: !!js dshHomePath('profiles/devcontainer/storages')

- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('profiles/devcontainer/sessions')
```

只隔离注册表是不够的，而且这个失败很难察觉：工作区从其它 profile 消失了，但对话没有，它只是挪到了 Ungrouped。如果你此前一直在共享注册表下运行，请把名字以替身路径前缀开头的日志目录（`--Users-you-.dsh-devcontainer-root-…--`）移进该 profile 自己的 `sessions` 根；其余目录属于本地工作区，应当留在原地。

两个存储都从"空"开始，所以一个路由 profile 起初是空侧边栏、空对话列表：把你想要的工作区在那里重新加上。隔离本身就是目的——两个世界不再看见彼此的工作——所以**新注册表要从空开始，而不是把 `$DSH_HOME/storages/workspace.json` 复制进去**。想"什么都不丢"时复制是最直觉的做法，而它会直接把另一个世界的工作区搬回来：路由 profile 于是列出它毫无理由列出的本地工作区，而本地 profile 则正确地不显示容器的任何东西。会话需要同样处理——只搬替身日志目录，不要搬整个 `sessions` 根。

客户端半边值得装进纯工具 profile，恰恰因为它懂得让路；`examples/web-tools-only.cordis.patch.yml` 展示了该配置。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `sshHost` | *（空）* | SSH 目标，走你自己的 ssh config 解析。出厂为空，这样一个全新安装不可能指向别人的机器；在你设置之前，启动日志会一直点名它。 |
| `container` | *（空）* | 容器名或 id。为空时八个 `devc_*` 工具**根本不会注册**（因此 `devc_status` 也不存在）；`devc_host_*` 工具与选择器照常可用，而路由模式会改为按工作区解析容器。 |
| `containerRoot` | `/` | 容器内路径默认相对的绝对路径。 |
| `hostRoot` | *（空）* | 同一目录在宿主上的样子。仅由 `devc_status` 报告，用于定位。 |
| `mountPoint` | *（空）* | 代表 `containerRoot` 的本地目录——直接指向某条容器路径的显式一对一配对。 |
| `mountRoot` | *（空）* | 本地目录，其子树镜像**宿主**的整个文件系统，因此任意宿主目录都可被寻址与挑选。设置任一个也会开启工作区选择器；见[把容器世界挡在你的其它 profile 之外](#把容器世界挡在你的其它-profile-之外)。 |
| `tools` | `true` | 注册 `devc_*` 工具。 |
| `provideFs` | `false` | 提供路由版 `ctx.fs`。需要关闭 `fs-sandbox`。 |
| `provideShell` | `false` | 提供路由版 `ctx.shell`。需要关闭 `bash-sandbox`。 |
| `provideSearch` | `false` | 注册按路径分派的 `glob`/`grep`。需要关闭 `tool-fs-search`，**且**开启路由——它被 `provideFs`/`provideShell` 门控。 |
| `prompt` | `false` | 注册一段向模型解释容器的系统提示。同样被 `provideFs`/`provideShell` 门控。 |
| `hostTools` | `true` | 注册 `devc_host_*` 工具与 `devc_containers`。 |
| `browseRoot` | *（`hostRoot` 的父目录）* | 工作区选择器在宿主上开始浏览的位置。 |
| `extraHosts` | `[]` | 在 `~/.ssh/config` 之外额外提供的 SSH 目标。 |
| `sshConfigPath` | *（空）* | 要读取的 ssh_config 文件。为空即 `~/.ssh/config`。 |
| `autoWorkspace` | `false` | 启动时把挂载点登记为工作区。 |
| `workspaceTitle` | *（容器根目录名）* | 自动登记工作区的显示标题。 |
| `defaultTimeoutMs` | `120000` | 调用方未指定时的单命令上限。 |
| `maxTimeoutMs` | `600000` | 施加于任何调用方所给超时的上限。 |

## 工具

| 工具 | 用途 |
| --- | --- |
| `devc_status` | 宿主、容器、各个根、通道状态，以及一次容器内实时探测。出问题时从这里开始。 |
| `devc_exec` | 在容器内运行一条 bash 命令。每次调用都是新 shell，所以要传 `workdir`。 |
| `devc_read` | 读取 UTF-8 文本文件并带行号，可用 `offset`/`limit` 开窗。拒绝二进制文件。 |
| `devc_write` | 创建或整体替换文件。原子写（临时文件 + rename）；缺失的父目录会被创建。 |
| `devc_edit` | 字面量查找替换。匹配有歧义时拒绝，除非设置 `replace_all`。 |
| `devc_ls` | 列出目录，带类型与大小。 |
| `devc_grep` | 在容器内 `grep -E`，返回 `file:line:` 形式的匹配。上限 250 行。 |
| `devc_glob` | 启用 `globstar` 的 bash glob，例如 `**/*.go`。上限 200 条路径。 |

错误以文本形式返回（`[dsh-devcontainer error] …`）而不是抛出，因此一次失败调用不会中断整个轮次——模型可以读到消息并自我纠正。

路由模式下 `devc_*` 工具仍然可用，这是你抵达挂载点**之外**容器路径的方式（`/go`、`/usr/local/go`、`/home/vscode`、其它挂载）。

### 宿主侧工具

由 `hostTools` 注册（默认开启）。它们面向**宿主**——运行容器的那台机器——因此操作的是宿主路径与宿主命令，而非容器的。它们不需要挂载点、也不需要路由，这也是它们在纯工具 profile 里同样可用的原因。

| 工具 | 用途 |
| --- | --- |
| `devc_containers` | 列出宿主上所有 dev container 及其所属目录；或解析单个目录：它有没有 `.devcontainer`、有没有对应容器、该容器能否充当它的执行世界。这就是"宿主目录变成容器路径"的过程，全程不涉及 devcontainer 构建。 |
| `devc_host_exec` | 在宿主上运行一条 bash 命令：查看机器、Docker 状态、某个项目目录。 |
| `devc_host_read` | 读取宿主上的 UTF-8 文本文件，带行号。 |
| `devc_host_write` | 创建或整体替换宿主上的 UTF-8 文本文件。原子写；缺失的父目录会被创建。 |
| `devc_host_ls` | 列出宿主上的目录，带类型与大小。 |

当你知道项目目录、却不知道它在容器里位于何处时，第一个该拿起来的就是 `devc_containers`。

## 路由如何保持安全

路由是**扩展**随包的沙箱实现，而不是重新实现它们：

```
FileSystem → LocalFileSystem → SandboxedFileSystem → RoutingFileSystem
ShellExecutor → LocalBashExecutor → SandboxBashExecutor → RoutingBashExecutor
```

只有必须选择世界的那几个方法被覆写。挂载点之外的每一条路径都落到 `super`，因此本地分支原封不动地保留了部署的沙箱语义——不存在第二份会漂移的逻辑。验收测试断言了这一点，包括"工作区根之外的本地写入仍然被拒绝"。

容器子树则是另一回事，且是刻意的：`ctx.sandboxPolicy` 用本地工作区根来圈定**本地**文件效果，而容器内的一次写入并不是。`dsh-sandbox` 自己的模块文档就是这么说的——*"Containers, microVMs, and remote execution replace the surrounding capability seam instead."* 容器本身、以及你对它的 SSH 访问权，就是边界。

有几条后果值得直说：

* 命令以容器运行所用的那个用户身份执行，看到的是容器的文件系统与网络视图。
* 容器侧的效果不会触发审批提示；本地策略引擎没有可评估的对象。
* 若需要更紧的控制，就限制容器挂载了什么、以哪个用户运行。

## 坑：bind mount 容器内的 `git` 属主问题

以 `root` 运行、且 bind mount 目录在宿主上属主是另一个 uid 时，git 会拒绝该仓库：

```
fatal: detected dubious ownership in repository at '/workspaces/…'
```

在 Go 项目上这不是无关痛痒的警告——每一次 `go build` 都会以 `error obtaining VCS status` 失败，什么也编译不出来。在容器内修一次即可：

```sh
git config --global --add safe.directory /workspaces/your-project
```

这是环境属性，不是插件替你假定或改动的东西。

## 验证

测试分成两半。其中六个——`examples`、`client`、`hosts`、`browse`、`worlds`、`dispatch`——是**无容器**的：解析器、路径/世界映射、分派规则、选择器的 shell 构造，以及对外发布的说明。它们在任何地方都能跑（包括 CI），无需任何配置。

```sh
npm run test:unit       # 无容器的六个；不需要目标
```

其余几个经由真实 SSH 连接驱动真实的 Docker dev container，确实需要一个可用目标。用以下任一方式指向你自己的：

```sh
cp test/config.example.mjs test/config.local.mjs   # 然后填写（已 gitignore）
# 或 export DSH_DEVCONTAINER_SSH_HOST / _CONTAINER / _CONTAINER_ROOT / _HOST_ROOT
```

```sh
npm install             # 仅 devDependencies；插件本身零依赖
npm test                # 全部十一个：上面六个，再接五个需要容器的
node test/boot.mjs      # 按 loader 的方式装载插件，对接真实服务
node test/discover.mjs  # "目录 → 容器"链路，对接真实 Docker 宿主
node test/routing.mjs   # 路由 provider 对接真实沙箱/subprocess 栈
node test/registry.mjs  # 对接真实 dsh-tools registry，逐个驱动每个工具
node test/smoke.mjs     # 以替身 subprocess seam 做的独立冒烟测试
npm run test:channel    # 延迟基准：常驻通道 vs 一次性 ssh docker exec
```

`test/client.mjs` 值得单独一提（虽然它属于那六个无容器的）：它把 Web 对话框的重入与主题不变量写成源码级断言，因为应用自带 React 并把它交给插件 bundle，这里没有可用来渲染的 React 运行时。

`routing.mjs` 是路由模式的验收测试：它拉起真实的 `dsh-sandbox-local` / `dsh-sandbox-policy` / `dsh-subprocess-local` / `dsh-tools` 栈，且**刻意不装**随包的 `fs-sandbox` 与 `bash-sandbox`，装载路由器，然后针对真实容器驱动那些普通 seam——读、写、带守卫的编辑、列目录、前台命令、流式后台命令——最后以本地分支的无回归检查收尾。

其中两条断言是承重的回归守卫，而非冒烟检查：

* **后台流式输出**跑五轮突发，因为首块曾经间歇性丢失。helper 会把 `exec_start` 的响应和最初的数据块写进**同一次 TCP 读**，所以若监听器只在响应 promise settle 之后才挂上，就会漏掉与它共享那次读的内容。
* **本地沙箱**向工作区根与平台临时区之外的一条路径写入，以证明本地分支仍被圈定、路由器没有悄悄解除它的限制。

若要通过一个真实的 agent 会话做端到端检查，用同一个 patch 从随包的 headless 模板派一个一次性 profile（`examples/headless.cordis.patch.yml`），然后让它使用自己的工具：

```sh
dsh --profile dcheadless "Use your bash tool with workdir <mountPoint> and command \
  'hostname; test -f /.dockerenv && echo IN_CONTAINER; pwd'. Then read <mountPoint>/go.mod. \
  Report both outputs verbatim."
```

### 更新一个正在运行的安装

`dsh plugin --profile <p> add <path>` 安装的是指向你 checkout 的**符号链接**，所以既没有打包步骤，循环里也没有 `npm pack`。（按安装章节那样用 registry 名字安装则会把已发布的包复制进 profile——那时改 checkout 不会有任何效果，除非重新 add 或 update。开发期请用路径形式。）

之后两半各自需要的东西不同：

* `lib/index.js` 以及宿主加载的其它一切，在启动时读取一次。**重启该 profile。**
* `lib/client.js` **刷新页面**即可生效。它的 revision 是页面内嵌的内容哈希，所以变化后的 bundle 是一个新 URL，浏览器缓存无法再交出旧的。在运行中的 profile 上实测过：往文件末尾追加一行注释，既改变了服务端返回的字节，也改变了页面携带的 revision，全程无需重启。

## 设计说明

* **本包在运行时不导入任何第三方模块。** 它导入的是 Node 内建模块——工具路径上的 `node:fs/promises`、`node:path`、`node:os`、`node:child_process`；路由模块另外导入它所扩展的两个随包沙箱实现，搜索模块则导入随包搜索模块以取得 ripgrep 路径。
* **同级 `node_modules` 会改变这些导入的解析位置。** Node 从模块的真实路径解析裸标识符。profile 安装是指向本 checkout 的符号链接，所以真实路径就是这个 checkout——而 `npm install`（只为测试而存在）之后，插件会从*本仓库的* `node_modules` 解析 `@deepseek-ai/*`，而不是从 harness 安装目录。两份拷贝版本相同，端到端会话在两种情况下都验证过；但这确实意味着一个"活的"插件 checkout 会携带自己的一份 harness 包。只用于部署的 checkout 可以删掉 `node_modules`，或者留着并接受版本完全相同的重复。
* **service 类里没有私有成员。** Cordis 通过 `Proxy` 分发服务，而 `#private` 成员无法穿透 Proxy 访问——私有 brand 检查会以 *"Receiver must be an instance of class …"* 失败。辅助逻辑因此放在模块级函数里。
* **版本 token 是 `mtimeMs:size`。** 读取与列举回的是 `size`，写入与编辑回的是 `bytes`；token 取两者中存在的那个，因为若把一次写入的字节数当成"缺失的 size"，会让每次新写入都盖上 size 0 的戳，进而让下一次带守卫的编辑误报 stale version。
* **自愈通道。** 掉线不是致命的：挂起的调用会以可读消息 reject，下一次调用按需重连。
* **helper 每次连接都重写**，因此容器永远不会与插件漂移。
* **所有副作用都由 Fiber 持有**（`ctx.effect`），所以停止或更新插件会连带拆除通道、路由器和每个工具。

### 为什么 `glob` 和 `grep` 需要自己的路由

它们是唯一一对无法经任一 seam 抵达的工具。随包的 `@deepseek-ai/dsh-tool-fs-search` 通过 `ctx.subprocess` 以一个普通 argv 向量启动**打包好的 ripgrep 二进制**——它自己就这么说：*"never `ctx.shell`"*，而且它也从不碰 `ctx.fs`。在容器 profile 里这会直接失败，因为挂载点是一个空的本地目录，而容器里根本没有 ripgrep。

所以路由模式接管这两个名字并按请求路径分派：容器路径经常驻通道走容器自己的 `find`/`grep`，本地路径走与随包工具**同一个**打包 ripgrep——并且是*通过*随包模块解析出来的（`resolveRgPath`），所以两者不可能对"是哪个二进制"产生分歧。这也是该 profile 关闭 `tool-fs-search` 的原因。

## 已知限制

* `resolve()` 对容器路径做**词法**规范化而非 `realpath`——每次 resolve 都跑一趟容器会让每一次读写多付一帧。因此容器内的符号链接别名不会被折叠。
* 技能发现（`dsh-skill-filesystem`）用 `node:fs` 遍历**本地**挂载点，因此它看到的是一个空目录；只有技能*正文*经 `ctx.fs` 加载。若需要在那里有技能目录，就在挂载点里放一棵 `.dsh/skills`。
* 挂载点路径与容器路径是不同的字符串。模型通过 `prompt` 段得知这层映射；它看到的目标永远是容器路径。
* 容器侧写入按设计绕过本地沙箱（见上文）。只有 `provideFs` 会改变本地路径的行为，而它一点也没改。

## License

MIT
