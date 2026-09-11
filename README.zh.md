# dsh-devcontainer

[English](README.md) | 中文

直接在**远程机器上的 Docker dev container** 里开发，由 DeepSeek Harness 驱动。

```
dsh（你的笔记本）  ──ssh──▶  宿主  ──docker exec──▶  dev container  ──▶  你的项目
```

两种模式，可以叠加：

| 模式 | 你得到什么 | 对 harness 的影响 |
| --- | --- | --- |
| **工具模式**（默认） | 一组 `devc_*` 工具，直接用容器内路径寻址 | 纯增量 |
| **路由模式** | harness **原有的** `bash`、`read`、`write`、`edit`、`glob`、`grep` 在容器内执行 | 替换 `ctx.fs` 与 `ctx.shell`；需要独立 profile |

真正让容器"像一个工作区"的是路由模式：没有 `devc_` 前缀，不需要向模型解释任何东西，侧边栏文件浏览器和工作区注册表也一并跟随。

## 前置条件

* 一个**已经在运行**的 dev container，所在宿主你能经 ssh 抵达。本插件接入容器，不构建容器。
* 非交互 SSH 必须可用：`ssh <host> true` 无提示成功。
* 容器内有 `node`；宿主上你的 ssh 用户有 Docker 权限。
* 不需要：本地 Docker、macFUSE、sshfs、任何形式的本地挂载，或 `devcontainer` CLI。

## 安装 — 工具模式

```sh
dsh plugin --profile web add dsh-devcontainer              # 从 npm 安装
dsh plugin --profile web add /path/to/dsh-devcontainer     # 或用本地 checkout
```

bundle 自带 composition row，装上即完成安装——但这个 row 到手时是**未配置**的。在 `~/.dsh/profiles/web/cordis.patch.yml` 里指向你的机器：

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

patch 会**整体替换** `config` 对象，所以要改某个键就把需要的键全部重述一遍，而不是只写改动的那一个。重启该 profile；启动日志会点名仍然缺失的键。

## 安装 — 路由模式

路由会替换两个**宿主平面**的服务，所以给它一个独立 profile：

```sh
dsh --profile devcontainer --from-default-profile web --dump-config
dsh plugin --profile devcontainer add dsh-devcontainer
cp examples/devcontainer.cordis.patch.yml ~/.dsh/profiles/devcontainer/cordis.patch.yml
$EDITOR ~/.dsh/profiles/devcontainer/cordis.patch.yml
dsh --profile devcontainer
```

示例 patch 是完整的那一份——值得读一遍而不是照抄。除上面那份配置之外，它还关闭了被路由器取代的三个随包 row（`fs-sandbox`、`bash-sandbox`、`tool-fs-search`），打开 `provideFs`/`provideShell`/`provideSearch`/`prompt`，并给该 profile 独立存储，让容器的工作区和对话不渗进你的其它 profile。最后一条在实践中不是可选项——见[把容器世界挡在你的其它 profile 之外](#把容器世界挡在你的其它-profile-之外)。

`web` profile 占用 3080 端口，所以示例把 `webserver.port` 固定到 3099。命令行上的 `--port` 仍然优先。

`examples/` 里还有 `examples/web-tools-only.cordis.patch.yml`（只有工具，无路由、无选择器）与
`examples/headless.cordis.patch.yml`（用于经真实会话验证路由的一次性 profile）。

## 使用

### 路径：三个世界

DSH 工作区必须是**真实的本地目录**——注册表用 `node:fs` 的 `realpath` 规范化，而它永远看不到远程机器。于是用本地**替身**代替：

```
/Users/you/.dsh/devcontainer/root/nas/volume1/docker/my-project/x.go   （mountRoot：宿主 `nas`）
/Users/you/.dsh/devcontainer/my-project/x.go                           （mountPoint：该项目）
        ↕
        nas:/volume1/docker/my-project/x.go                            （宿主）
        ↕  bind mount，从 Docker 发现
        /workspaces/my-project/x.go                                    （容器）
```

`mountRoot` 镜像**所有可达机器**的文件系统，以机器名作为第一段，因此任意宿主上的任意目录都可寻址，而无需在任何地方记录映射：

```
mountRoot + '/' + host + hostPath  =  替身
```

`mountPoint` 是指向你事先配置好的项目的显式一对一配对。二者可以任配其一，也可以都配。

**替身最终落在哪个世界是"判定"出来的，不是配置出来的。** 目录会拿去和 Docker 自己的 label 比对：如果某个容器由它创建，该工作区就*在那个容器内*抵达；否则走宿主。

### 新增工作区

"新增工作区"会打开一个带两个选项卡的对话框：

* **远程容器**——选一台机器，浏览它的目录并选中一个。含 `.devcontainer` 的目录会被标出。
* **本机**——部署自己的选择器，不做任何改动。

机器名单就是你自己的 `~/.ssh/config`，在 DSH 所在处读取。通配块（`Host *`）会被跳过，因为它们不指向任何具体机器；`extraHosts` 用来补充不在该文件里的目标。

### 工具

| 工具 | 用途 |
| --- | --- |
| `devc_status` | 宿主、容器、各个根、通道状态，以及一次容器内实时探测。出问题时从这里开始。 |
| `devc_exec` | 在容器内运行一条 bash 命令。每次调用都是新 shell，所以要传 `workdir`。 |
| `devc_read` | 读取 UTF-8 文本文件并带行号，可用 `offset`/`limit` 开窗。拒绝二进制。 |
| `devc_write` | 创建或整体替换文件。原子写；缺失的父目录会被创建。 |
| `devc_edit` | 字面量查找替换。匹配有歧义时拒绝，除非设置 `replace_all`。 |
| `devc_ls` | 列出目录，带类型与大小。 |
| `devc_grep` | 在容器内 `grep -E`，返回 `file:line:` 形式的匹配。上限 250 行。 |
| `devc_glob` | 启用 `globstar` 的 bash glob，例如 `**/*.go`。上限 200 条路径。 |

错误以文本形式返回（`[dsh-devcontainer error] …`）而不是抛出，因此一次失败调用不会中断整个轮次——模型读到消息后会自我纠正。

以下由 `hostTools` 注册，面向**宿主**，因此有无路由都可用：

| 工具 | 用途 |
| --- | --- |
| `devc_containers` | 列出宿主上所有 dev container 及其所属目录；或解析单个目录：它有没有 `.devcontainer`、有没有对应容器、该容器能否充当它的执行世界。这就是"宿主目录变成容器路径"的过程。 |
| `devc_host_exec` | 在宿主上运行一条 bash 命令。 |
| `devc_host_read` | 读取宿主上的 UTF-8 文本文件，带行号。 |
| `devc_host_write` | 创建或整体替换宿主上的 UTF-8 文本文件。 |
| `devc_host_ls` | 列出宿主上的目录。 |

### 坑：bind mount 容器内的 `git` 属主问题

以 `root` 运行、且 bind mount 目录在宿主上属主是另一个 uid 时，git 会拒绝该仓库（`fatal: detected dubious ownership`）。在 Go 项目上这不只是警告——每一次 `go build` 都会以 `error obtaining VCS status` 失败。在容器内修一次即可：

```sh
git config --global --add safe.directory /workspaces/your-project
```

## 基本原理

### 一条常驻通道

每次工具调用跑一次 `ssh host docker exec …`，在典型 Tailscale 链路上要 **320–340 ms**，而一个轮次轻易就会发出几十次文件操作。所以插件保持**一条 SSH 连接**，其上承载容器内**一个常驻 helper 进程**，用 JSON-lines RPC 通信——每次操作 **7–8 ms**，全项目 grep 45 ms。建链一次性约 870 ms，延迟到首次调用才付出。helper 每次连接都重写，因此容器永远不会与插件漂移，容器里也不需要预装任何东西。

容器侧同样无需任何配置：Dev Containers 会在它创建的每个容器上写 `devcontainer.local_folder=<目录>`，Docker 也记录了 bind mount，所以 `devc_containers` 能直接从 Docker 自己的记录回答"这个目录属于哪个容器、在容器里位于何处"。**`devcontainer up` 没有实现，也不需要实现。**

### 路由是扩展沙箱，而不是取代它

```
FileSystem → LocalFileSystem → SandboxedFileSystem → RoutingFileSystem
ShellExecutor → LocalBashExecutor → SandboxBashExecutor → RoutingBashExecutor
```

只有必须选择世界的那几个方法被覆写；挂载点之外的每条路径都落到 `super`，因此本地分支原封不动地保留了部署的沙箱语义。容器子树则刻意不同：`ctx.sandboxPolicy` 圈定的是**本地**文件效果，而容器内的一次写入并不是。命令以容器的用户身份执行，看到的是容器的文件系统与网络视图，容器侧的效果也不会触发审批提示。容器本身、以及你对它的 SSH 访问权，就是边界。

`glob` 和 `grep` 是唯一一对无法经任一 seam 抵达的工具——随包搜索模块通过 `ctx.subprocess` 启动一个打包好的**本地** ripgrep，既不碰 `ctx.fs` 也不碰 `ctx.shell`——所以路由模式接管这两个名字，按请求路径分派。

### 把容器世界挡在你的其它 profile 之外

路由 profile 必然会登记一些离开路由器就毫无意义的路径。默认有两个根被所有 profile 共享，且都会泄漏：

| 根 | 默认值 | 泄漏什么 |
| --- | --- | --- |
| `storage-json.root` | `$DSH_HOME/storages` | 工作区注册表。在此登记的替身会出现在无法路由它的 profile 里，打开后什么都没有。 |
| `session-persistence-jsonl.root` | `$DSH_HOME/sessions` | 会话日志。在这里开始的对话会在别处持续可见——而且由于不再有工作区可归属，它会落进 **Ungrouped** 桶，那正是"不属于任何工作区的会话"的去处。 |

给每个路由 profile 各自的根：

```yaml
- id: storage-json
  config:
    root: !!js dshHomePath('profiles/devcontainer/storages')

- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('profiles/devcontainer/sessions')
```

只隔离注册表是不够的，而且这个失败很难察觉：工作区从其它 profile 消失了，但对话没有，它只是挪到了 Ungrouped。如果你此前一直在共享注册表下运行，请**只**把替身日志目录（名字以 `--Users-you-.dsh-devcontainer-root-…--` 开头）移进该 profile 自己的 `sessions` 根。

两个存储都从空开始，所以**新注册表要从空开始，而不是把 `$DSH_HOME/storages/workspace.json` 复制进去**。想"什么都不丢"时复制是最直觉的做法，而它会直接把另一个世界的工作区搬回来。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `sshHost` | *（空）* | SSH 目标，走你自己的 ssh config。出厂为空，这样一个全新安装不可能指向别人的机器。 |
| `container` | *（空）* | 容器名或 id。为空时八个 `devc_*` 工具**根本不会注册**；`devc_host_*` 与选择器照常可用，而路由模式会改为按工作区解析容器。 |
| `containerRoot` | `/` | 容器内路径默认相对的绝对路径。 |
| `hostRoot` | *（空）* | 同一目录在宿主上的样子。仅由 `devc_status` 报告，用于定位。 |
| `mountPoint` | *（空）* | 代表 `containerRoot` 的本地目录——显式的一对一配对。 |
| `mountRoot` | *（空）* | 镜像**宿主**文件系统的本地目录，机器名在前。设置任一个即开启工作区选择器。 |
| `tools` | `true` | 注册 `devc_*` 工具。 |
| `provideFs` | `false` | 提供路由版 `ctx.fs`。需要关闭 `fs-sandbox`。 |
| `provideShell` | `false` | 提供路由版 `ctx.shell`。需要关闭 `bash-sandbox`。 |
| `provideSearch` | `false` | 注册按路径分派的 `glob`/`grep`。需要关闭 `tool-fs-search`，**且**开启路由。 |
| `prompt` | `false` | 注册一段向模型解释容器的系统提示。同样被路由门控。 |
| `hostTools` | `true` | 注册 `devc_host_*` 工具与 `devc_containers`。 |
| `browseRoot` | *（`hostRoot` 的父目录）* | 选择器在宿主上开始浏览的位置。 |
| `extraHosts` | `[]` | 在 `~/.ssh/config` 之外额外提供的 SSH 目标。 |
| `sshConfigPath` | *（空）* | 要读取的 ssh_config 文件。为空即 `~/.ssh/config`。 |
| `autoWorkspace` | `false` | 启动时把挂载点登记为工作区。 |
| `workspaceTitle` | *（容器根目录名）* | 自动登记工作区的显示标题。 |
| `defaultTimeoutMs` | `120000` | 调用方未指定时的单命令上限。 |
| `maxTimeoutMs` | `600000` | 施加于任何调用方所给超时的上限。 |

## 已知限制

* `resolve()` 对容器路径做**词法**规范化而非 `realpath`，因此容器内的符号链接别名不会被折叠。
* 技能发现用 `node:fs` 遍历**本地**挂载点，看到的是空目录；只有技能*正文*经 `ctx.fs` 加载。
* 容器侧写入按设计绕过本地沙箱。只有 `provideFs` 会改变本地路径的行为，而它一点也没改。

## 开发

十二套测试里有七套无容器，任何地方都能跑：

```sh
npm install
npm run test:unit       # 不需要目标
npm test                # 全部十二套；其余需要真实 dev container
```

把集成测试指向你的目标：`cp test/config.example.mjs test/config.local.mjs` 后填写，或使用 `DSH_DEVCONTAINER_*` 环境变量。

`dsh plugin add <path>` 安装的是指向你 checkout 的**符号链接**，所以编辑即循环。宿主半边在启动时读取一次——**重启该 profile**。`lib/client.js` **刷新页面**即可生效；它的 revision 是页面内嵌的内容哈希，所以浏览器缓存交不出旧的 bundle。

更深的设计说明、实测数据与背后的侦察记录见 [`docs/architecture.md`](docs/architecture.md)。

## License

MIT
