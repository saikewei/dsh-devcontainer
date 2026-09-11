# dsh-devcontainer

English | [中文](README.zh.md)

Develop inside a **Docker dev container on a remote machine**, straight from DeepSeek Harness.

```
dsh (your laptop)  ──ssh──▶  host  ──docker exec──▶  dev container  ──▶  your project
```

Two modes, and they compose:

| Mode | What you get | Effect on the harness |
| --- | --- | --- |
| **Tools** (default) | `devc_*` tools that address the container by container path | Purely additive |
| **Routing** | The harness's ordinary `bash`, `read`, `write`, `edit`, `glob`, `grep` run inside the container | Replaces `ctx.fs` and `ctx.shell`; needs its own profile |

Routing is what makes the container feel like a workspace: no `devc_` prefix, nothing to explain to
the model, and the sidebar browser and workspace registry follow along.

## Requirements

* A dev container **already running** on a host you reach over ssh. This plugin attaches to a
  container; it does not build one.
* Non-interactive ssh must work: `ssh <host> true` succeeds without a prompt.
* `node` inside the container, and Docker access for your ssh user on the host.
* Not needed: local Docker, macFUSE, sshfs, a local mount of any kind, or the `devcontainer` CLI.

## Install — tools mode

```sh
dsh plugin --profile web add dsh-devcontainer              # from npm
dsh plugin --profile web add /path/to/dsh-devcontainer     # or a local checkout
```

The bundle ships its own composition row, so installing it is the whole install — but the row
arrives **unconfigured**. Point it at your machine in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: devcontainer
  config:
    sshHost: my-nas                      # an alias from your own ~/.ssh/config
    container: my-project-devcontainer   # an existing, running container on that host
    containerRoot: /workspaces/my-project
    hostRoot: /volume1/docker/my-project # optional; the same directory as the host sees it
    tools: true
    provideFs: false
    provideShell: false
    prompt: false
```

A patch replaces the whole `config` object, so restate every key you need, not just the one you are
changing. Restart the profile; the boot log names any key still missing.

## Install — routing mode

Routing replaces two **host-plane** services, so give it its own profile:

```sh
dsh --profile devcontainer --from-default-profile web --dump-config
dsh plugin --profile devcontainer add dsh-devcontainer
cp examples/devcontainer.cordis.patch.yml ~/.dsh/profiles/devcontainer/cordis.patch.yml
$EDITOR ~/.dsh/profiles/devcontainer/cordis.patch.yml
dsh --profile devcontainer
```

The example patch is the complete one — read it rather than copying blindly. Besides the
configuration above it disables the three shipped rows the routers replace (`fs-sandbox`,
`bash-sandbox`, `tool-fs-search`), turns on `provideFs`/`provideShell`/`provideSearch`/`prompt`,
and gives the profile its own stores so the container's workspaces and conversations stay out of
your other profiles. That last part is not optional in practice — see
[Keeping the container world out of your other profiles](#keeping-the-container-world-out-of-your-other-profiles).

A `web` profile holds port 3080, so the example pins `webserver.port` to 3099. `--port` on the
command line still wins.

`examples/` also has `examples/web-tools-only.cordis.patch.yml` (the tools, no routing, no picker)
and `examples/headless.cordis.patch.yml` (a one-shot profile for verifying routing through a real
session).

## Use

### Paths: three worlds

A DSH workspace must be a **real local directory** — the registry canonicalizes it with `node:fs`
`realpath`, which never sees the remote machine. Local **stand-ins** take its place:

```
/Users/you/.dsh/devcontainer/root/nas/volume1/docker/my-project/x.go   (mountRoot: host `nas`)
/Users/you/.dsh/devcontainer/my-project/x.go                          (mountPoint: the project)
        ↕
        nas:/volume1/docker/my-project/x.go                           (the host)
        ↕  bind mount, discovered from Docker
        /workspaces/my-project/x.go                                   (the container)
```

`mountRoot` mirrors **every reachable machine's** filesystem with the machine as the first segment,
so any directory on any host becomes addressable without recording a mapping:

```
mountRoot + '/' + host + hostPath  =  stand-in
```

`mountPoint` is the explicit one-to-one pair for a project you configured up front. Configure either
or both.

**Which world a stand-in lands in is decided, not configured.** The folder is looked up against
Docker's own labels: if a container was created from it, the workspace is reached *inside that
container*; if not, on the host.

### Adding a workspace

"Add workspace" opens a dialog with two tabs:

* **远程容器** — pick a machine, browse its directories, and pick one. Directories carrying a
  `.devcontainer` are marked.
* **本机** — the deployment's own picker, unchanged.

The list of machines is your own `~/.ssh/config`, read where DSH runs. Wildcard blocks (`Host *`)
are skipped because they name no concrete machine; `extraHosts` adds destinations that are not in
the file.

### Tools

| Tool | Purpose |
| --- | --- |
| `devc_status` | Host, container, roots, channel state, and a live in-container probe. Start here when something fails. |
| `devc_exec` | Run a bash command inside the container. A fresh shell each call, so pass `workdir`. |
| `devc_read` | Read a UTF-8 text file with line numbers, windowed by `offset`/`limit`. Refuses binary. |
| `devc_write` | Create or fully replace a file. Atomic; missing parents are created. |
| `devc_edit` | Literal search/replace. Refuses an ambiguous match unless `replace_all` is set. |
| `devc_ls` | List a directory with type and size. |
| `devc_grep` | `grep -E` across the container, returning `file:line:` matches. Capped at 250 lines. |
| `devc_glob` | Bash glob with `globstar`, e.g. `**/*.go`. Capped at 200 paths. |

Errors come back as text (`[dsh-devcontainer error] …`) rather than thrown, so a failed call never
aborts the turn — the model reads the message and corrects itself.

Registered by `hostTools`, these address the **host** instead, so they work with or without routing:

| Tool | Purpose |
| --- | --- |
| `devc_containers` | Every dev container on a host with its folder, or resolve one folder: does it carry a `.devcontainer`, is there a container for it, can that container be its world. This is how a host directory becomes a container path. |
| `devc_host_exec` | Run a bash command on the host. |
| `devc_host_read` | Read a UTF-8 text file on the host, with line numbers. |
| `devc_host_write` | Create or fully replace a UTF-8 text file on the host. |
| `devc_host_ls` | List a directory on the host. |

### Gotcha: `git` ownership inside bind-mounted containers

A container running as `root` over a bind mount owned by another uid on the host makes git refuse
the repository (`fatal: detected dubious ownership`). With Go this is not cosmetic — every
`go build` fails as `error obtaining VCS status`. Fix it once inside the container:

```sh
git config --global --add safe.directory /workspaces/your-project
```

## How it works

### One resident channel

One `ssh host docker exec …` per tool call costs **320–340 ms** over a typical Tailscale link, and a
single turn issues dozens of file operations. So the plugin holds **one SSH connection** carrying
**one resident helper process** inside the container, speaking JSON-lines RPC — **7–8 ms** per
operation, 45 ms for a whole-project grep. Connect costs ~870 ms once, paid lazily. The helper is
rewritten on every connect, so the container can never drift from the plugin and nothing has to be
installed in it.

Nothing about the container has to be configured either: Dev Containers writes
`devcontainer.local_folder=<folder>` onto each container it creates and Docker records the bind
mount, so `devc_containers` answers "which container owns this folder, and where does it live
inside" from Docker's own records. **`devcontainer up` is not implemented** and does not need to be.

### Routing extends the sandbox rather than replacing it

```
FileSystem → LocalFileSystem → SandboxedFileSystem → RoutingFileSystem
ShellExecutor → LocalBashExecutor → SandboxBashExecutor → RoutingBashExecutor
```

Only the methods that must pick a world are overridden; every path outside the mount point falls
through to `super`, so the local branch keeps the deployment's sandbox semantics exactly. The
container subtree is deliberately different: `ctx.sandboxPolicy` fences **local** file effects, and a
write inside the container is not one. Commands run as the container's user, with the container's
filesystem and network view, and approval prompts are not raised for container-side effects. The
container and your SSH access to it are the boundary.

`glob` and `grep` are the one pair that cannot ride either seam — the shipped search module spawns a
packaged local ripgrep through `ctx.subprocess` and never touches `ctx.fs` or `ctx.shell` — so
routing mode owns those two names and dispatches on the requested path.

### Keeping the container world out of your other profiles

A routing profile necessarily registers paths that mean nothing without the routers. Two roots are
shared by every profile by default, and both leak:

| Root | Default | What leaks |
| --- | --- | --- |
| `storage-json.root` | `$DSH_HOME/storages` | The workspace registry. A stand-in registered here appears in profiles that cannot route it, where it opens to nothing. |
| `session-persistence-jsonl.root` | `$DSH_HOME/sessions` | The session logs. A conversation started here stays visible elsewhere — and with no workspace to belong to it lands in the **Ungrouped** bucket, which is where a session goes when it trails no workspace. |

Give each routing profile its own:

```yaml
- id: storage-json
  config:
    root: !!js dshHomePath('profiles/devcontainer/storages')

- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('profiles/devcontainer/sessions')
```

Isolating only the registry is not enough, and the failure is easy to miss: the workspace disappears
from the other profiles but the conversation does not, it just moves to Ungrouped. If you have been
running with a shared registry, move only the stand-in log directories (names starting
`--Users-you-.dsh-devcontainer-root-…--`) into the profile's own `sessions` root.

Both stores start empty, so **seed the new registry from nothing rather than copying
`$DSH_HOME/storages/workspace.json` into it**. Copying is the obvious move when you want to "lose
nothing", and it carries the other world's workspaces straight back in.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `sshHost` | *(empty)* | SSH destination via your own ssh config. Ships empty so a fresh install cannot aim at somebody else's machine. |
| `container` | *(empty)* | Container name or id. While empty the eight `devc_*` tools are **not registered at all**; `devc_host_*` and the picker still work, and routing resolves a container per workspace instead. |
| `containerRoot` | `/` | Absolute path inside the container that paths default to. |
| `hostRoot` | *(empty)* | The same directory as the host sees it. Reported by `devc_status` for orientation. |
| `mountPoint` | *(empty)* | Local directory standing for `containerRoot` — the explicit one-to-one pair. |
| `mountRoot` | *(empty)* | Local directory mirroring the **host's** filesystem, machine first. Setting either turns on the workspace picker. |
| `tools` | `true` | Register the `devc_*` tools. |
| `provideFs` | `false` | Provide the routing `ctx.fs`. Requires `fs-sandbox` disabled. |
| `provideShell` | `false` | Provide the routing `ctx.shell`. Requires `bash-sandbox` disabled. |
| `provideSearch` | `false` | Register path-routed `glob`/`grep`. Requires `tool-fs-search` disabled **and** routing on. |
| `prompt` | `false` | Register a system-prompt section explaining the container. Also gated behind routing. |
| `hostTools` | `true` | Register the `devc_host_*` tools and `devc_containers`. |
| `browseRoot` | *(hostRoot's parent)* | Where the picker starts browsing on a host. |
| `extraHosts` | `[]` | Extra SSH destinations beyond `~/.ssh/config`. |
| `sshConfigPath` | *(empty)* | The ssh_config file to read. Empty means `~/.ssh/config`. |
| `autoWorkspace` | `false` | Register the mount point as a workspace on boot. |
| `workspaceTitle` | *(container root basename)* | Title for the auto-registered workspace. |
| `defaultTimeoutMs` | `120000` | Per-command ceiling when the caller states none. |
| `maxTimeoutMs` | `600000` | Ceiling applied to any caller-supplied timeout. |

## Known limits

* `resolve()` canonicalizes container paths **lexically**, not by `realpath`, so symlink aliasing
  inside the container is not collapsed.
* Skill discovery walks the **local** mount point with `node:fs` and sees an empty directory; only
  skill bodies load through `ctx.fs`.
* Container-side writes bypass the local sandbox by design. Only `provideFs` changes local-path
  behaviour, and it changes none of it.

## Development

Seven of the twelve suites are container-free and run anywhere:

```sh
npm install
npm run test:unit       # no target required
npm test                # all twelve; the rest need a live dev container
```

Point the integration ones at your target with `cp test/config.example.mjs test/config.local.mjs`
(and then fill it in), or with the `DSH_DEVCONTAINER_*` environment variables.

`dsh plugin add <path>` installs a **symlink** to your checkout, so editing is the loop. The host
half is read once at boot — **restart the profile**. `lib/client.js` is picked up by a **page
refresh**; its revision is a content hash the page embeds, so the browser cache cannot serve a stale
bundle.

Deeper design notes, measurements, and the reconnaissance behind them live in
[`docs/architecture.md`](docs/architecture.md).

## License

MIT
