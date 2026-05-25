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
- If the resolved path is outside the current working directory, Pi asks for confirmation.
- If no UI is available, outside-cwd access is blocked by default.

### Hard-protected paths

`write` and `edit` are blocked for sensitive, vendor, or generated paths such as:

- `.env`, `.env.*`
- `secrets/`, `.secrets/`, `credentials/`, `.credentials/`
- `.npmrc`, `.pypirc`, `id_rsa`, `id_ed25519`, kubeconfig files
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- `node_modules/`
- generated/build output dirs like `dist/`, `build/`, `coverage/`, `.next/`, `.nuxt/`, `generated/`

These are hard-blocked rather than confirmed.

### Runtime config confirmation

`write` and `edit` ask for confirmation before changing likely runtime config, including paths like `env.ts`, `runtime-config.ts`, `app-config.ts`, and config edits containing obvious environment/API markers such as:

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

### Common destructive bash confirmation

`bash` asks for confirmation before common destructive commands such as:

- recursive/forced `rm`
- `sudo`
- dangerous `chmod`
- recursive `chown`
- `git reset --hard`
- `git clean -fd`

This is intentionally heuristic and small. It does not parse shell scripts, inspect script files, or sandbox Python/Node.js/other scripts. For scripts, the extension adds advisory prompt guidance telling the agent to ask before intentionally accessing paths outside `process.cwd()`.

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

## Development

```sh
npm install
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
