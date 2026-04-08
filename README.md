# librarybot

English | [中文](./README.zh-cn.md)

A GitHub Action that syncs third-party libraries from npm into a local directory (e.g. `assets/lib`), and updates CDN config files plus the dependency versions in `librarybot.yml`. Useful for Hugo themes/components and other “vendored dependency” workflows.

## Features

- Resolves `dist-tags.latest` from npm
- Downloads and extracts the package tarball
- Syncs configured files/directories into your repo (files by default; `type: dir` for directories)
- Strips trailing `sourceMappingURL` from local `.js/.css` files to avoid sourcemap 404s
- Replaces `pkg@oldVersion` → `pkg@newVersion` in CDN config files
- Bumps the corresponding `version` in `librarybot.yml`
- Emits a reusable `pr_branch` output (handy for “one dependency per PR” workflows)

## Config: `librarybot.yml`

By default, this action reads `./librarybot.yml` from the repository root (override via `config_path`).

```yml
schemaVersion: 1
baseDir: assets/lib
libraries:
  - npm: aplayer
    version: 1.10.1
    local:
      items:
        - from: dist/APlayer.min.css
          to: aplayer/APlayer.min.css
        - from: dist/APlayer.min.js
          to: aplayer/APlayer.min.js

  - npm: simple-icons
    version: 9.19.0
    local:
      items:
        - type: dir
          from: icons
          to: simple-icons/icons
          clean: true
```

Rules:

- `schemaVersion`: currently fixed to `1`
- `baseDir`: required; local sync destination root
- `libraries[].npm`: npm package name (scoped packages supported, e.g. `@waline/client`)
- `libraries[].version`: current version (must be a valid semver to be upgraded)
- `libraries[].local.items[]`:
  - Defaults to file copy: omit `type` and only set `from/to`
  - For directories use `type: dir`; optional `clean: true` clears the destination before copying
  - `from` is always relative to the extracted `package/` directory
  - `to` is always relative to `baseDir`

## Usage

### Use in another repository

```yml
- name: Update one library
  uses: hugo-fixit/librarybot@v1
  with:
    mode: update
    library: aplayer
    config_path: ./librarybot.yml
```

### Inputs

- `mode`: `list` or `update` (default: `update`)
- `library`: npm package name to update (required when `mode=update`)
- `config_path`: config file path (default: `./librarybot.yml`)
- `cdn_files`: comma-separated list of CDN YAML files to update (default: `./assets/data/cdn/jsdelivr.yml,./assets/data/cdn/unpkg.yml`)
- `update_cdn`: whether to update CDN config files (default: `true`)
- `update_local`: whether to sync local files/directories (default: `true`)
- `npm_registry`: npm registry base url (default: `https://registry.npmjs.org`)

### Outputs (`mode=update`)

- `changed`: whether the working tree changed (`true/false`)
- `from_version`: previous version
- `to_version`: updated version
- `package`: npm package name
- `pr_branch`: suggested PR branch name (e.g. `librarybot/aplayer-1.10.2`)

## Workflow example: one dependency per PR

This example lists all dependencies first, then uses a matrix job to open a PR per dependency.

```yml
name: Update libraries from npm
on:
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      libraries: ${{ steps.list.outputs.libraries_json }}
    steps:
      - uses: actions/checkout@v6
      - id: list
        uses: hugo-fixit/librarybot@v1
        with:
          mode: list
          config_path: ./librarybot.yml

  update:
    needs: prepare
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        library: ${{ fromJson(needs.prepare.outputs.libraries) }}
    steps:
      - uses: actions/checkout@v6
      - id: update
        uses: hugo-fixit/librarybot@v1
        with:
          mode: update
          library: ${{ matrix.library }}
          config_path: ./librarybot.yml
      - name: Create Pull Request
        if: steps.update.outputs.changed == 'true'
        uses: peter-evans/create-pull-request@v8
        with:
          title: 'chore(deps): bump ${{ steps.update.outputs.package }} to ${{ steps.update.outputs.to_version }}'
          commit-message: 'chore(deps): bump ${{ steps.update.outputs.package }} to ${{ steps.update.outputs.to_version }}'
          branch: ${{ steps.update.outputs.pr_branch }}
          body: |
            Automated update of `${{ steps.update.outputs.package }}` from `${{ steps.update.outputs.from_version }}` to `${{ steps.update.outputs.to_version }}`.
          labels: dependencies
```

In repository Settings → Actions → General, set “Workflow permissions” to “Read and write permissions”.

## Local development

```bash
pnpm install
pnpm typecheck
pnpm build
```

This action is bundled with `esbuild` into `dist/index.cjs`. Before releasing, commit the updated `dist/` output.
