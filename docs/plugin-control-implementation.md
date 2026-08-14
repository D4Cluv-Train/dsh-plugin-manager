# 自下载插件控制功能 —— 实施文档

> 目标：为 `dsh-plugin-manager` 增加对**自行安装插件**的状态展示、启用/关闭控制，
> 并在关闭弹窗时统一生效（可热加载的即时生效；不可热加载的弹出提示，告知需重启/刷新）。

---

## 1. 背景与技术原理

在动手前必须理解的四个底层事实（全部来自 `deepseek-harness` checkout，路径以
`DH = <checkout>` 代指）：

1. **插件没有独立 `enabled` 字段**。插件"启用"是结构性的：是 profile 依赖 + 在
   `dsh.profile.bundles` 里 + 包声明 `dsh.bundle.patch`。`dsh plugin` 只是 pnpm
   转发器，没有 enable/disable 子命令（`DH/apps/cli/src/plugin.ts`）。

2. **真正的激活开关是 Loader 条目的 `disabled` 标志**：
   - `EntryOptions.disabled?: boolean | null` — `DH/vendor/loader/src/config/entry.ts:8-22`
   - patch 语言支持 id 定向覆盖 `{ id: '<entry-id>', disabled: true }`，
     语义为"整值覆盖、后层胜出" — `DH/vendor/include/src/index.ts:58-128`
   - 运行时可实时卸载/挂载：`Entry.update({ disabled })` 走 `_dispose`/`_start`
     — `DH/vendor/loader/src/config/entry.ts:142-246`

3. **profile 自己的 `cordis.patch.yml` 是"用户覆盖层"**，在 bundle 层**之后**应用
   （后胜出），且被 HMR 监听，改动即热生效：
   - 层序：bundle patches → profile `cordis.patch.yml` → home `cordis.patch.yml`
     → `--patch` → 合成层 — `DH/apps/cli/src/profile-boot.ts:142-171`
   - 热更新：`watchUserPatches` 监听该文件 → `hmr.registerConfig` →
     `entry.update(...)` — `DH/packages/boot/app-boot/src/index.ts:232-265`
   - 关键推论：`applyEntryPatches` 会把所有层**拍平成一张 patch 列表**再作用到空
     根上（`DH/packages/boot/app-boot/src/profile.ts:413-420`），且对 `insert` 出的
     行**即时建索引**（`vendor/include/src/index.ts:101`）。因此 profile 层里的
     `{ id: hello-plugin, disabled: true }` 能命中 bundle 层 `insert` 出的同名 id。

4. **客户端清单会随 `disabled` 实时重算，但浏览器不会自动卸载**：
   - `client-modules` 增量扫描以 `entry.fiber !== undefined && !entry.disabled`
     为资格条件（`DH/packages/client/modules/src/index.ts:384-401`），禁用后服务端
     注入的 `window.__DSH_BOOT__` 会**立即移除该 client bundle 行**。
   - 但浏览器端 HMR 只处理 `rebuilt`（bundle **内容**变化）帧，`graph` 帧被
     注释为 unused — `DH/packages/client/hmr/src/client/index.ts:146-164`。
   - **结论**：host 半体永远可热；client 半体（声明 `dsh.client`）需**刷新页面**
     （`location.reload()`，因为服务端清单已实时重算，刷新即拿到新清单）。

---

## 2. 总体架构与数据流

```
弹窗(列表+开关) ──(关闭时聚合)──► installedPlugins/apply([{name, enabled}])
                                    │  host 侧
                                    ├─ 写 profile cordis.patch.yml（合并写盘）
                                    ├─ HMR 实时生效（host 半体）
                                    └─ 返回 { needsReload, names }
                                    │
         (若 needsReload) ──► 第二弹窗：提示重启/刷新（附 location.reload() 按钮）
```

新增/改动的文件：

| 文件 | 改动 |
|---|---|
| `src/host/installed-plugins.js` | `list` 扩展状态；新增 `apply`（+ 可选 `setEnabled`） |
| `src/host/plugin-patches.js`（新增） | `cordis.patch.yml` 合并读写工具（纯函数） |
| `src/client/index.jsx` | 列表项加 switch + 状态徽标；统一提交；第二弹窗 |
| `package.json` | 新增运行时依赖 `js-yaml` |

---

## 3. 实施要点

### 3.1 host 服务：`list` 状态展示

**技术细节**
- 给 `InstalledPluginsGateway` 增加 `static inject = ['loader']`（参照
  `DH/packages/host/plugin-inventory/src/index.ts:43-44`）。
- `list()` 在现有"profile bundles ∩ dependencies"基础上，用
  `this.ctx.loader.entries()` 交叉匹配，返回每个包的运行状态。
- `FiberState` 是跨包 const enum：`PENDING=0/LOADING=1/ACTIVE=2/FAILED=3/
  DISPOSED=4/UNLOADING=5`；映射表照抄 `plugin-inventory`：
  `{ pending, loading, active, failed, null(unloading→'unloading') }`
  （`DH/packages/host/plugin-inventory/src/index.ts:23-40`）。

```js
import { readFileSync } from 'node:fs'
// ... 现有导入
const FIBER_PHASE = {
  0: 'pending', 1: 'loading', 2: 'active',
  3: 'failed', 4: null, 5: 'unloading',
}

function entriesFor(ctx, pkg) {
  const rows = []
  for (const entry of ctx.loader.entries()) {
    const name = entry.options.name
    if (name === pkg || name.startsWith(`${pkg}/`)) {
      rows.push({
        entryId: entry.options.id,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      })
    }
  }
  return rows
}
```

- 每个包聚合：`enabled = rows.every(r => r.enabled)`；`fiberPhase` 取最差相位
  （`failed > unloading > loading > pending > active`，`null` 视为已停用）。

**重点注意事项**
- 用 `entry.options.id`（原始 id，`applyEntryPatches` 建索引的键），**不要**用
  `entry.id` getter——后者对嵌套子树的 entry 会拼上父前缀
  （`DH/vendor/loader/src/config/entry.ts:75-81`），与写盘目标 id 不一致。
- `ctx.loader.entries()` 对 disabled 的条目仍会返回（`disabled` 不删除条目，只是
  不运行），所以**禁用后仍能读到 id**，映射函数对开/关状态通用。
- 跳过 `entry.options.group` 的行（group 永远 `enabled`，见
  `entry.ts:88-98`）。

### 3.2 host 服务：`apply` 启用/关闭

**技术细节**
- 新增 `@Remote('apply') apply(changes)`，入参 `changes: [{ name, enabled }]`。
- 处理流程：
  1. 对每个 change，用 `entriesFor(ctx, name)` 拿到该包的 entry id 集合；
  2. 调写盘模块（见 3.3）把 `{ id, disabled: true }` 覆盖写入/移出 profile
     `cordis.patch.yml`；
  3. 写盘后 HMR 会自动 dispose/re-enable 对应 host 条目（无需手动调
     `entry.update`，除非要做失败回读校验）；
  4. 判定 `needsReload`（见 3.6），返回 `{ needsReload, names }`。
- 结果校验：写盘后回读该文件，确认目标 id 的 `disabled` 值与请求一致；不一致则
  在返回里带上 `error`（因为 patch 命中失败时 Loader 只发 warning 不报错，
  `DH/vendor/include/src/index.ts:111-114`）。

**重点注意事项**
- **整包同开同关**：一个 bundle 可能贡献多个 entry（本例 2 个：
  `hello-plugin`、`hello-plugin-installed`），启用/关闭必须一次性覆盖该包全部 id。
- `apply` 是**无鉴权写端点**（与 `goals.*`/`messageFeedback.*` 同级，走 Typert
  gateway）。MVP 可接受，但这是暴露给浏览器的 host 写权限，注意后续收敛。
- 方法命名避开 Typert 保留字；`Remote` 装饰器支持 `@Remote('alias')`
  （`DH/packages/typert/protocol/src/index.ts:168-196`）。

### 3.3 `cordis.patch.yml` 合并写盘模块（新增 `src/host/plugin-patches.js`）

**技术细节**
- 目标文件：`join(fileURLToPath(ctx.baseUrl), 'cordis.patch.yml')`
  （`ctx.baseUrl` 在 boot 时锚定到 profile 目录）。
- 提供两个纯函数：
  - `readPatches(file)`：不存在返回 `[]`；用 `js-yaml` 解析，**必须**注册 `!!js`
    透传类型以保留用户自写的表达式行（类型定义照抄
    `DH/vendor/include/src/index.ts:9-15`）：
    ```js
    import yaml from 'js-yaml'
    const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (d) => typeof d === 'string',
      construct: (d) => ({ __jsExpr: d }),
      predicate: (o) => o && typeof o.__jsExpr === 'string',
      represent: (o) => o.__jsExpr,
    })
    const SCHEMA = yaml.JSON_SCHEMA.extend(JsExpr)
    ```
  - `writePatches(file, mutate)`：读→改→写回，只操作"受管行"。
- **受管行约定**：只有满足 `id ∈ 自装插件 entry id 集合` 且 `disabled` 为布尔值、
  且不含 `insert/name/config/group` 的行，才是本模块可增删的对象；其余（用户的
  `insert`、`!!js`、`config` 等）一律原样保留。
- 变更算法：
  1. `rows = readPatches(file)`；
  2. 剔除 `rows` 中属于目标 entry id 集合的受管布尔 `disabled` 行；
  3. 若本次为"禁用"，`rows.push({ id, disabled: true })`（每个 entry id 一行）；
  4. `yaml.dump(rows, { schema: SCHEMA })` 原子写回（临时文件 + `rename`）。

**重点注意事项**
- **原子写**：HMR 用文件监听/轮询触发重读，非原子写可能读到半截文件。先写
  `cordis.patch.yml.tmp` 再 `rename`（参照 include 的 retryable write：
  `DH/vendor/include/src/index.ts:35-41`，EACCES/EBUSY/EPERM 重试）。
- **只做增量，不做全量覆盖**：不能把用户手写的 patch 行丢掉；尤其 `!!js` 表达式
  和注释要靠带 JsExpr 的 schema 往返保留。
- `js-yaml` 必须进 `dependencies`（运行时依赖），不能只放 `devDependencies`，否则
  装到 profile 后解析不到。它是通用包，`dsh plugin add` 会经 pnpm 正常拉入。
- profile 目录的 `cordis.patch.yml` 初始为 `[]`（`DH/packages/boot/app-boot/src/profile.ts:164-165`），
  首次写盘时 `readPatches` 对不存在文件返回 `[]` 即可。
- 并发：`apply` 里串行处理所有 change 再一次性写盘，避免多次 rename 竞争。

### 3.4 client：Typert contribution 扩展（codec）

**技术细节**
- 现有 `INSTALLED_PLUGINS_REMOTE`（`src/client/index.jsx:75-90`）只挂 `list`。
  需在同一 contribution 的 `descriptors` 里新增 `apply`（及可选 `setEnabled`）。
- 每个 descriptor 结构见 `DH/packages/typert/protocol/src/types.ts:173-211`：
  `{ id, service, namespace, method, invocation, parameters, result }`。
- `result`/`codec` 是 `TypertCodec`（`types.ts:130-147`）：严格模式为
  `{ mode: 'strict', typeSymbol, schema }`，`schema.parse(value)` 校验并归一化。
  沿用现有 `listResultSchema` 的写法（`src/client/index.jsx:59-66`）。
- `apply` 的参数 codec（`InvocationParameterDescriptor`，`types.ts:150-163`）：

```js
const applyChangesSchema = {
  parse(value) {
    if (!Array.isArray(value)) throw new TypeError('apply requires [{ name, enabled }]')
    return value.map(c => ({
      name: String(c?.name),
      enabled: Boolean(c?.enabled),
    }))
  },
}
const applyResultSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object') throw new TypeError('bad apply result')
    return {
      needsReload: Boolean(value.needsReload),
      names: Array.isArray(value.names) ? value.names.map(String) : [],
    }
  },
}

const APPLY_DESCRIPTOR = {
  id: 'dsh-hello-plugin#installedPlugins/apply',
  service: 'installedPlugins',
  namespace: 'installedPlugins',
  method: 'apply',
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'changes', wire: 'changes', source: 'json',
    codec: { mode: 'strict', typeSymbol: 'dsh-hello-plugin#ApplyChanges', schema: applyChangesSchema },
  }],
  result: { mode: 'strict', typeSymbol: 'dsh-hello-plugin#ApplyResult', schema: applyResultSchema },
}
```

- `list` 的 `listResultSchema` 同步扩展：`{ entries: [{ name, enabled, fiberPhase }] }`。

**重点注意事项**
- 手写 codec 是"与 host 绑定一致"的契约：host `list`/`apply` 返回什么、client
  `schema.parse` 就断言什么。两端改动要同步，否则 gateway 解码抛错。
- 严格模式是 client 侧 `$mount` 的硬性要求（现有 `verify-client.mjs` 已断言
  `result.mode === 'strict'` 且 `schema.parse` 是函数），不要退回 `src-json`。
- `$mount` 仍在 `apply` 里、先于 UI 注册执行；`remote.installedPlugins` 仍用
  `ctx.get('remote.installedPlugins')` 取引用（gateway sibling fiber，关联访问不可用）
  —— 这部分不变，见 `src/client/index.jsx:281-289`。

### 3.5 client：UI 扩展（switch + 统一提交 + 第二弹窗）

**技术细节**
- `HelloPluginAction`（`src/client/index.jsx:215-268`）内部新增"待提交变更"状态：
  `pending: Map<name, boolean>`（初值来自 `list` 结果）。
- 列表项渲染 switch + 状态徽标（`active`/`failed`/`disabled`），切换只改 `pending`，
  不立即调 host。
- 关闭弹窗时（`Modal onClose` 或"确定"按钮）执行统一提交：
  ```js
  const changes = [...pending].map(([name, enabled]) => ({ name, enabled }))
  if (changes.length === 0) { setOpen(false); return }
  const result = await installedPlugins.apply(changes)   // 单次 RPC
  if (result.needsReload) {
    setRestartNotice({ open: true, names: result.names })  // 第二弹窗
  } else {
    setOpen(false)
  }
  ```
- 第二弹窗内容：提示"以下插件含界面组件，需重启 dsh（或刷新页面）后生效"，列出
  `names`，附"立即刷新"按钮（`location.reload()`）与"稍后"按钮。

**重点注意事项**
- 提交后要**刷新列表状态**（重新 `list()`），避免 `pending` 与后端漂移。
- "关闭弹窗统一生效"要求**幂等**：同一弹窗内多次开关同一插件只产生一次最终变更；
  若 `apply` 失败（`result.ok === false`）应回滚 `pending` 并就地展示错误，不关弹窗。
- 第二弹窗的文案要区分两个语义（需求原文是"重启 dsh"，但技术上见 §1-4）：
  - 仅 client 半体：**刷新页面**即生效（服务端清单已实时重算）；
  - 真正需要重启 dsh 进程的只有"新增/删除插件"（本功能不涉及）。
  建议文案按需求写"需重启生效"，同时提供"立即刷新"按钮作为更轻量路径。

### 3.6 热加载判定 `needsReload`

**技术细节**
- 判定规则：一个包**是否声明了 `dsh.client`（`platform: 'web'`）**，即是否有 client
  半体。逻辑对齐 `client-modules` 的 `parseDshClient`
  （`DH/packages/client/modules/src/index.ts:109-129`）。
- host 服务实现：对每个 change 的包名，读其 `package.json`（经 profile
  `node_modules` 解析），`pkg.dsh?.client?.platform === 'web'` 即计入 `names`。

```js
function hasClientHalf(profileDir, pkg) {
  try {
    const p = JSON.parse(readFileSync(join(profileDir, 'node_modules', pkg, 'package.json'), 'utf8'))
    return p?.dsh?.client?.platform === 'web'
  } catch { return false }   // 读不到就当纯 host 插件处理
}
```

- 返回 `needsReload = names.length > 0`。

**重点注意事项**
- 判定只看"有没有 client 半体"，**不看** host 半体是否热成功——host 半体永远热。
- 判定结果要基于**本次真正变更**的包，而不是弹窗里所有开关项；未变化的包不触发
  重启提示。
- 缓存可要可不要：包声明极少变，但 `dsh.plugin add/remove` 后才变，而那时本来就要
  重启，所以不缓存、每次现读更简单且无 stale 风险。

### 3.7 自引用豁免

**技术细节**
- `dsh-plugin-manager` 自身会出现在 `installedPlugins/list` 里（它是自装 bundle），
  且它的 `hello-plugin-installed` entry **正是提供管理 UI 的服务**。允许关闭自己会
  让服务/UI 当场消失。
- 处理：host 的 `list` 返回项里，对自身包名打 `self: true` 标记；client 对其禁用
  switch（置灰 + 提示"管理插件自身不可禁用"）。更严格的做法是 `apply` 里对
  `name === 'dsh-hello-plugin'` 直接拒绝（`{ ok: false }`）。

**重点注意事项**
- 用**包名**识别自身（`dsh-hello-plugin`），别用 entry id 硬编码，避免重命名漏判。
- 若未来把"管理器 UI"与"被管理服务"拆成两个包，此豁免可放宽为"仅保护提供
  `installedPlugins` 服务的那个 entry"。

### 3.8 构建与验证

**技术细节**
- `npm run build` 会用 esbuild 把 `src/host/installed-plugins.js`（含 `@Remote`
  装饰器 + 新增的 `@Remote('apply')`）编到 `lib/installed-plugins.js`，把
  `src/client/index.jsx` 编到 `lib/client.js`（`scripts/build.mjs`）。新增的
  `src/host/plugin-patches.js` 会被 build 内联进 host 产物（它 import `js-yaml`，
  需保持 `js-yaml` 在 `external` 之外或作为运行时依赖正常解析）。
- `verify-client.mjs` 需补断言：
  - `$mount` 的 descriptors 含 `apply`（`namespace === 'installedPlugins'` &&
    `method === 'apply'`），且 `parameters[0].codec.mode === 'strict'`、
    `result.mode === 'strict'`；
  - 注入的 `listInstalled` 返回结构含 `enabled`/`fiberPhase`；
  - 新增注入的 `applyChanges` 会调用 `installedPlugins.apply`。
- `smoke.mjs` 可加一条：写入一个假的禁用覆盖后，断言 `/hello-plugin` 路由的
  `register` 记录被移除（stub `webServer` 已有 routes 记录能力）。

**重点注意事项**
- host 产物对 `@deepseek-ai/dsh-typert-protocol` 保持 external（同实例契约），
  `js-yaml` 则内联或作为依赖均可，但**不要**把 protocol 内联。
- 每次改完 `src/**` 都要 `npm run build` 再跑 `verify-client`；构建产物在
  `.gitignore` 里，勿提交 `lib/*`。

---

## 4. 数据契约汇总（wire）

| 方法 | 入参 | 出参 |
|---|---|---|
| `list` | — | `{ entries: [{ name, enabled, fiberPhase, self? }] }` |
| `apply` | `{ changes: [{ name, enabled }] }` | `{ needsReload, names: string[] }` |

- `fiberPhase`: `'pending'|'loading'|'active'|'failed'|'unloading'|null`
- 所有结果走 `RemoteResult<T>`：`{ ok:true, value } | { ok:false, error }`
  （`DH/packages/typert/protocol/src/types.ts:60-62`）。

---

## 5. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| YAML 往返丢失用户 `!!js`/注释 | 用户手写 patch 被破坏 | 3.3 用带 JsExpr 的 schema 往返；只增量改受管行 |
| 非原子写盘被 HMR 读到半截 | 配置损坏、热重载异常 | 临时文件 + `rename` + 重试 |
| 包名→entry id 映射失败 | 禁用无效且只告警 | 用 `entry.options.id`（非 getter）；写盘后回读校验 |
| 自引用关闭自身 | UI/服务消失 | 3.7 豁免自身包 |
| client 半体禁用后 UI 残留 | 按钮仍在但 RPC 失败 | 3.6 触发第二弹窗 + 刷新 |
| 无鉴权写端点被滥用 | host 状态被任意改写 | MVP 接受；后续接入权限/白名单 |

---

## 6. 实施顺序与验收

1. `package.json` 加 `js-yaml` 依赖 → `pnpm install`。
2. 新增 `src/host/plugin-patches.js`（合并读写 + JsExpr schema）。
3. 扩展 `src/host/installed-plugins.js`：`list` 状态 + `apply`。
4. 扩展 `src/client/index.jsx`：codec + UI + 统一提交 + 第二弹窗。
5. `npm run build` → `node scripts/verify-client.mjs` 通过。
6. 实测：`dsh plugin --profile web add <本包>` → 重启 web → 弹窗开关插件：
   - 纯 host 插件：关闭即生效（列表状态即时变化）；
   - 含 client 插件：关闭后弹第二弹窗，刷新页面后 UI 消失。
