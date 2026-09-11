# dsh-devcontainer

Develop inside a **Docker dev container on a remote machine**, straight from DeepSeek Harness.

The container is the execution world: commands, file reads/writes/edits, grep and glob all run
inside it, with its own toolchain and its own paths. Nothing needs to be installed inside the
container — the plugin ships its own helper and copies it in on every connect.

```
dsh (your laptop)  ──ssh──▶  host  ──docker exec──▶  dev container  ──▶  your project
```

Two modes, and they compose:

| Mode | What you get | Effect on the harness |
| --- | --- | --- |
| **Tools** (default) | `devc_*` tools that address the container directly by container path | Purely additive — nothing changes |
| **Routing** | The harness's **ordinary** `bash`, `read`, `write`, `edit`, `glob`, `grep` operate inside the container for paths under a mount point | Replaces `ctx.fs` and `ctx.shell`; needs its own profile |

Routing mode is the one that makes the container feel like a workspace: no `devc_` prefix, no
explaining anything to the model, and the sidebar file browser and workspace registry follow along.

## Why a resident channel

The obvious implementation — one `ssh host docker exec …` per tool call — costs **320–340 ms** over
a typical Tailscale link (SSH handshake + container start + round trip). A single conversational turn
easily issues dozens of file operations, which makes that approach unusable.

This plugin instead holds **one SSH connection** carrying **one resident helper process** inside the
container, speaking JSON-lines RPC. Measured on the same link, per operation:

| Operation | Resident channel | One-shot `ssh docker exec` |
| --- | --- | --- |
| `exec` (trivial) | 8 ms | 320–340 ms |
| `stat` / `list` / `read` | 7 ms | — |
| `write` (atomic) | 7 ms | — |
| `grep` over a whole project | 45 ms | — |

One-time connect cost is ~870 ms, paid lazily on the first call.

## Requirements

* **The dev container already runs on the remote host.** This plugin attaches to a container; it
  does not build or create one. VS Code Dev Containers containers work as-is.
* **SSH access to that host** using your own `~/.ssh/config` — the plugin shells out to `ssh`, so
  aliases, keys, agents, jump hosts and Tailscale all behave exactly as they do in your terminal.
* **Non-interactive SSH must work**: `ssh <host> true` must succeed without a prompt.
* **`node` inside the container** (any modern version — it runs the helper). Dev container images
  almost always have it; `devc_status` will tell you if not.
* **Docker access for your SSH user** on the host (`docker exec` without `sudo`).

Not required: a local Docker, macFUSE, sshfs, a local mount of any kind, or `devcontainer` CLI.

## Install — tools mode

```sh
dsh plugin --profile web add /path/to/dsh-devcontainer
```

Restart the profile so the `devcontainer` row activates. The bundle ships its own composition row, so
there is nothing to hand-edit. You get eight `devc_*` tools addressing the container by container
path — see [Tools](#tools).

## Install — routing mode

Routing replaces two **host-plane** services, so give it its own profile and leave your daily one
alone:

```sh
# 1. a profile of its own, from the shipped web template
dsh --profile devcontainer --from-default-profile web --dump-config

# 2. the plugin
dsh plugin --profile devcontainer add /path/to/dsh-devcontainer

# 3. the profile's cordis.patch.yml (copy examples/devcontainer.cordis.patch.yml)
```

The profile patch does four things:

```yaml
- id: fs-sandbox          # replaced by the routing filesystem
  disabled: true
- id: bash-sandbox        # replaced by the routing bash executor
  disabled: true
- id: tool-fs-search      # glob/grep spawn a LOCAL ripgrep; routing mode owns them
  disabled: true
- id: devcontainer
  config:
    mountPoint: /Users/you/.dsh/devcontainer/YourProject
    provideFs: true
    provideShell: true
    provideSearch: true
    prompt: true
    autoWorkspace: true
```

Then boot it — the mount point is already registered as a workspace, so there is no
"Add workspace" step:

```sh
dsh --profile devcontainer
```

A `web` profile holds the default port 3080, so both profiles can run at once only if one of
them moves; the patch above pins `webserver.port` to 3099 for that reason. `--port` on the command
line still wins.

### The mount point

A DSH workspace must be a **real local directory** — the workspace registry canonicalizes it with
`node:fs` `realpath`, which never sees the container, so a container path cannot be registered. The
mount point is a local stand-in whose entire subtree stands for the container root:

```
/Users/you/.dsh/devcontainer/YourProject/cmd/main.go
        ↕   (same file)
/workspaces/YourProject/cmd/main.go
```

Both spellings resolve to the same target, and the tool reports the **container** path — so what the
model reads matches what `pwd` and `go build` report from inside the container. The plugin creates
the mount point on first boot if it is missing.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `sshHost` | `nas` | SSH destination, resolved through your own ssh config. |
| `container` | *(empty)* | Container name or id. Empty means every call fails with a configuration error. |
| `containerRoot` | `/` | Absolute path inside the container that paths default to. |
| `hostRoot` | *(empty)* | The same directory as the host sees it. Reported by `devc_status` for orientation only. |
| `mountPoint` | *(empty)* | Local directory standing for `containerRoot`. Required by routing mode. |
| `tools` | `true` | Register the `devc_*` tools. |
| `provideFs` | `false` | Provide the routing `ctx.fs`. Requires `fs-sandbox` disabled. |
| `provideShell` | `false` | Provide the routing `ctx.shell`. Requires `bash-sandbox` disabled. |
| `provideSearch` | `false` | Register path-routed `glob`/`grep`. Requires `tool-fs-search` disabled. |
| `prompt` | `false` | Register a system-prompt section explaining the container to the model. |
| `autoWorkspace` | `false` | Register the mount point as a workspace on boot. |
| `workspaceTitle` | *(container root basename)* | Display title for the auto-registered workspace. |
| `defaultTimeoutMs` | `120000` | Per-command ceiling when the caller states none. |
| `maxTimeoutMs` | `600000` | Ceiling applied to any caller-supplied timeout. |

## Tools

| Tool | Purpose |
| --- | --- |
| `devc_status` | Host, container, roots, channel state, and a live in-container probe. Start here when something fails. |
| `devc_exec` | Run a bash command inside the container. A fresh shell each call, so pass `workdir`. |
| `devc_read` | Read a UTF-8 text file with line numbers, windowed by `offset`/`limit`. Refuses binary files. |
| `devc_write` | Create or fully replace a file. Atomic (temp file + rename); missing parent directories are created. |
| `devc_edit` | Literal search/replace. Refuses an ambiguous match unless `replace_all` is set. |
| `devc_ls` | List a directory with type and size. |
| `devc_grep` | `grep -E` across the container, returning `file:line:` matches. Capped at 250 lines. |
| `devc_glob` | Bash glob with `globstar`, e.g. `**/*.go`. Capped at 200 paths. |

Errors are returned as text (`[dsh-devcontainer error] …`) rather than thrown, so a failed call never
aborts the turn — the model can read the message and correct itself.

In routing mode the `devc_*` tools remain available, which is how you reach container paths **outside**
the mount point (`/go`, `/usr/local/go`, `/home/vscode`, other mounts).

## How routing stays safe

Routing extends the shipped sandboxed implementations rather than reimplementing them:

```
FileSystem → LocalFileSystem → SandboxedFileSystem → RoutingFileSystem
ShellExecutor → LocalBashExecutor → SandboxBashExecutor → RoutingBashExecutor
```

Only the methods that must pick a world are overridden. Every path outside the mount point falls
through to `super`, so the local branch keeps the deployment's sandbox semantics exactly — there is no
second copy of that logic to drift. The acceptance test asserts this, including that a local write
outside the workspace root is still denied.

The container subtree is a different story, deliberately: `ctx.sandboxPolicy` fences **local** file
effects against a local workspace root, and a write inside the container is not one. `dsh-sandbox`'s
own module documentation says as much — *"Containers, microVMs, and remote execution replace the
surrounding capability seam instead."* The container and your SSH access to it are the boundary.

Consequences worth stating plainly:

* Commands run as whatever user the container runs as, with the container's filesystem and network view.
* Approval prompts are not raised for container-side effects; there is nothing for the local policy
  engine to evaluate.
* If you need tighter control, restrict what the container mounts and which user it runs as.

## Gotcha: `git` ownership inside bind-mounted containers

A container running as `root` over a bind mount owned by a different uid on the host makes git refuse
the repository:

```
fatal: detected dubious ownership in repository at '/workspaces/…'
```

With Go this is not a cosmetic warning — every `go build` fails as `error obtaining VCS status`, so
nothing compiles. Fix it once inside the container:

```sh
git config --global --add safe.directory /workspaces/your-project
```

This is an environment property, not something the plugin assumes or changes for you.

## Verification

Every suite here is an **integration** test: it drives a real Docker dev container over a real SSH
connection, so all of them need a live target. Point them at yours once, either way:

```sh
cp test/config.example.mjs test/config.local.mjs   # then fill it in (gitignored)
# or export DSH_DEVCONTAINER_SSH_HOST / _CONTAINER / _CONTAINER_ROOT / _HOST_ROOT
```

```sh
npm install             # devDependencies only; the plugin itself has none
npm test                # runs all four suites below
node test/boot.mjs      # mounts the plugin the way the loader does, against real services
node test/routing.mjs   # the routing providers against the real sandbox/subprocess stack
node test/registry.mjs  # registers against the real dsh-tools registry, drives every tool
node test/smoke.mjs     # standalone smoke test with a stand-in subprocess seam
npm run test:channel    # latency benchmark: resident channel vs one-shot ssh docker exec
```

`routing.mjs` is the acceptance test for routing mode: it brings up the real
`dsh-sandbox-local` / `dsh-sandbox-policy` / `dsh-subprocess-local` / `dsh-tools` stack with the
shipped `fs-sandbox` and `bash-sandbox` deliberately absent, mounts the routers, and then drives the
ordinary seams — reads, writes, guarded edits, listings, foreground commands, streamed background
commands — against a real container, finishing with the no-regression checks on the local branch.

Two of its assertions are load-bearing regression guards rather than smoke checks:

* **Background streaming** runs five burst rounds, because the first chunk used to be dropped
  intermittently. The helper writes the `exec_start` response and the first chunks into the same TCP
  read, so a listener attached only after the response promise settled missed whatever shared that
  read.
* **Local sandbox** writes to a path outside both the workspace root and the platform temp areas, to
  prove the local branch is still fenced and the routers did not quietly unconfine it.

For an end-to-end check through an actual agent session, build a one-shot profile from the shipped
headless template with the same patch (`examples/headless.cordis.patch.yml`) and ask it to use its
own tools:

```sh
dsh --profile dcheadless "Use your bash tool with workdir <mountPoint> and command \
  'hostname; test -f /.dockerenv && echo IN_CONTAINER; pwd'. Then read <mountPoint>/go.mod. \
  Report both outputs verbatim."
```

## Design notes

* **The package imports nothing at module scope except `node:fs/promises`** on the tools path; the
  routing module additionally imports the two shipped sandboxed implementations it extends, and the
  search module imports the shipped search module for its ripgrep path.
* **A sibling `node_modules` changes where those imports resolve.** Node resolves bare specifiers
  from a module's real path. A profile install is a symlink to this checkout, so the real path is the
  checkout — and after `npm install` (which exists only for the tests) the plugin resolves
  `@deepseek-ai/*` from *this* `node_modules` rather than from the harness install. Both copies are
  the same versions and the end-to-end session is verified either way, but it does mean a plugin
  checkout used live carries its own copies of the harness packages. Delete `node_modules` from a
  checkout you only deploy, or keep it and accept version-identical duplicates.
* **No private class members in the service classes.** Cordis hands services out behind a `Proxy`, and
  a `#private` member cannot be reached through one — the private brand check fails with
  *"Receiver must be an instance of class …"*. Helper logic lives in module-level functions instead.
* **Version tokens are `mtimeMs:size`.** Reads and listings answer with `size`, writes and edits with
  `bytes`; the token reads whichever is present, because treating a write's byte count as a missing
  size stamps every fresh write with size 0 and makes the next guarded edit report a false stale
  version.
* **Self-healing channel.** A dropped SSH connection is not fatal: pending calls reject with a
  readable message, and the next call reconnects on demand.
* **The helper is rewritten on every connect**, so the container can never drift from the plugin.
* **All contributions are Fiber-owned** (`ctx.effect`), so stopping or updating the plugin tears down
  the channel, the routers and every tool with it.

### Why `glob` and `grep` need their own routing

They are the one pair that cannot be reached through either seam. The shipped
`@deepseek-ai/dsh-tool-fs-search` spawns a **packaged ripgrep binary** through `ctx.subprocess` with a
plain argv vector — it says so itself: *"never `ctx.shell`"*, and it never touches `ctx.fs` either. In
a container profile that fails outright, because the mount point is an empty local directory and
ripgrep does not exist in the container.

So routing mode owns those two names and dispatches on the requested path: container paths go to the
container's own `find`/`grep` through the resident channel, and local paths go to the same packaged
ripgrep the shipped tool uses — resolved *through* the shipped module (`resolveRgPath`), so the two can
never disagree about which binary that is. This is why the profile disables `tool-fs-search`.

## Known limits

* `resolve()` canonicalizes container paths **lexically**, not by `realpath` — a container round trip
  per resolve would cost a frame on every read and write. Symlink aliasing inside the container is
  therefore not collapsed.
* Skill discovery (`dsh-skill-filesystem`) walks the **local** mount point with `node:fs`, so it sees
  an empty directory; only skill *bodies* load through `ctx.fs`. Put a `.dsh/skills` tree in the mount
  point if you need a catalog there.
* The mount point path and the container path are different strings. The model is told the mapping
  through the `prompt` section; targets it sees are always container paths.
* **The workspace registry is shared across profiles** (`$DSH_HOME/storages/workspace.json`), so a
  mount-point workspace registered by the container profile also appears in every other profile. It is
  only *routed* where `provideFs`/`provideShell` are on; opening it in a plain profile shows the empty
  local stand-in.
* Container-side writes bypass the local sandbox by design (see above). Only `provideFs` changes
  local-path behaviour, and it changes none of it.

## License

MIT
