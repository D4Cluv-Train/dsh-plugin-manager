# dsh-plugin-manager

在 web GUI 侧边栏添加 **"插件"** 按钮，用于查看和管理**自行安装**的插件（`dsh plugin --profile web add` 安装的 bundle，不含 dsh-base / dsh-web-app 等官方自带）。

## 功能

- **状态展示**：弹窗列出已安装插件，显示运行状态（运行中 / 加载失败 / 加载中 / 已关闭）。
- **启用 / 关闭**：每个插件带开关，可随时停用或重新启用。
- **统一生效**：在弹窗里勾选后，关闭弹窗时一次性应用所有更改。
  - 纯 host 插件即时生效；
  - 含界面组件的插件会弹出提示，刷新页面（或重启 dsh）后生效。
- **发现插件**：弹窗含"发现"标签页，浏览 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 收录的社区插件，可一键安装。

## 安装

一行命令安装：

```bash
dsh plugin --profile web add @d4cluvtrain/dsh-plugin-manager
```

其他来源同样可用（`dsh plugin add` 转发给 pnpm，支持任意 spec）：

- Git 仓库（需要仓库含 `prepare` 脚本，且 pnpm ≥10 需在 profile 的 `pnpm-workspace.yaml` 放行其构建）：
  ```bash
  dsh plugin --profile web add git+https://github.com/D4Cluv-Train/dsh-plugin-manager.git#main
  ```
- tarball / 本地路径：
  ```bash
  dsh plugin --profile web add /path/to/dsh-plugin-manager-0.1.0.tgz
  ```

命令会把包安装进 `~/.dsh/profiles/web/node_modules`，并追加到该 profile 的 `dsh.profile.bundles`。

> 安装 / 修改后需**重启 dsh web**，插件才会挂载。

## 使用

1. 重启 dsh web 后，浏览器打开；
2. 侧边栏设置按钮上方出现 **"插件"** 按钮，点击弹出弹窗；
3. 查看插件状态，或切换开关；关闭弹窗后生效。

## 移除

```bash
dsh plugin --profile web remove @d4cluvtrain/dsh-plugin-manager
```

## 构建（开发）

```bash
npm install
npm run build
```
