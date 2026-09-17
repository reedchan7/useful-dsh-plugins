# useful-dsh-plugins

English | [中文](README_CN.md)

A collection of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugins,
developed as independent packages in one Bun workspace.

## Plugins

| Plugin                                              | What it does                                                                                                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@reedchan7/dsh-cost`](plugins/dsh-cost/README.md) | Estimated API cost for the current session, the current turn and today (all projects) in DSH's composer stats row, with a per-model breakdown panel. Follows the DSH language and the reader's timezone. |

## Quick start

```sh
git clone https://github.com/reedchan7/useful-dsh-plugins
cd useful-dsh-plugins
make setup          # bun install + lefthook git hooks (needs a git repository)
make check          # format, lint, types, docs pairing, tests, build
```

Install a plugin into your DSH profile:

```sh
make install                                             # link this checkout into the `web` profile
make install PLUGIN='github:reedchan7/useful-dsh-plugins#v0.1.0'   # or a pinned git tag
make uninstall                                           # remove it again
```

Then restart `dsh web` and hard-refresh the browser.

## Repository layout

```
plugins/*     one package per plugin; each ships a DSH bundle and, optionally, a browser half
lib/          shared TypeScript libraries, inlined into plugin builds (never a runtime dependency)
scripts/      build orchestration
templates/    the skeleton `make new NAME=...` copies
tools/        repository tooling (docs pairing, commit message, scaffolding)
```

Two constraints shape this layout, and both were verified against DSH 0.1.5 and Bun 1.4:

- **A plugin package has zero runtime dependencies.** DSH installs plugins into a profile with
  `dsh plugin`, which forwards to pnpm; neither pnpm nor bun installs a linked package's transitive
  dependencies, so anything a plugin imports at runtime must be inlined into its own `lib/` by
  `scripts/build-plugins.ts`. That is why `lib/*` is shared as source only.
- **The browser half is a `window.__ModuleLoader__.load(...)` bundle**, not an ES module. DSH's
  client module table fetches `lib/client.js`, hands the factory a `require` bound to the platform
  module table (react, react-dom, `@deepseek-ai/dsh-client-*`), and expects `apply`/`inject` back.
  `bun build` emits exactly that with a banner and a footer; `plugins/dsh-cost/tests/client-bundle.test.ts`
  asserts the contract so a build regression cannot reach the browser.

See [AGENTS.md](AGENTS.md) for the conventions a new plugin must follow and
[plugins/dsh-cost/README.md](plugins/dsh-cost/README.md) for the first plugin in detail.

## Development commands

Grouped in the Makefile; `make help` prints the same groups.

| Command                     | Purpose                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `make env` / `make doctor`  | Show the resolved toolchain, and check the profile before installing |
| `make check`                | Run every quality gate (format, lint, types, docs, tests, build)     |
| `make test`                 | Run the test suite (Bun's test runner)                               |
| `make build`                | Build every plugin into `plugins/<name>/lib`                         |
| `make pack`                 | Produce an installable tarball per plugin                            |
| `make publish`              | Publish the plugins to npmjs.com (requires `npm login`)              |
| `make verify SESSION=<id>`  | Query the running host for one session's cost summary                |
| `make new NAME=dsh-example` | Scaffold a new plugin                                                |

Git hooks (lefthook) format and lint staged files on commit, check the README pairing when one side
changes, and run type checking plus the changed tests on push. `make hooks` installs them into a git
repository; run `git init` first in a fresh checkout.

## Documentation language

Code, comments, commit messages and English documents are written in English. Each `README.md` has a
`README_CN.md` counterpart, and `make docs-check` fails when one is missing or has drifted in
structure.

## License

[MIT](LICENSE)
