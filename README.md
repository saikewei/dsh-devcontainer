# dsh-devcontainer

English | [中文](README.zh.md)

Develop inside a **Docker dev container on a remote machine**, straight from DeepSeek Harness.

```
dsh (your laptop)  ──ssh──▶  host  ──docker exec──▶  dev container  ──▶  your project
```

One mode, and it is per session. A workspace whose directory lives under the mirror gets the
harness's **ordinary** `bash`, `read`, `write`, `edit`, `glob` and `grep` routed into the container —
no `devc_` prefix, nothing to explain to the model. A session whose directory is local is not
touched: it never reaches the routing code at all, so nothing about it can change. The two can run
side by side in one profile.

That is a deliberate difference from reaching into `ctx.fs` process-wide. Replacing the host-plane
services would mean disabling the shipped providers in the composition, and the profile would then
boot with no filesystem unless this plugin were mounted. Nothing here is disabled.

## Requirements

* A dev container **already running** on a host you reach over ssh. This plugin attaches to a
  container; it does not build one.
* Non-interactive ssh must work: `ssh <host> true` succeeds without a prompt.
* `node` inside the container, and Docker access for your ssh user on the host.
* Not needed: local Docker, macFUSE, sshfs, a local mount of any kind, or the `devcontainer` CLI.

## Install

```sh
dsh plugin --profile web add dsh-devcontainer              # from npm
dsh plugin --profile web add /path/to/dsh-devcontainer     # or a local checkout
```

The bundle ships its own composition row, so this is the whole installation — no profile patch, no
second profile, nothing to disable. The row arrives **unconfigured**, so point it at your machine in
`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: devcontainer
  config:
    sshHost: my-nas                      # an alias from your own ~/.ssh/config
    container: my-project-devcontainer   # an existing, running container on that host
    containerRoot: /workspaces/my-project
    hostRoot: /volume1/docker/my-project # optional; the same directory as the host sees it
```

A patch replaces the whole `config` object, so restate every key you need, not just the one you are
changing. Restart the profile; the boot log names any key still missing.

Then add a workspace with "Add workspace" — pick a machine, browse its directories, and choose one.
Directories carrying a `.devcontainer` are marked, and a folder that has one is reached inside its
container; a folder that has none is reached on the host.

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

The lookup is a real question with a real answer, so it is never guessed. The first call that
touches a mirrored folder waits for that folder to be decided — one SSH round trip, cached
afterwards and shared with every other call to the same tree. If the machine cannot be reached, the
call **fails and says so**, rather than quietly running on the host: same machine, wrong toolchain,
wrong paths, and no error to notice.

### Opening a changed file

The "Files changed" row a finished turn ends with records the `file_path` the model passed to
`write`/`edit`. In a routed session that is a **container** path — and every shipped surface that
opens one goes through `workspaceFiles` → `ctx.fs` → this plugin's empty local stand-in, so those
chips resolved nowhere. Registering a second sidebar tab type for them is what gives them somewhere
to land:

* It claims `dsh-resource://file/session/**` in the **`extension`** band, which outranks the shipped
  text previewer's `fallback`, and vetoes any address that is not under a root this profile routes.
  A local file therefore still opens in the shipped previewer, untouched.
* The tab reads through `GET /dsh-devcontainer/file`, which resolves the path to a machine and a
  container with the same `worlds.locate` the tools use. The browser names no machine and no
  container, so nothing it sends has to be trusted.
* **The drawing is the shipped viewer's, not a lookalike.** Only the fetch is this plugin's: the tab
  hands the text to the document body the harness already ships, through the public
  `sidebar.right.tab.document` slot, whose `DocumentContent` owner prop is part of that slot's
  documented contract. Line numbers, the per-line DOM and the addressed-line highlight are therefore
  the original implementation's — and a deployment that registers its own viewer for an extension
  gets that one here too, because the implementation is chosen by the same ranking the previewer
  uses rather than by a hardcoded id.
* Wrapping is a `white-space` on this tab's own scrollport — the shipped page element sets
  `white-space: inherit` precisely so its host can own it — so the wrap toggle lives in this tab's
  header next to reload, and defaults to wrapped as the previewer does.
* Text only, and only the first 2 MB of it. A longer file is served **truncated** rather than
  refused, because for a log the head is the useful answer; a binary file is refused with that
  reason rather than rendered as mojibake.

Empty files, failures, and a deployment that never mounted the shipped previewer fall back to this
plugin's own plain `<pre>`, so the file stays readable — just without line numbers there.

The same mechanism covers the file references your closing prose makes in inline code, since both
surfaces open through one `openFile`.

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
| `devc_ports` | What is already forwarded to this machine, and what the container is listening on. |
| `devc_forward` | Make a container port reachable here, like an editor's port forwarding. Returns the local URL. |
| `devc_unforward` | Stop a forward and release its local port. |

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

### Routing is per session, in the tool layer

The tempting design is to replace `ctx.fs` and `ctx.shell` process-wide. It cannot be made safe:
Cordis refuses a second `provide()` for a registered service, `set()` requires the same fiber, and a
composition patch cannot rename a row — so the shipped providers would have to be **disabled** in the
composition for a router to take their place, and the profile would then boot with no filesystem at
all unless this plugin were mounted.

So routing happens one layer up. On `agent/created`, a session whose cwd falls under the mirror gets
an **isolated realm** (`ctx.isolate('fs').isolate('shell')`) under its own scope, and the official
`dsh-tool-fs` and `dsh-tool-bash` packages are mounted into it — so *their* `ctx.fs` and `ctx.shell`
are the routers. Because that realm still carries the agent's scope key, their registrations land in
that session's tool layer and shadow the global definitions for that session only.

The consequences are the point:

* A local session returns before a single registration. Not "still works" — **not reached**.
* Nothing global is replaced, so uninstalling restores the deployment exactly.
* `dsh plugin add` is the whole installation; there is no row to disable and no profile to keep
  separate.

`glob` and `grep` are the exception, and stay this plugin's own. The shipped search tools spawn a
packaged local ripgrep through `ctx.subprocess` and never touch `ctx.fs` or `ctx.shell`, so no realm
can redirect them.

The container subtree is deliberately outside the local sandbox: `ctx.sandboxPolicy` fences **local**
file effects, and a write inside the container is not one. Commands run as the container's user, with
the container's filesystem and network view, and approval prompts are not raised for container-side
effects. The container and your SSH access to it are the boundary.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `sshHost` | *(empty)* | SSH destination via your own ssh config. Ships empty so a fresh install cannot aim at somebody else's machine. |
| `container` | *(empty)* | Container name or id. While empty the eight `devc_*` tools are **not registered at all**; `devc_host_*` and the picker still work, and routing resolves a container per workspace instead. |
| `containerRoot` | `/` | Absolute path inside the container that paths default to. |
| `hostRoot` | *(empty)* | The same directory as the host sees it. Reported by `devc_status` for orientation. |
| `mountPoint` | *(empty)* | Local directory standing for `containerRoot` — the explicit one-to-one pair. |
| `mountRoot` | `$DSH_HOME/devcontainer/root` | Local directory mirroring the **host's** filesystem, machine first. This is the default that makes a fresh install work without configuring a stand-in. |
| `tools` | `true` | Register the `devc_*` tools. |
| `hostTools` | `true` | Register the `devc_host_*` tools and `devc_containers`. |
| `browseRoot` | *(hostRoot's parent)* | Where the picker starts browsing on a host. |
| `extraHosts` | `[]` | Extra SSH destinations beyond `~/.ssh/config`. |
| `sshConfigPath` | *(empty)* | The ssh_config file to read. Empty means `~/.ssh/config`. |
| `autoWorkspace` | `false` | Register the mount point as a workspace on boot. |
| `workspaceTitle` | *(container root basename)* | Title for the auto-registered workspace. |
| `defaultTimeoutMs` | `120000` | Per-command ceiling when the caller states none. |
| `maxTimeoutMs` | `600000` | Ceiling applied to any caller-supplied timeout. |
| `forward` | `[]` | Container ports to forward on boot, so a dev server is reachable without asking again. |
| `forwardBind` | `127.0.0.1` | Local address a forward binds. Loopback on purpose: every interface would publish the container's dev server to the network. |
| `forwardAuto` | `false` | Forward every listening port as it appears. Off by default — a forward occupies a port on **your** machine. |
| `forwardIntervalMs` | `5000` | How often the auto-forward poll looks for new ports. |

## Known limits

* `resolve()` canonicalizes container paths **lexically**, not by `realpath`, so symlink aliasing
  inside the container is not collapsed.
* Skill discovery walks the **local** mount point with `node:fs` and sees an empty directory; only
  skill bodies load through `ctx.fs`.
* Container-side writes bypass the local sandbox by design. Nothing this plugin does changes
  local-path behaviour, and the local branch of a routed session is the shipped implementation
  itself.
* Only the seven tools route. The sidebar file tree, skill discovery and other consumers of
  `ctx.fs` still see the local stand-in for a mirrored workspace — the price of never replacing a
  global service. `devc_read`/`devc_ls`/`devc_glob`/`devc_grep` reach inside the container instead.
  Opening a **changed file** is the one exception, because it does not go through `ctx.fs`: the tab
  described above serves it from the container over this plugin's own route.
* `present` declarations and the `@` file picker resolve through the local `ctx.fs`, so neither can
  name a container file.
* Routed reads and writes do not pass through `ctx.fs`, so the read-before-write observation policy
  never sees them. It is not a guard for container paths.
* A forwarded connection's bytes cross the resident channel base64-encoded inside JSON lines —
  about a third more traffic than the payload, sharing one pipe with the file tools. That is the
  right trade for a dev server and the wrong one for moving large files.

## Development

Eleven of the sixteen suites are container-free and run anywhere:

```sh
npm install
npm run test:unit       # no target required
npm test                # all sixteen; the rest need a live dev container
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
