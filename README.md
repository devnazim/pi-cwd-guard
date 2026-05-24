# pi-cwd-guard

A small [Pi](https://github.com/earendil-works/pi) extension package that asks before built-in file tools access paths outside the current working directory.

## What it guards

The extension intercepts these built-in tools:

- `read`
- `write`
- `edit`

It does not hard-block shell commands such as `rm` run through `bash`, but it adds advisory prompt guidance telling the agent to ask before intentionally using scripts to access files outside `process.cwd()`.

Before each guarded tool runs, it strips a leading `@` the same way Pi's built-in file tools do, then resolves the tool's `path` argument against the current working directory.

- If the resolved path is inside the current working directory, the tool runs normally.
- If the resolved path is outside the current working directory, Pi asks for confirmation.
- If no UI is available, outside-cwd access is blocked by default.
- For `bash`, Python, Node.js, and other scripts, protection is advisory prompt guidance only.

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
