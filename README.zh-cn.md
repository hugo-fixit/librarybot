# librarybot

[English](./README.md) | 中文

一个 GitHub Action，用于把 npm 上的第三方库同步到仓库内指定目录（例如 `assets/lib`），并自动更新 CDN 配置与版本清单；适合维护 Hugo 主题/组件等“本地 vendored 依赖”场景。

## 功能

- 从 npm 获取指定包的 `dist-tags.latest` 版本
- 下载并解压 tarball
- 按配置将文件/目录同步到本地（默认文件复制；`type: dir` 表示目录复制）
- 自动移除本地 `.js/.css` 末尾的 `sourceMappingURL`，避免 sourcemap 404
- 更新 CDN 配置文件中的 `pkg@旧版本` → `pkg@新版本`
- 更新配置文件中对应依赖的 `version`
- 为每个依赖提供可复用的分支名（用于“每个依赖一个 PR”的 workflow）

## 配置：`librarybot.yml`

仓库根目录默认读取 `./librarybot.yml`（可通过 `config_path` 指定）。

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

规则说明：

- `schemaVersion`：目前固定为 `1`
- `baseDir`：必填，本地同步输出的根目录
- `libraries[].npm`：npm 包名（支持 scope 包，例如 `@waline/client`）
- `libraries[].version`：当前版本（必须是合法 semver，才会尝试升级）
- `libraries[].local.items[]`：
  - 默认是文件复制：只写 `from/to` 即可
  - 目录复制需显式写 `type: dir`，可选 `clean: true` 表示复制前清空目标目录
  - `from` 永远相对于 npm 包解压后的 `package/` 目录
  - `to` 永远相对于 `baseDir`

## 使用方式

### 在其他仓库中使用

```yml
- name: Update one library
  uses: hugo-fixit/librarybot@v1
  with:
    mode: update
    library: aplayer
    config_path: ./librarybot.yml
```

### Inputs

- `mode`：`list` 或 `update`（默认 `update`）
- `library`：要更新的 npm 包名（`mode=update` 时必填）
- `config_path`：配置文件路径（默认 `./librarybot.yml`）
- `cdn_files`：要更新的 CDN 配置文件（逗号分隔），默认 `./assets/data/cdn/jsdelivr.yml,./assets/data/cdn/unpkg.yml`
- `update_cdn`：是否更新 CDN 配置（默认 `true`）
- `update_local`：是否同步本地文件/目录（默认 `true`）
- `npm_registry`：npm registry（默认 `https://registry.npmjs.org`）

### Outputs（`mode=update`）

- `changed`：是否产生工作区变更（`true/false`）
- `from_version`：旧版本
- `to_version`：新版本
- `package`：npm 包名
- `pr_branch`：建议用于 PR 的分支名（例如 `librarybot/aplayer-1.10.2`）

## Workflow 示例：每个依赖一个 PR

下面示例会先 `list` 出所有依赖，然后用 matrix 为每个依赖各自创建 PR。

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

建议在仓库 Settings → Actions → General 将 Workflow permissions 设为“Read and write permissions”。

## 本地开发

```bash
npm install
npm run typecheck
npm run build
```

Action 使用 `esbuild` 将源码打包到 `dist/index.cjs`；发布前需要提交最新的 `dist/` 产物。
