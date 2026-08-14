# dsh-hello-plugin

一个最小可用的 **dsh bundle 插件**（MVP），用来验证"一个插件包能被
`dsh plugin --profile web add` 安装进 dsh 并成功加载"，并演示如何同时提供
**host 端插件**（服务器侧能力）与 **client 端插件**（浏览器 UI）。

插件做的事：

**Host 端（服务器侧）**
1. 注册路由 **`GET /hello-plugin`** —— 浏览器访问
   `http://127.0.0.1:3080/hello-plugin` 返回一段 JSON（最直观的加载证明）；
2. 向 dsh home（`$DSH_HOME` 或 `~/.dsh`）写入标记文件 `dsh-hello-plugin.loaded`；
3. 打一条 apply 日志；
4. 自动出现在 web GUI 的 **Settings → Plugins** 列表里
   （plugin-inventory 投影 Loader 树，状态 `active`）。

**Client 端（浏览器 UI）**
5. 在侧边栏**设置按钮上方**添加一个 **"插件"** 按钮（`sidebar.footer.action`
   插槽，图标 `IconCordisPluginOutline14`，宽栏显示图标+文字、收窄为圆形图标）；
6. 点击按钮弹出**弹窗**，展示**自行安装的插件列表**（仅 `dsh plugin add`
   安装的 bundle，不含 dsh-base / dsh-web-app 等官方自带的）；
7. 附带一个简短的本地化字典（zh/en）和自动注入的样式。

零运行时依赖：host 只用 Node 内置模块 + `@deepseek-ai/dsh-typert-protocol`
（由安装闭包解析）；client bundle 只 import 平台模块（react、ui-primitives
等），由浏览器模块表解析。

## 目录结构

```
dsh-plugin-manager/
├── package.json        # dsh.bundle.patch（host bundle）+ dsh.client（web 客户端）
├── cordis.patch.yml    # bundle 补丁层：插入 hello-plugin 与 hello-plugin-installed 条目
├── lib/plugin.mjs      # host 插件本体（/hello-plugin 路由 + 标记文件）
├── lib/installed-plugins.js  # 构建产物：installedPlugins Typert remote 服务
├── lib/client.js       # 构建产物：浏览器 client bundle（loader 格式）
├── src/host/installed-plugins.js  # host remote 源码（@Remote 装饰器）
├── src/client/index.jsx # client 插件源码（侧边栏按钮 + 插件列表弹窗）
├── scripts/build.mjs   # esbuild 构建 client + host 产物
├── scripts/verify-client.mjs  # loader 契约模拟验证（无浏览器）
├── scripts/smoke.mjs   # host 隔离冒烟测试
└── scripts/restart-web.sh    # GUI 重启脚本
```

## 工作原理

一个 dsh bundle 是普通的 npm 包，其 `package.json` 带有：

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

`cordis.patch.yml` 是一个 loader patch 列表，往 profile 的条目树里插入插件条目：

```yaml
- insert:
    - id: hello-plugin            # /hello-plugin 路由（inject: webServer）
      name: dsh-hello-plugin
    - id: hello-plugin-installed  # installedPlugins Typert remote 服务
      name: dsh-hello-plugin/installed-plugins
```

`name` 是模块标识符，从 profile 目录经 `node_modules` 解析（`dsh plugin add`
把包装进 `~/.dsh/profiles/web/node_modules`）。插件模块导出标准 Cordis 插件形状
（`name` / `inject` / `apply`），`inject: ['webServer']` 保证在 web 表面就绪后才
挂载。

**Client 端是如何被发现的**：host 的 `client-modules` 插件扫描 Loader 条目，凡包
声明了 `dsh.client`（platform `web`）且 `exports["./client"]` 指向构建产物，就把它
作为浏览器 bundle 纳入 `window.__DSH_BOOT__` 启动清单，服务在
`/plugins/<包名>/client.js`。`dsh.client.inject` 是浏览器侧的依赖边（先加载
runtime/layout/locale/sidebar 等 client 插件）。

**弹窗列表的数据从哪来**：`hello-plugin-installed` 条目提供 Typert remote
服务 `installedPlugins/list`（`TypertRemoteService` + `@Remote` 装饰器，源码在
`src/host/installed-plugins.js`，esbuild 编译装饰器语法）。它读取 profile 的
`package.json`，返回 `dsh.profile.bundles` 与 `dependencies` 的交集——官方模板
bundle（dsh-base、dsh-web-app）不是 profile 的 dependencies（它们从 dsh 安装
解析），所以天然被排除。

**浏览器端如何连上这个 host 服务**：浏览器的 `ctx.remote` 不会自动发现 host
端注册的 Typert 服务——内置装配 `@deepseek-ai/dsh-api-remotes` 只挂载它自己
硬编码的贡献（commands/goals/dynamic/pluginInventory/messageFeedback）。所以
本插件的 client bundle 必须**自己挂载**：`apply` 里先
`await ctx.remote.$mount(INSTALLED_PLUGINS_REMOTE)`（一个 namespace 为
`installedPlugins`、method 为 `list` 的 contribution，带 strict result codec，
与 host 端绑定一致），`remote.installedPlugins` 服务才诞生。

**为什么不能在 `inject` 里声明 `remote.installedPlugins`、也不能用
`ctx.remote.installedPlugins` 关联访问**：内置 remote（如 `remote.commands`）
由 `api-remotes` 在 boot 早期挂载，消费插件可以 `inject: ['remote.commands']`
把它绑定到自己 fiber 的 store，从而运行时关联访问可用。但本插件的
`remote.installedPlugins` 由**插件自己**在 `apply` 里挂载——放进 `inject` 会
让 boot 一直等待一个只有自身 apply 时才会创建的服务（死等）；而
`ctx.remote.installedPlugins` 的关联访问只沿当前插件 fiber 的父链查找，无法
看到注册在 gateway（兄弟 fiber）上的服务，会抛 `cannot get property
"remote.installedPlugins" without inject`。因此 `apply` 在 `$mount` 之后用
`ctx.get('remote.installedPlugins')`（读共享 root store，不受 fiber 隔离限制）
取到服务引用并注入弹窗回调，点击时经它调用 host。

## 构建

改完 `src/client/index.jsx` 或 `src/host/installed-plugins.js` 后重新构建
（esbuild 为 devDependency）：

```bash
npm run build            # 产出 lib/client.js + lib/installed-plugins.js
node scripts/verify-client.mjs   # loader 契约模拟验证（含 remote 调用断言）
```

## 安装到 web profile

在仓库根目录（或任意位置）执行：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-plugin-manager
```

命令会：初始化 profile（如未初始化）→ 用 pnpm 把包装进
`~/.dsh/profiles/web/node_modules` → 若包声明了 `dsh.bundle.patch`，则把它追加到
`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`。

> 注意：bundle 层与 client 插件清单只在 dsh 启动时解析，所以安装/修改后需要
> **重启 dsh web**，新插件（含 UI）才会挂载。

## 验证加载

**静态验证（无需重启）** —— 打印组合后的 profile 树，应能看到 `hello-plugin` 条目：

```bash
dsh --profile web --dump-config
```

**运行时冒烟测试（隔离，不碰真实 DSH_HOME、不占端口）**：

```bash
node scripts/smoke.mjs
```

它会在临时 DSH_HOME 里建一个最小 profile（装上本包 + 一个 stub webServer），
启动 `apps/cli/lib/bin.js --profile smoke`，等待 `dsh-hello-plugin.loaded`
标记文件出现并确认 `/hello-plugin` 路由被注册，然后 PASS。

**GUI 实测（需要重启 dsh web 后）**：

1. 重启 dsh web；
2. 浏览器访问 `http://127.0.0.1:3080/hello-plugin`，看到 JSON 即 host 加载成功；
3. 或在 GUI 的 Settings → Plugins 里看到 `hello-plugin`（模块
   `dsh-hello-plugin`，状态 active）；
4. 侧边栏设置按钮上方出现 **"插件"** 按钮 → 点击弹出弹窗，列出自行安装的
   插件（当前为 `dsh-hello-plugin`，不含官方自带 bundle）。

## 移除

```bash
dsh plugin --profile web remove dsh-hello-plugin
```

卸载后包会从依赖与 `dsh.profile.bundles` 中移除，重启 dsh web 即不再挂载。
（注意：卸载会把 `dsh-hello-plugin` 从 bundles 移除，弹窗列表随之清空。）
