# dsh-purge 维护手册（fork 自 linyeer/dsh-purge）

> 本仓库是 **YuJunZhiXue/dsh-purge** 的上游镜像 fork。原作者已停止维护并闭源，
> 这里改为本地长期维护：**装在本机、跟着 DSH 升级走、坏了能自己修**。
> 署名与非盈利要求沿用上游 `MIRROR-NOTICE.md` / `README.zh-CN.md`。

---

## 0. 一页速查

| 场景 | 命令 |
| --- | --- |
| 看插件装没装、补丁打没打 | `node scripts/maintain-status.mjs`（见 §3） |
| 打完补丁后应用 | 宿主里点 **dsh-purge → 清洗 → 应用**，或 `dsh-purge --apply` |
| 回滚宿主 | `dsh-purge --revert` |
| 卸载插件 | `dsh-purge --uninstall` |
| 拉上游新提交 | `git pull` 后重跑 §3 |
| DSH 升级了 | 走 §5「宿主升级后的维护流程」 |
| 某个补丁不生效 | 走 §6「补丁 pattern 修复」 |

---

## 1. 本机安装状态（2026-10-21 实测）

| 项 | 值 |
| --- | --- |
| DSH 桌面版 | `E:\ai agent\dsh\DeepSeek Harness.exe`（0.2.1-rc.2，Electron 44.7.0 / Node 24.21.0） |
| DSH_HOME | `C:\Users\venyea\.dsh` |
| profile | `desktop`（桌面 EXE 专用，CLI 不能 `--dump-config`，只能由 Electron 管理） |
| 插件源码（本仓库） | `E:\mygame\dsh-purge\upstream` |
| profile 里的依赖写法 | `"dsh-purge": "link:E:/mygame/dsh-purge/upstream"` |
| node_modules 实体 | junction → `E:\mygame\dsh-purge\upstream` |
| 宿主解包目录 | `E:\ai agent\dsh\resources\app`（插件改的是这里的 `@deepseek-ai`） |
| 插件状态目录 | `C:\Users\venyea\.dsh\dsh-purge\` |

`link:` 是刻意的选择：**改仓库文件立即生效，不需要重新 pnpm install**。
`file:` 会拷一份进 `.pnpm` 存储，改源码不跟随（实测确认）。

### 为什么不用 `dsh plugin add dsh-purge`

1. npm registry 上 `dsh-purge` 已 404（作者闭源，包已下架）。
2. `dsh plugin --profile desktop add <本地目录>` 能装，但会记成 `link:` 并警告 peerDependencies
   不从目标 node_modules 解析 —— 这条警告在本仓库无害：插件只用 `node:` 内置模块 + 宿主的
   `@deepseek-ai/*`，不 import 任何第三方包（`grep -rn 'from "@deepseek-ai' lib/` 为空）。
3. 本机 `github.com:443` 直连不通（`git config http.https://github.com.proxy` 指向未启动的
   `127.0.0.1:7897`）。拉代码只能走 `https://ghproxy.net/https://github.com/...`。
   **`api.github.com` 通，`codeload.github.com` 通**，`raw.githubusercontent.com` 不通。

---

## 2. 安装 / 重装（换机、换盘、profile 重建时用）

```powershell
# 1) 拉仓库（github.com 不通时用镜像前缀）
git clone https://ghproxy.net/https://github.com/linyeer/dsh-purge.git E:\mygame\dsh-purge\upstream

# 2) 装进 desktop profile（dsh 自己会跑 pnpm）
& 'E:\ai agent\dsh\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'E:\mygame\dsh-purge\upstream'
```

装完核对三件事：

```powershell
# package.json 里应出现 link: 依赖，且 bundles 末尾多了 dsh-purge
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw

# node_modules 应是 junction，指向仓库
(Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-purge" -Force) | Select LinkType,Target
```

然后**完全退出桌面端（托盘退出）再打开**，再点「应用」。

### 手工兜底（dsh CLI 不可用时）

改 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 两处，然后在该目录 `pnpm install`：

```json
{
  "dependencies": { "dsh-purge": "link:E:/mygame/dsh-purge/upstream" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-providers-hub", "dsh-context", "dsh-purge"] } }
}
```

本机 pnpm 不在 PATH，用 DSH 自带的：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'E:\ai agent\dsh\DeepSeek Harness.exe' --expose-internals `
  'E:\ai agent\dsh\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs' install
```

---

## 3. 日常自检：`scripts/maintain-status.mjs`

**只读**，不碰宿主文件。比 `dsh-purge --status` 多一层：它会告诉你**哪一条 pattern 对不上**。

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'E:\ai agent\dsh\DeepSeek Harness.exe' --expose-internals 'E:\mygame\dsh-purge\upstream\scripts\maintain-status.mjs'
```

输出分四段：宿主/app.asar 判定、pending 明细、pattern_not_found 明细、其它跳过项。

两个**必须用对**的细节（踩过）：

- 读宿主文件必须走 `hostFs`（original-fs）。用 `node:fs` 在 Electron 里会被 asar 影射劫持，
  读到 `size=0` / `ERR_INVALID_ARG_TYPE`，看起来像「文件读不了」。
- 比对前必须把正文压成 LF。宿主文件是 CRLF，直接 `includes` 会全判未命中。

---

## 4. 补丁体系速读（改之前先看这节）

一条补丁 = `lib/core.js` 里 `ALL_PATCHES` 的一项：

```js
{
  id: 60,                                  // 稳定编号，备份/状态/issue 都靠它
  name: "OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL",
  layer: "工具", layer_en: "Tools",         // 面板分组
  desc: "一句话说明",
  file: ["dsh-tools", "dsh-tools-ptc"],    // 见 core.js targetFiles() 的键
  optional: true,                          // pattern 没命中时是否挡「应用」
  strictFiles: false,                      // true = 文件在就必须命中，否则判失败
  skipIfMarked: true,                      // 已打上标记就不再重复 replaceAll
  replacements: [{ pattern, replace }],    // 字面量或 RegExp
  markers: ["..."],                        // 判定「已应用」的标记；markersAny 表示任一即可
  forbid: ["..."],                         // 命中即认为「被回退了」
}
```

合并顺序：`PATCHES`（提示词/代码）→ `CODE_PATCHES` → `ENGINE_PATCHES` → `NEW_TOOL_PATCHES`
（见 `core.js` 底部 `ALL_PATCHES`）。

状态词：`applied` / `already` / `pending` / `skipped` / `na` / `missing_file` / `pattern_not_found`。
**只有 required 且 `pattern_not_found` 会让「应用」判失败**（`core.js` `isPatchResultSoftOk`）。

本机当前（2026-10-21 12:51 实测）：82 条，applied/already 60，pending 9，required 未命中 0。

`pending` 分两种，性质完全不同（自检脚本会分开报）：

**(a) 5 条只是没应用** —— pattern 全部命中，点一次「应用」就打上：

| # | 名称 | 目标 |
| --- | --- | --- |
| 61 | OFFICIAL_SANDBOX_POLICY_NEUTRAL | `dsh-sandbox-policy/lib/index.js` |
| 63 | OFFICIAL_PLAN_MODE_NEUTRAL | `dsh-web-app/presets/*.patch.yml` |
| 78 | OVERLAY_RESTORE_FROM_BAK | `dsh-app-boot/lib/index.js` |
| 82 | DESKTOP_SHELL_PROFILE_FALLBACK | `resources/app/lib/main.js` |
| 85 | SESSION_PROMPT_ALWAYS_FOLLOWUP | `dsh-api-session-controller/lib/index.js` |

**(b) 4 条宿主改版了** —— 部分 pattern 对不上，要按 §6 对齐：

| # | 名称 | 目标文件 | 现状 |
| --- | --- | --- | --- |
| 60 | OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL | `dsh-tools/lib/types/ptc.js` 等 | 4/4 未命中，原句已改成对象字段形式 |
| 62 | OFFICIAL_TOOL_ASK_FAILOPEN | `dsh-tools/lib/index.js`、`lib/types/index.js` | 4/4 与 3/4 未命中，approval 分支重构 |
| 86 | SESSION_STEER_ALWAYS_FOLLOWUP | `dsh-api-session-controller`、`dsh-agent-loop` | 3 条中 2 条未命中，`steer(input)` 段已不在 |
| 87 | HUNG_PROMPT_LF_NEEDLE | `dsh-agent-loop/lib/index.js` | 8 条中 6 条未命中，`renderPrompt` 调用点重写 |

这 4 条都 `optional: true`，不影响「应用」成功，但它们对应的语义（run_code 审批放行、
无审批通道 fail-open、UI 队列 steer 走 follow-up、空白宿主全文挂载）在当前宿主上**没生效**。

---

## 5. 宿主（DSH）升级后的维护流程

DSH 升级 = `resources/app.asar` 被换成新版 → `resources/app` 那份解包副本变旧。

### 5.1 判定「宿主换过包」

```powershell
# 跑 §3 的脚本，看这一行
#   当前 size/mtime : ...
#   已解包记录      : ...
#   判定            : 一致 / 不一致
```

判定依据是 `$DSH_HOME/dsh-purge/unpacked-asar.json` 里记的 size/mtime 和当前 `app.asar` 是否一致
（`core.js` `shouldExtractAsar` / `readUnpackedAsarStamp`）。

### 5.2 走一遍标准流程

1. **先备份**：`$DSH_HOME/profiles/desktop`（package.json / pnpm-lock.yaml / pnpm-workspace.yaml /
   cordis.patch.yml）和 `resources/app` 各留一份。
2. 完全退出桌面端（托盘退出，确认任务管理器里没有 `DeepSeek Harness.exe`）。
3. 重开桌面端 → 点 **dsh-purge → 清洗 → 应用**。
   这一步会：把旧 `resources/app` 挪成 `app.dshpurge-prev*` → 重新从 `app.asar` 解包 →
   按当前 `ALL_PATCHES` 重打 → 自动重启一次。
4. 重开后再跑 §3，确认 pending 归零、required 未命中归零。

### 5.3 官方更新会把插件打回「密封」状态

桌面端自升级后，`app.asar` 重新出现（有时旁边多个 `app.asar.new`），此时插件补丁全部失效。
这是设计行为，不是坏了 —— 重新「应用」即可。相关代码：`lib/reapply.js`
（`patchesLostAfterHostReset` / `refreshStaleBaksForUpgrade`）、`lib/core.js`
（`openSealedDesktopHost` / `desktopAsarStillSealed`）。

> ⚠️ 已知坑：`app.asar.new` 存在但 `app.asar` 还是旧的时，「应用」的换包时序可能失败。
> 先手动确认 `resources` 下到底是哪一份在生效（比对 size/mtime），必要时删掉 `app.asar.new` 再试。

### 5.4 升级后要重点看的补丁

按 DSH 版本改动最频繁的位置：

| 补丁 | 打在哪 | 宿主一改就容易失配 |
| --- | --- | --- |
| #1/#2/#3 | `dsh-agent-instructions/lib/index.js` 的常量字面量 | 是 |
| #4/#25/#26/#43/#76 | persona / preset 身份段 | 是 |
| #60/#62 | `dsh-tools` 的 approval 分支 | 是（当前就 pending） |
| #78 | `dsh-app-boot` 的 `loadOverlayPatches` | 是 |
| #82 | `resources/app/lib/main.js` 顶部 | 是 |
| #85/#86 | `dsh-api-session-controller` 的 steer 分支 | 是 |
| #87 | `dsh-agent-loop` 的 `renderPrompt` 调用点 | 是（当前 pending） |

---

## 6. 补丁 pattern 修复（最常干的活）

### 6.1 定位

```powershell
# 1) 看是哪一条 pattern 没命中
#    跑 §3 脚本 → pending 段会列出「第 N 条未命中」和 pattern 首行

# 2) 到宿主里找当前原文（app.asar 仍在时要用 --no-progress + 真实路径；
#    PowerShell 的 Select-String 走 Win32 文件 API，读得到解包目录）
$f = 'E:\ai agent\dsh\resources\app\dsh\node_modules\@deepseek-ai\dsh-tools\lib\types\ptc.js'
Select-String -Path $f -Pattern 'Wider sandbox mode' -Context 2,6

# 3) 想看制表符/CRLF 真身
[System.IO.File]::ReadAllText($f).Substring($idx, 400) -replace "`t", '<TAB>' -replace "`r`n", '<CRLF>`n'
```

### 6.2 改

```js
// lib/core.js
{
  id: 60, ...
  replacements: [
    {
      pattern: "改前的原句（从宿主里原样复制，注意制表符和换行）",
      replace: "改后的句子 // [dsh-purge] 简短说明",
    },
  ],
  markers: ["[dsh-purge] 简短说明"],   // 判定已应用靠这个
}
```

改 pattern 的硬规矩：

- **缩进用真制表符**。宿主打包产物是 tab 缩进，复制时别被编辑器换成空格。
- 多行 pattern 用 `"\n" + "..."` 拼接，别写成模板字符串 —— 换行风格会不一致。
- 只改**最小片段**。跨函数的大块 pattern 一升级就整条失配。
- `markers` 必须和 `replace` 里的标记一致，否则会重复打（`skipIfMarked` 失效）。
- `forbid` 是反悔标记：如果 replace 里也含 forbid 的字样，这条永远判未应用。

### 6.3 验证

```powershell
# 重跑自检：该条应从 pending 变成 applied（或 missing_file/skipped，说明打错文件了）
# 再实际应用一次：
& 'E:\ai agent\dsh\DeepSeek Harness.exe' --expose-internals 'E:\mygame\dsh-purge\upstream\bin\dsh-purge.js' --apply
```

### 6.4 真要停用某条补丁

别删定义（id 是稳定标识，删了会让备份/状态错位）。改成：

```js
{ id: 60, ..., optional: true, disabled: true }   // 或直接把它从 ALL_PATCHES 的拼接里摘掉
```

---

## 7. 已做的本地修改（相对上游）

放在 `patches/0001-dsh-0.2.1-adaptations.patch`，共 3 个文件、两件事：

### 7.1 去掉 `{{cwd}}`（宿主 0.2.1 不再注册这个变量）

| 文件 | 改动 |
| --- | --- |
| `cordis.patch.yml` | `personaSuffix: ""`（原来写 `Your working directory is {{cwd}}.`） |
| `lib/identity.js` | `CWD_ONLY_SUFFIX = ""`、从 `DSH_INTERPOLATE_ALLOWED` 去掉 `cwd`、strip 正则补 `{{cwd}}` 分支 |

**根因**：DSH 0.2.1 的 `dsh-agent-loop` 只注册了 `provider` / `model` 两个提示词变量
（`ctx.systemPrompt.variable(...)` 只有这两处），`{{cwd}}` 已不存在。
`dsh-system-prompt` 的 `interpolate()` 遇到未注册变量会直接抛
`unknown prompt variable "{{cwd}}"`，**整轮请求失败**。
工作目录现在由 `dsh-tool-working-directory` 以普通上下文提供。

**副作用**：模型不再从系统提示词里直接读到 cwd，需要时会调 `working_directory` 工具。

### 7.2 给 #40 补 0.2.1 的 pattern（否则「应用」永远失败）

| 文件 | 改动 |
| --- | --- |
| `lib/core.js` | 新增常量 `COMPLETE_PROMPT_WATERFALL_INJECT_021`；`id: 40` 的 `replacements` 追加第 7 条 |

**根因**：0.2.1 的 `SystemPrompt.assemble()` 在 waterfall 之后多算了一份
`requiredContexts`，`sections` 也改成 `transformed.sections`。#40 原有的 6 条 pattern
全部落空 → 状态 `skipped` → `complete prompt keeps inject` 标记写不进去 →
`hostPromptKeepsInject` 恒 false → 点「应用」报「清洗没有写进全部宿主」。详见 §8.1。

**注意**：替换文本必须原样保留 `requiredContexts` 的收窄语义
（`runtimeContextSuppressed ? 只留 required : 全留`），否则会改掉 runtime context 的抑制行为。

### 7.3 重新生成 / 重放

```powershell
cd E:\mygame\dsh-purge\upstream

# PowerShell 下必须用 --output，'>' 会写成 UTF-16LE，git 认不出来
git diff --output=patches/0001-dsh-0.2.1-adaptations.patch -- `
  cordis.patch.yml lib/identity.js lib/core.js

# 校验：patch 与当前工作区改动完全一致（reverse 能干净应用）
git apply --check --reverse patches/0001-dsh-0.2.1-adaptations.patch
```

`git pull` 后重放：

```powershell
git apply patches/0001-dsh-0.2.1-adaptations.patch
# 冲突就按 §7.1 / §7.2 手工重做，再重新生成 patch
```

---

## 8. 已知问题与坑（都实测过）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `git clone https://github.com/...` 超时 | 本机 `github.com:443` 不通 | 用 `https://ghproxy.net/https://github.com/...`；`codeload.github.com` 和 `api.github.com` 本身是通的 |
| `dsh.cmd` 报 `'""' is not recognized` | 它依赖 `%DSH_DESKTOP_NODE_EXECUTABLE%`，直接调会缺变量 | 用 `$env:ELECTRON_RUN_AS_NODE='1'` + `"DeepSeek Harness.exe" --expose-internals <js>` |
| pnpm 找不到 | 不在 PATH | 用 `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`，配 `ELECTRON_RUN_AS_NODE=1` |
| `dsh plugin --profile desktop ...` 报 `profile "desktop" is managed exclusively by the Electron application` | 只有部分子命令（如 `--dump-config`）禁 CLI | `add` / `why` 可以跑；`--dump-config` 必须走宿主 UI |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | profile 里 `dsh-providers-hub` 是 git 依赖，构建脚本未放行 | 在 profile 的 `pnpm-workspace.yaml` `allowBuilds` 里加对应 key（历史日志里出现过） |
| 插件 `--status` 里 shim 显示 `dsh.cmd=binary` | 密封 desktop bin 不注入（`isDesktopCommandRuntimeDir`），设计如此 | 忽略 |
| 应用时 `ENOENT ... rename 'dsh.cmd.dsh-purge.bak.<pid>.<ts>.copytmp'` | 宿主 host 子进程在 shim 备份 rename 时退出（2026-10-21 12:17 的 crash log） | 备份已成功落盘；重开宿主再点「应用」即可，别在应用过程中关窗口 |
| `dsh-purge --status` 里 required 显示 pending 但「应用」不报错 | 那些是 `optional: true` | 只有 required 的 `pattern_not_found` 才挡应用 |
| 点「应用」报 **失败：清洗没有写进全部宿主，已取消重启**，但自检显示 pending 0 / pattern_not_found 0 | 见 §8.1 | 见 §8.1 |

---

### 8.1 「清洗没有写进全部宿主」——最容易误判的一条

**症状**：点「应用」，红字 `失败：清洗没有写进全部宿主，已取消重启`。
但自检脚本显示 `pending 0，pattern_not_found 0`，面板上大部分补丁也是 ✓。

**判定链**（`lib/core.js`）：

```
ensureHostClean()
  └─ allPatchHostsWritten(hosts)          // 每个宿主的 hostWritten 必须 true
       └─ hostCleanMarkersPresent(aiBase)
            └─ hostPromptKeepsInject(dsh-system-prompt/lib/index.js)
                 ├─ 有 "[dsh-purge] identity stripped"                ← #25
                 └─ 有 "[dsh-purge] complete prompt keeps inject..."  ← #40
```

**关键**：这两个标记是**硬性**的，跟补丁状态是两套判定。#40 在 0.2.1 上
pattern 全部落空 → 状态变 `skipped`（不是 `pending`，所以不报 apply 失败）
→ 但 `complete prompt keeps inject` 标记写不进去 → 闸门永远 false。

**自查一行**：

```powershell
$f = 'E:\ai agent\dsh\resources\app\dsh\node_modules\@deepseek-ai\dsh-system-prompt\lib\index.js'
$t = [System.IO.File]::ReadAllText($f)
"identity : " + $t.Contains('[dsh-purge] identity stripped')
"inject   : " + ($t.Contains('[dsh-purge] complete prompt keeps waterfall inject') -or $t.Contains('[dsh-purge] complete prompt keeps inject'))
```

两个都要 `True`。哪个 `False` 就是对应补丁没打上。

**修复**（0.2.1 实测有效）：#40 的 6 条 pattern 都不认新版 `assemble()`，
因为 0.2.1 多了 `requiredContexts` 一行、`sections` 也换了写法。在 `lib/core.js`
的 `id: 40` 里补第 7 条 pattern（对应常量 `COMPLETE_PROMPT_WATERFALL_INJECT_021`），
原样保留 `requiredContexts` 的收窄语义 —— 只把 dsh-purge 段插到完整段前面。

> 更一般的教训：**补丁状态是 skipped 不等于没影响**。凡是参与
> `hostPromptKeepsInject` 判定的补丁（#25 / #40），落空会直接卡死「应用」。

---

### 8.2 「应用」后弹 `dsh desktop host stopped`，asar 没被挪走

**症状**：点「应用」后弹崩溃框（`dsh desktop host stopped`，附 crash-*.log），
但重启后宿主命令行仍然指向 `app.asar`，补丁等于没生效。

**判定**：

```powershell
# 宿主实际从哪儿加载？（看 dsh-desktop-host 那条）
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -like '*dsh-desktop-host*' } |
  Select-Object -ExpandProperty CommandLine

# 两份文件各自的补丁状态
$d = 'E:\ai agent\dsh\resources\app\dsh\node_modules\@deepseek-ai\dsh-system-prompt\lib\index.js'
$t = [System.IO.File]::ReadAllText($d)
"disk  : " + $t.Contains('[dsh-purge] complete prompt keeps inject')
"asar  : " + ([bool](Select-String -Path 'E:\ai agent\dsh\resources\app.asar' -Pattern 'dsh-purge' -Quiet))
```

命令行里出现 `app.asar\dsh\node_modules\...` = **还在跑密封包**，`resources\app` 的补丁全部无效。

**根因**：`lib/desktop.js` 的 `scheduleAsarSwapRestart` 在 Windows 上生成一个 PowerShell
脚本（`%TEMP%\dsh-purge-asar-swap-<pid>.ps1`），先杀 Electron 再把 `app.asar` 改名，
再重启 exe。实测这台机器上脚本起来了、进程也杀了、应用也重启了，**但 `Move-Item` 没成功**：

- 既没有 `app.asar.bak`，也没有 `app.asar.rename-pending` → 说明在改名那步之前就退出了；
- 脚本本身语法解析 0 错误、无 BOM、执行策略 `Bypass` 也对得上。

结果是 Electron main 看到 host 子进程退出，弹「host stopped」，而 asar 原封不动。

**手动补这一步**（`tools/asarsync.ps1`，仓库内已带）：

```powershell
# 1) 先干跑，确认路径和进程数
powershell -NoProfile -ExecutionPolicy Bypass -File E:\mygame\dsh-purge\tools\asarsync.ps1 -DryRun

# 2) 用计划任务拉起守护（必须这样，见下）
powershell -NoProfile -ExecutionPolicy Bypass -File E:\mygame\dsh-purge\tools\launch-guard.ps1

# 3) 托盘退出应用，等它自动回来
# 4) 看日志
Get-Content (Join-Path $env:TEMP 'dsh-purge-asarsync.log') -Tail 20
```

#### 为什么必须用计划任务启动（三个坑都踩过）

| 启动方式 | 结果 |
| --- | --- |
| `Start-Process`（从助手会话里） | **继承 DSH 的 Job Object**，应用一退，守护被一起杀 |
| `Invoke-CimMethod Win32_Process Create` | 进程能活（父进程是 `WmiPrvSE.exe`），但**写文件被拦**，日志一条都没有 |
| `schtasks /Create` + `/Run` | ✅ 父进程 `svchost.exe`（Task Scheduler），脱离 Job、不受进程沙箱约束 |

验证守护是否真的脱离了：

```powershell
$p = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*asarsync*' }
$cur = $p
0..3 | ForEach-Object {
  if ($cur) { "$($cur.Name) pid=$($cur.ProcessId)"; $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue }
}
# 期望：powershell → svchost → services → wininit
# 出现 DeepSeek Harness.exe 就说明没脱离，应用一退它也会死
```

清理计划任务（切换完成后）：

```powershell
schtasks /Delete /TN dsh-purge-asarsync /F
```

守护脚本的退出码：`0` 成功（含「已经切换过」）、`2` resources/app 不完整、
`3` 等待超时应用没退出、`4` asar 挪不动（仍被占用）。

默认等 **2 小时**（`-WaitSeconds 7200`），每 60 秒往日志写一行心跳：

```
waiting... procs=8 elapsed=60s
waiting... procs=8 elapsed=120s
```

看到心跳就说明守护还活着。等得不耐烦可以用 `-WaitSeconds 300` 缩短。

**判断「应用真的退出了」**：守护只认 `DeepSeek Harness.exe` 的**主进程树全部消失**。
如果托盘退了但进程还在（后台残留），守护会一直等 —— 这时看日志里的 `procs=N`
是否归零，或直接在任务管理器结束所有 `DeepSeek Harness`。

**成功标志**：`resources` 下出现 `app.asar.bak`、`app.asar` 消失，宿主命令行变成
`resources\app\dsh\node_modules\...`。

**为什么脚本要带 BOM**：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按 GBK 解码，
中文字符串把引号吃乱 → `The string is missing the terminator` 语法错。
写 `.ps1` 一律存成 UTF-8 with BOM。

---

> 更一般的教训：**补丁状态是 skipped 不等于没影响**。凡是参与
> `hostPromptKeepsInject` 判定的补丁（#25 / #40），落空会直接卡死「应用」。

---

## 9. 跟上游同步

```bash
cd E:/mygame/dsh-purge/upstream
git remote -v          # origin = https://ghproxy.net/https://github.com/linyeer/dsh-purge.git
git fetch origin && git log --oneline HEAD..origin/master
git pull --rebase
```

拉完必做：

1. 重跑 `scripts/maintain-status.mjs`，看有没有新 `pattern_not_found`。
2. `git apply --check patches/0001-*.patch` 确认本地 patch 还能打上；冲突就按 §7 重新生成。
3. 桌面端完全退出再开，点「应用」。

> 上游作者已停止更新，`git pull` 大概率没有新提交。真正的维护对象是**宿主 DSH 的升级**，
> 也就是 §5 那条线。

---

## 10. 回滚 / 卸载

```powershell
# 只回滚宿主补丁，保留插件
& 'E:\ai agent\dsh\DeepSeek Harness.exe' --expose-internals 'E:\mygame\dsh-purge\upstream\bin\dsh-purge.js' --revert

# 完整卸载（先还原宿主，再删插件与注入文件）
& 'E:\ai agent\dsh\DeepSeek Harness.exe' --expose-internals 'E:\mygame\dsh-purge\upstream\bin\dsh-purge.js' --uninstall
```

`prompt-inject.md` 是用户文件，`--revert` 会保留；`--uninstall` 才删。

回滚后如果要彻底恢复官方宿主：删掉 `resources/app`，把 `app.asar.bak`（若有）改回 `app.asar`，
再启动桌面端。

---

## 11. 目录速查

```
E:\mygame\dsh-purge\upstream\
├─ lib\core.js              # ALL_PATCHES + 应用/回滚/状态（主战场）
├─ lib\index.js             # 插件入口：注入、提示词段、工具
├─ lib\identity.js          # 身份段 / {{...}} 转义（本地改过）
├─ lib\reapply.js           # 版本戳、启动时重打、防重启风暴
├─ lib\update.js            # 自更新（指向原作者仓库，本 fork 下别用）
├─ lib\extract-asar.js      # asar 解包 + hostFs（读宿主必须走它）
├─ lib\uninstall.js         # 卸载
├─ cordis.patch.yml         # profile bundle 补丁（本地改过）
├─ scripts\maintain-status.mjs   # 本手册 §3 的自检脚本（新增）
└─ patches\0001-*.patch          # 本地修改留档（新增）
```

宿主侧：

```
E:\ai agent\dsh\resources\
├─ app.asar                 # 官方密封包（升级会被换掉）
├─ app.asar.new             # 升级残留，注意别让它抢生效
├─ app\                     # 解包副本，插件实际改这里
│  └─ dsh\node_modules\@deepseek-ai\...
└─ runtime\cli\bin\dsh.cmd  # CLI 启动器
```

---

## 12. 改动纪律

- **只改 `upstream/` 下的源码**，别手改 `resources/app` —— 下次「应用」会覆盖。
- 每次改 `lib/core.js` 的 pattern，都在 commit message 里写清「对哪一版宿主、哪个文件、哪一句」。
- 新补丁一律 `optional: true`，等确认在目标宿主上稳定了再考虑 `strictFiles`。
- 本地相对上游的改动单独成 patch 文件，方便 `git pull` 后重放。
