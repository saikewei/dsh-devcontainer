# dsh-devcontainer

[English](README.md) | 中文

直接在**远程机器上的 Docker dev container** 里开发，由 DeepSeek Harness 驱动。

```
dsh（你的笔记本）  ──ssh──▶  宿主  ──docker exec──▶  dev container  ──▶  你的项目
```

只有一种模式，而且是**按会话**的。工作区目录落在镜像下的会话，会得到 harness **原有的** `bash`、`read`、`write`、`edit`、`glob`、`grep`——在容器内执行，没有 `devc_` 前缀，不需要向模型解释任何东西。而目录在本地的会话**完全不被触碰**：它根本走不到路由代码，因此行为不可能改变。两者可以在同一个 profile 里并存。

这是与"进程级替换 `ctx.fs`"的刻意区别。替换宿主平面服务意味着必须在 composition 里关闭随包 provider，而那个 profile 从此只要不装本插件就起不来。这里**什么都没被关闭**。

## 前置条件

* 一个**已经在运行**的 dev container，所在宿主你能经 ssh 抵达。本插件接入容器，不构建容器。
* 非交互 SSH 必须可用：`ssh <host> true` 无提示成功。
* 容器内有 `node`；宿主上你的 ssh 用户有 Docker 权限。
* 不需要：本地 Docker、macFUSE、sshfs、任何形式的本地挂载，或 `devcontainer` CLI。

## 安装

```sh
dsh plugin --profile web add dsh-devcontainer              # 从 npm 安装
dsh plugin --profile web add /path/to/dsh-devcontainer     # 或用本地 checkout
```

bundle 自带 composition row，装上即完成安装——**不需要 profile patch、不需要第二个 profile、不需要关闭任何 row**。这个 row 到手时是**未配置**的，在 `~/.dsh/profiles/web/cordis.patch.yml` 里指向你的机器：

```yaml
- id: devcontainer
  config:
    sshHost: my-nas                      # 你自己 ~/.ssh/config 里的别名
    container: my-project-devcontainer   # 该宿主上一个已在运行的容器
    containerRoot: /workspaces/my-project
    hostRoot: /volume1/docker/my-project # 可选；同一目录在宿主上的样子
```

patch 会**整体替换** `config` 对象，所以要改某个键就把需要的键全部重述一遍。重启该 profile；启动日志会点名仍然缺失的键。

然后用"新增工作区"：选一台机器，浏览它的目录，选中一个。含 `.devcontainer` 的目录会被标出，有它的目录在容器内抵达，没有的则在宿主上抵达。

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

这是有确定答案的真实问题，因此绝不猜。首次碰到某个镜像目录的调用会等这个目录判定完成——一次 SSH 往返，之后缓存，并与同一棵目录树上的其他调用共享。若机器不可达，该调用**直接失败并说明原因**，而不是悄悄改在宿主上执行：机器对了，工具链和路径全错，且没有任何报错可察觉。

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

### 路由按会话生效，位于工具层

最直觉的设计是进程级替换 `ctx.fs` 与 `ctx.shell`。它无法做到安全：Cordis 拒绝为已注册的服务二次 `provide()`，`set()` 要求同一 fiber，而 composition patch **不能改 row 的 `name`**——所以要让路由器接位，就必须在 composition 里**关闭**随包 provider，而那个 profile 从此只要不装本插件就没有文件系统。

所以路由上移一层。在 `agent/created` 时，cwd 落在镜像下的会话会得到一个**隔离领域**（`ctx.isolate('fs').isolate('shell')`），其作用域是该 agent 自己的；把官方 `dsh-tool-fs` 与 `dsh-tool-bash` 挂进去——于是**它们的** `ctx.fs` 和 `ctx.shell` 就是路由器。由于这个领域仍携带 agent 的 scope key，它们的注册落进该会话的工具层，**只对该会话**遮蔽全局定义。

后果正是重点所在：

* 本地会话在任何注册发生**之前**就返回了。不是"仍然可用"，而是**根本没被走到**。
* 没有任何全局服务被替换，所以卸载后部署原样恢复。
* `dsh plugin add` 就是全部安装步骤；没有 row 要关，也没有 profile 要隔离。

`glob` 和 `grep` 是例外，仍归本插件自己。随包搜索工具通过 `ctx.subprocess` 启动一个打包好的**本地** ripgrep，既不碰 `ctx.fs` 也不碰 `ctx.shell`，任何领域都改不了它。

容器子树刻意落在本地沙箱之外：`ctx.sandboxPolicy` 圈定的是**本地**文件效果，而容器内的一次写入并不是。命令以容器的用户身份执行，看到的是容器的文件系统与网络视图，容器侧的效果也不会触发审批提示。容器本身、以及你对它的 SSH 访问权，就是边界。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `sshHost` | *（空）* | SSH 目标，走你自己的 ssh config。出厂为空，这样一个全新安装不可能指向别人的机器。 |
| `container` | *（空）* | 容器名或 id。为空时八个 `devc_*` 工具**根本不会注册**；`devc_host_*` 与选择器照常可用，而路由模式会改为按工作区解析容器。 |
| `containerRoot` | `/` | 容器内路径默认相对的绝对路径。 |
| `hostRoot` | *（空）* | 同一目录在宿主上的样子。仅由 `devc_status` 报告，用于定位。 |
| `mountPoint` | *（空）* | 代表 `containerRoot` 的本地目录——显式的一对一配对。 |
| `mountRoot` | `$DSH_HOME/devcontainer/root` | 镜像**宿主**文件系统的本地目录，机器名在前。这个默认值让全新安装无需配置替身即可工作。 |
| `tools` | `true` | 注册 `devc_*` 工具。 |
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
* 容器侧写入按设计绕过本地沙箱。本插件不改变任何本地路径行为，而且路由会话的本地分支就是随包实现本身。
* 只有那七个工具会被路由。侧边栏文件浏览器、技能发现等直接读 `ctx.fs` 的消费者，对镜像工作区看到的仍是本地替身——这是"永不替换全局服务"的代价。要读容器内部，用 `devc_read`/`devc_ls`/`devc_glob`/`devc_grep`。

## 开发

十五套测试里有十套无容器，任何地方都能跑：

```sh
npm install
npm run test:unit       # 不需要目标
npm test                # 全部十五套；其余需要真实 dev container
```

把集成测试指向你的目标：`cp test/config.example.mjs test/config.local.mjs` 后填写，或使用 `DSH_DEVCONTAINER_*` 环境变量。

`dsh plugin add <path>` 安装的是指向你 checkout 的**符号链接**，所以编辑即循环。宿主半边在启动时读取一次——**重启该 profile**。`lib/client.js` **刷新页面**即可生效；它的 revision 是页面内嵌的内容哈希，所以浏览器缓存交不出旧的 bundle。

更深的设计说明、实测数据与背后的侦察记录见 [`docs/architecture.md`](docs/architecture.md)。

## License

MIT
