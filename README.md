# pi-cwd-guard

A small [Pi](https://github.com/earendil-works/pi) safety extension package for cwd access, protected paths, runtime config confirmation, and common destructive bash commands.

## What it guards

The extension intercepts these built-in tools:

- `read`
- `write`
- `edit`
- `bash`

### Current working directory guard

Before `read`, `write`, or `edit` runs, the extension strips a leading `@` the same way Pi's built-in file tools do, then resolves the tool's `path` argument against the current working directory.

- If the resolved path is inside the current working directory, the tool continues to the next checks.
- If the resolved path is outside the current working directory and is not covered by `allowedOutsideCwdPaths`, Pi asks for confirmation.
- If no UI is available, outside-cwd access is blocked by default unless the path is covered by `allowedOutsideCwdPaths`.

### Configuring path exceptions

You can allow specific outside-cwd paths with JSON config files:

- Project-local: `.pi/pi-cwd-guard.json`
- Global: `~/.pi/agent/extensions/pi-cwd-guard.json`

Example:

```json
{
  "allowedOutsideCwdPaths": [
    "/tmp",
    "/var/tmp",
    "~/shared-workspace",
    "../sibling-project"
  ],
  "allowedDestructiveBashPaths": [
    "/tmp/pi-web-video2"
  ]
}
```

Notes:

- Multiple paths are supported.
- Matching is recursive: allowing `/tmp` allows `/tmp/foo/bar.txt`.
- `~` expands to your home directory.
- Absolute paths are used as-is.
- Relative paths in project config resolve against the current working directory.
- Relative paths in global config resolve against `~/.pi/agent/extensions`.
- Project and global path lists are merged independently.
- `allowedOutsideCwdPaths` only skips outside-cwd confirmation. It does not bypass hard-protected path blocks, runtime config confirmation, or destructive bash confirmation.
- `allowedDestructiveBashPaths` skips the destructive bash confirmation only for recognized `rm` commands when every static absolute or `~/...` target is recursively covered.
- Relative, dynamic, or ambiguous targets, mixed allowed/disallowed targets, redirections on the `rm` segment, and unrelated destructive operations still require confirmation.
- Existing path ancestors are resolved through symlinks before applying an exemption. This remains a heuristic preflight check, not a sandbox or protection against filesystem races.

You can also inspect or update the config from Pi with the `/cwd-guard` command:

```text
/cwd-guard
/cwd-guard show
/cwd-guard allow /tmp --project
/cwd-guard allow /tmp --global
/cwd-guard allow /tmp /var/tmp ~/shared-workspace --project
/cwd-guard allow "/tmp/my folder" --project
/cwd-guard allow-destructive /tmp/pi-web-video2 --project
```

Command notes:

- `/cwd-guard` opens an interactive menu for showing config or adding exceptions. Without UI, it displays the merged active configuration.
- `/cwd-guard show` displays the merged active configuration.
- Typing `/cwd-guard ` in interactive mode autocompletes subcommands; both allow commands autocomplete `--project` / `--global`.
- `allow <path...> --project|--global` updates `allowedOutsideCwdPaths`.
- `allow-destructive <path...> --project|--global` updates `allowedDestructiveBashPaths`.
- Global updates write `~/.pi/agent/extensions/pi-cwd-guard.json` and ask for confirmation first.
- Paths added by the command are written as absolute resolved paths.
- Command arguments support shell-style single quotes, double quotes, and backslash escapes for paths with spaces.

### Hard-protected paths

`write` and `edit` are blocked for sensitive, vendor, or generated paths such as:

- `.env`, `.env.*`
- `secrets/`, `.secrets/`, `credentials/`, `.credentials/`
- `.npmrc`, `.pypirc`, `id_rsa`, `id_ed25519`, kubeconfig files
- common credential JSON files such as `secrets.json`, `credentials.json`, `client_secret.json`, service-account JSON files
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- `node_modules/`
- generated/build output dirs like `dist/`, `build/`, `coverage/`, `.next/`, `.nuxt/`, `generated/`

These are hard-blocked rather than confirmed.

### Runtime config confirmation

`write` and `edit` ask for confirmation before changing likely runtime config, including paths like `env.ts`, `runtime-config.ts`, `app-config.ts`, `config.ts`, `config.json`, `appsettings.json`, `application.yml`, deployment config such as `docker-compose.yml`, `serverless.yml`, `vercel.json`, `netlify.toml`, `wrangler.toml`, and config files under config-ish/deployment directories such as `config/*.ts`, `config/*.json`, `k8s/*.yaml`, or `infra/*.tfvars`. For config-ish files/directories only, edits containing obvious environment/API markers also ask for confirmation, such as:

- `BASE_URL`
- `API_URL`
- `PUBLIC_*`
- `*_KEY`
- `*_TOKEN`
- `CLIENT_ID`
- `CLIENT_SECRET`
- `process.env`
- `znv`

If no UI is available, runtime config changes are blocked by default.

### Permission prompt notifications

If [pi-cmux](https://www.npmjs.com/package/pi-cmux) is installed, `pi-cwd-guard` sends a best-effort cmux notification/status update whenever it opens a permission confirmation. This is optional and no-ops when pi-cmux is not present.

### Common destructive bash confirmation

`bash` asks for confirmation before common destructive commands such as:

- recursive/forced `rm`
- `sudo`
- dangerous `chmod`
- recursive `chown`
- `git reset --hard`
- `git clean -fd`

This is intentionally heuristic and small. It does not parse shell scripts, inspect script files, or sandbox Python/Node.js/other scripts. Recognized forced or recursive `rm` commands skip confirmation when every static absolute or home-relative target is under an `allowedDestructiveBashPaths` entry. A compound command may precede the exempted `rm` only with recognized `mkdir -p` operations under the same allow-list. Commands with relative, dynamic, ambiguous, mixed, or symlink-escaping targets remain confirm-by-default. Other destructive patterns such as `sudo` and Git operations are never path-exempted.

For scripts, the extension adds advisory prompt guidance telling the agent to ask before intentionally accessing paths outside `process.cwd()` unless the path is covered by configured `allowedOutsideCwdPaths`. That guidance includes both active merged path lists for the current cwd so agents can recognize configured exceptions.

## Install

From npm:

```sh
pi install npm:pi-cwd-guard
```

From a local checkout:

```sh
pi install /absolute/path/to/pi-cwd-guard
```

Or test for one run:

```sh
pi -e /absolute/path/to/pi-cwd-guard
```

The package also includes a root `index.ts` shim, so direct extension-directory configuration such as `"extensions": ["/absolute/path/to/pi-cwd-guard"]` works too.

## Compatibility

`pi-cwd-guard` uses Pi's extension API via a peer dependency and requires `@earendil-works/pi-coding-agent` 0.80.3 or newer.

## Development

```sh
npm install
npm test
npm run typecheck
npm run pack:dry-run
```

## Package manifest

This package exposes its extension through:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```
