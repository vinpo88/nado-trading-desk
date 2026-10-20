# Nado Trading Desk：本地钱包管理与官网连接

基于 [juu17/nado-trading-desk](https://github.com/juu17/nado-trading-desk) 的本地版本。使用 Next.js 界面管理浏览器中的加密保险库，创建或导入 EVM 钱包，并按选定地址连接 Nado 官网。

**源码、保险库和操作进度是三份独立数据。`git clone`、`git pull` 或 `git push` 不会迁移浏览器中的钱包。** 换设备前请完成[加密备份与迁移验证](docs/MIGRATION.zh-CN.md)。

## 功能与范围

- 创建 HD 派生账户、导入私钥账户，浏览和导出公开地址。
- 下载保险库原生加密备份；恢复前验证全部地址、HD 派生结果及签名能力。
- 在 `/connect` 中通过 WalletConnect 连接当前选中的一个钱包；该入口固定为 Ink 主网 `57073`。
- 明确开启后，可自动确认一次与当前钱包及指定用户名严格匹配的用户名签名；其他签名和交易仍逐次确认。
- 使用公开地址清单和进度记录生成可恢复、可分片的处理计划；独立 Playwright 执行器按 **10000 → 9999 → … → 1** 的默认顺序连续执行官网流程。

生成地址、官网连接、用户名保存、充值和交易就绪是不同状态。独立执行器的普通步骤由本地 Node.js 程序控制，不调用 AI，也不需要 ChatGPT 浏览器扩展。操作者仍须恢复和解锁保险库、明确确认条款，并处理异常。旧 CUA 辅助模块仍保留，供人工检查或调试使用。

## 安装

需要 Git、Node.js **22.12 或更新版本**（建议受支持的 LTS 版本）。克隆包含本 README 的发布版本后，Windows 可双击根目录的 **`Setup-Nado.cmd`**。它使用 `package.json` 固定的 **pnpm 11.9.0** 安装锁定依赖并构建，无需预先全局安装 pnpm 或 Corepack。

```powershell
git clone https://github.com/vinpo88/nado-trading-desk.git
cd nado-trading-desk
.\Setup-Nado.cmd
```

安装器只在 `apps/console/.env.local` 不存在时复制 `apps/console/.env.example`，保留已有配置；发现本仓库服务正在运行时不执行安装或构建，请先完成当前工作并停止服务。安装入口支持 Windows x64/ARM64，并检查 Node.js、npm 和 Git。只做环境检查、不安装时运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-local.ps1 -CheckOnly
```

如需手动安装，可在仓库目录使用 Corepack：

```powershell
node --version
corepack enable
corepack pnpm --version
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

如果使用手动方式且 Node 安装不包含 Corepack，可自行安装 pnpm 11.9.0，并使用 `pnpm` 执行后续命令。不要用其他包管理器重新生成锁文件。上游原始源码不一定包含本版本的中文界面、启动器和迁移功能，安装时应选择包含这些文件的版本。

开发检查（已配置 pnpm 命令时）：

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm test:registration
pnpm test:registration:browser
pnpm --filter console test:bridge
```

`test:bridge` 仅运行签名策略及连接状态模拟测试，不启动浏览器或连接真实钱包。完整页面测试需另行安装 Playwright 浏览器，并使用独立测试服务和临时浏览器配置；不要用正式钱包页面做自动化测试。

`test:registration` 测试公开计划、状态机与进程控制；`test:registration:browser` 使用真实无头浏览器和完全拦截网络的模拟站点，不读取正式浏览器配置或使用真实钱包。Windows 默认使用已安装的 Edge，其他平台默认使用 Playwright Chromium；可通过 `NADO_FIXTURE_CHANNEL=chrome` 选择已安装的 Chrome。这些测试不等于真实 Nado 全量注册验收。

## 本地启动

Windows 完成构建后使用仓库根目录的启动器：

| 文件 | 用途 |
| --- | --- |
| `Start-Nado.cmd` / `Start-Nado-Offline.cmd` | 启动本地钱包管理，关闭交易台实时接口 |
| `Start-Nado-Online.cmd` | 启动联网接口，总览初始选择测试网 |
| `Stop-Nado.cmd` | 停止由启动器管理的本项目服务 |

默认服务地址是 `http://127.0.0.1:18270`，只监听本机回环地址：

- [账户、钱包创建与备份](http://127.0.0.1:18270/accounts)
- [钱包总览](http://127.0.0.1:18270/)
- [连接 Nado 官网](http://127.0.0.1:18270/connect)

也可以在终端运行：

```powershell
$env:NADO_LIVE = "0"
$env:NADO_DEV_SEED = "0"
pnpm --filter console start
```

开发模式使用 `pnpm --filter console dev`。正式处理钱包时使用生产构建；构建或切换服务模式前先停止当前工作。

保险库存储位置由**浏览器用户配置和页面源地址**共同决定。`127.0.0.1`、`localhost`、不同端口不是同一个存储位置。固定使用同一地址和正常浏览器配置，不把正式保险库只保存在无痕窗口。

“离线”启动器控制交易台实时接口；访问 `/connect` 并配对仍会连接 WalletConnect 中继和官网。创建钱包、备份和本地恢复验证不需要这些网络连接。更多安装细节见 [Windows 使用说明](INSTALL-WINDOWS.zh-CN.md)。

## 创建钱包与备份

1. 在 `/accounts` 创建保险库，设置自己的密码。
2. 创建“HD（派生钱包）”账户，填写账户名称和派生数量。可导入自己持有的助记词；留空会在浏览器中生成。
3. 确认钱包数量。“追加派生钱包”的数量指本次新增数量，继续使用原 HD 账户。
4. 打开 `/connect`，点击“导出编号与地址清单”，保存 `wallet-manifest.json`。将副本放到仓库中的 `private-data/wallets.json`，用于计划器和迁移核对。
5. 返回 `/accounts`，在“备份与恢复验证”输入保险库密码，点击“下载加密备份”。
6. 保存后重新选择刚下载的文件，再输入原密码，点击“验证备份文件”，确认地址、HD 派生和签名检查通过。

同一 HD 账户的多个地址由同一组助记词派生，各地址有独立派生私钥；它们不是互不关联的密钥备份。地址 TXT 无法恢复私钥。新增、删除或导入账户后应重新备份。

备份 JSON 包含原生加密记录以及公开的账户、地址清单；密码单独保管。完整的新设备恢复和验收步骤见 [迁移指南](docs/MIGRATION.zh-CN.md)。

## 连接官网

1. 打开 `/connect` 并解锁，选择钱包编号，核对完整地址。
2. 填写自己的 WalletConnect Project ID。可以在页面输入；也可以自行配置 `apps/console/.env.local` 中的 `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`，随后重新构建。示例和源码不应包含个人项目配置。
3. 在 Nado 官网退出上一个身份，通过 **Sign In → WalletConnect → Copy link** 获取当前连接码。
4. 粘贴到本地页，核对官方来源、完整地址和 Ink 主网，再同意连接。
5. 官网如显示使用条款或资格声明，由当前操作者核实并决定是否接受。旧日志、示例配置及其他人的确认均不构成本次授权。
6. 如需设置用户名，在两边填写相同名称；可明确开启“自动确认一次此用户名签名”。签署开始即消费授权，失败不自动重试。
7. 核对官网显示的地址、用户名和 Ink 状态，确认本地没有待处理请求，再记录完成。

WalletConnect 连接码含临时配对材料，不写入日志、Git 或交接文件。一次会话只绑定一个地址；离开页面、刷新或锁库后需要重新连接。LinkSigner 是持续委托，代币额度授权和链上交易也不是登录；它们不会被用户名授权自动批准。

## 连续执行：独立 Edge / Chrome 程序

先完成本地安装与保险库备份。Windows 推荐使用已安装的 Edge；单独换用 Chrome 时，须同时将 `browser` 改为 `chrome`、`profileName` 改为 `registration-chrome`，不能让两种浏览器复用配置目录。执行器只创建仓库内 `browser-profiles/registration/` 下的专用配置，不读取或复制日常浏览器的登录资料。

1. 启动本地 Nado 服务。复制 `registration.worker.example.json` 为 `registration.worker.local.json`，核对范围、方向和历史 `progressPaths`。默认从 **10000 倒序到 1**；钱包少于一万时必须相应调整。旧进度需明确加入配置，不能仅凭当前网页编号判断已完成。
2. 双击 **`Start-Registration.cmd`**。后台 Node 进程启动专用浏览器，等待你自行恢复加密备份、输入密码解锁并核对钱包。已在这个配置恢复过时只需解锁。不要将密码写进配置；Windows 入口在缺少配置时会复制示例，但不会替你选择历史进度。
3. 首次没有 `walletsPath` 文件时，程序在同一浏览器中点击 `/connect` 的“导出编号与地址清单”，验证公开 JSON 后创建 `private-data/wallets.json`，随后继续执行。已有文件不会被自动覆盖。旧版页面缺少该按钮时停在 `waiting_manifest_export`，应更新本地服务。
4. 若仅想先恢复和核对保险库，可用 **`Open-Registration.cmd`** 的准备模式；它不会注册或签名。准备完用 **`Stop-Registration.cmd`** 关闭，再启动正式执行器并自行解锁。
5. 首次遇到条款时，程序等待本次运行的明确确认。检查官网弹窗及链接，用下面的 `status` 查看候选摘要；阅读候选文件并确认后，执行带实际摘要值的 `accept-terms` 命令。文档和示例不预先批准条款。

```powershell
node scripts/registration/worker.mjs status --config registration.worker.local.json
node scripts/registration/worker.mjs accept-terms --config registration.worker.local.json --digest <本次候选的SHA256>
```

确认后，同一进程按该候选核对后续弹窗的六项声明与链接；变化则停止。这个比对不等于监测链接所指法律文档的全文版本，操作者应在确认时阅读链接内容。每次重新启动是新的运行，需重新解锁和确认本次候选。

执行器等待页面状态和按钮就绪，不设每个钱包固定长时间休眠；网站响应、连接中继、姓名可用性检查和签名仍需要时间。用户名冲突仅在官网明确提示占用时处理：在 `ybtl` 字母之间插入随机数字，保留钱包编号，并同步本地一次授权的完整用户名。

| 操作 | Windows 入口 | 命令 |
| --- | --- | --- |
| 仅准备专用浏览器 | `Open-Registration.cmd` | `worker.mjs open --config registration.worker.local.json` |
| 后台连续执行 | `Start-Registration.cmd` | `worker.mjs start --config registration.worker.local.json` |
| 查看进度 | `Registration-Status.cmd` | `worker.mjs status --config registration.worker.local.json` |
| 当前项完成后停止 | `Stop-Registration.cmd` | `worker.mjs stop --config registration.worker.local.json` |
| 前台排查 | 终端运行 | `worker.mjs run --config registration.worker.local.json` |

表中命令需加上 `node scripts/registration/` 前缀。`status` 只读取公开状态，不接管浏览器。每小时的监控只需调用它，不能再同时启动旧 CUA 登录循环。

只有官网地址、准确用户名、Ink 主网和本地结果全部核验，且成功进度写入后，才处理下一个钱包。保存用户名之前先持久记录操作意图；保存后的结果不明确时停止核对，不盲目再次提交。停止命令等待当前钱包结束；等待解锁或条款确认时可直接结束。异常或退出会关闭专用浏览器，清除尚未使用的页面授权。不要强行结束进程后把未核实项记为成功。

本机同一用户只允许一个独立执行器或一个并发组，包括准备模式。需要 Edge 与 Chrome 同时执行时，使用下面的并发组入口；不要分别双击两个单浏览器启动入口。当前版本不宣称一万钱包的官网长时间运行已经完成实测。

官网初始页面、连接码、连接请求返回、连接批准或连接后的注册页面加载缓慢时，状态显示 `waiting_connection`。程序保留当前浏览器与钱包，每轮短暂检查后让出调度器，约每 5 秒继续观察；不会重复点击登录、WalletConnect、接收请求或连接批准。它只适用于尚未授权用户名、没有 Save 意图的阶段。本地 SDK 初始化尚显示“尚未连接”时，还须核对接收按钮的忙碌状态，才能继续等候。页面一直不就绪、出现验证码或限制提示时应检查当前窗口；程序不会自行刷新来绕过限制。停止命令在等待期间也有效。用户名保存结果不明确仍会停止，并保留 `attempt.json` 待核对。

若连接后只出现默认的 `Account 1`、一直没有条款或用户名表单，达到配置的 `timeoutMs` 后转为待检查，不能算作命名成功。可安全撤销本地签名授权并断开连接的 UI 故障会显示 `waiting_attention`：保留专用浏览器和保险库解锁状态，停止该成员的点击与焦点切换，另一成员可以继续。此状态不会自行重试或跳过当前钱包；需要先检查页面再决定恢复办法。现版本没有热恢复按钮，停止命令仍可关闭执行组。无法确认已撤权、页面关闭或存储异常时仍会结束执行。保存结果不明时保留原 `attempt.json`，不得删除它来重试 Save。

浏览器重启后，官网可能保留旧条款弹窗，而本地连接已经断开。仅在本地未授权、没有保存意图的情况下，程序关闭这个弹窗，确认官网退出后重新连接待处理的钱包。连接后的页面若短暂显示上一个钱包，会继续等待正确地址，不把旧账户计为当前钱包成功。
官网显示默认名称 `Account 1` 时，不能当成已完成命名。重启恢复时会先退出这个旧会话，再为待处理钱包重新连接和核验。

异常状态中的 `uiState` 仅包含页面阶段、连接状态分类以及钱包、用户名是否匹配等布尔值；不记录原始异常、页面全文、连接码或签名请求。`localStatus: error` 表示本地连接实际报错，不能当成普通延迟继续重试。

断电或强制结束后若提示 `WORKER_LOCK_STALE`，先确认旧执行器及其专用浏览器均已关闭，再运行 `node scripts/registration/worker.mjs recover-locks --config registration.worker.local.json --confirm-closed`。命令只处理对应的过期运行锁，拒绝移除仍有存活进程的锁，也不会杀死浏览器；不要删除 `attempt.json` 来绕过保存结果核对。

### Edge 和 Chrome 同时执行

并发组在同一个 Node 进程中管理两个独立浏览器。各自保管保险库、登录会话、进度和保存意图；共用调度器协调窗口焦点。连接码的复制、读取、填入及清空是一段不可交叉的操作，网络和页面处理可分别推进。不要在运行期间手动输入或复制其他内容；并发不保证速度翻倍。

1. 先停止旧执行器，等待当前钱包完成、记录落盘并关闭专用窗口。保留历史记录和所有 `attempt.json`。
2. 新安装可复制 `registration.worker.edge.example.json` 为 `registration.worker.local.json`，复制 `registration.worker.chrome.example.json` 为 `registration.worker.chrome.local.json`。**已有配置请就地修改，保留历史路径，不能覆盖。** 两个例子分别为 **Edge 1–2499 升序**、**Chrome 2500–10000 升序**；实际范围和方向由操作者明确设置，程序拒绝重叠范围。
3. 复制 `registration.group.example.json` 为 `registration.group.local.json`。确认同一份 `private-data/wallets.json` 已从本地页面导出，两个配置使用不同的 `profileName` 和 `progressPath`。组启动前合并校验所有成员声明的公开历史，已核验的钱包不会重复处理。
4. 双击 `Start-Registration-Parallel.cmd`。在两个专用浏览器各自恢复加密备份并自行解锁。程序等待两个浏览器都解锁后开始，等待时不会反复抢夺输入焦点。Chrome 的钱包恢复属于独立配置，不会自动复制 Edge 的浏览器数据。
5. 逐个核对本次条款候选，使用上一节 `worker.mjs accept-terms` 命令，分别指定 Edge / Chrome 的配置及各自候选摘要。确认文件不能从旧进程或其他操作者复制使用。

`Registration-Parallel-Status.cmd` 查看两边进度；`Stop-Registration-Parallel.cmd` 让两边各自完成当前钱包并保存后停止。跨平台对应：

```sh
node scripts/registration/group.mjs start --config registration.group.local.json
node scripts/registration/group.mjs status --config registration.group.local.json
node scripts/registration/group.mjs stop --config registration.group.local.json
```

组运行期间不可另起单浏览器执行器。调整范围前停止整个组，重新核对历史；未完成的保存意图必须仍属于对应浏览器的下一个待处理钱包。异常断电后的组锁使用 `group.mjs recover-locks --config registration.group.local.json --confirm-closed`，前提是确认该组所有专用浏览器已经关闭，所有相关进程已退出。

测试包含真实 Edge 与 Chrome 的隔离并发流程：所有网页请求由模拟站点响应，模拟共享剪贴板并核对每个连接码、地址及用户名。这验证了调度和隔离逻辑，不代表真实官网已完成全量注册。

## 倒序计划与断点续接

注册辅助文件位于 `scripts/registration/`。从 `registration.config.example.json` 复制成本地配置，根据实际钱包范围设置参数；默认值如下：

```json
{
  "bounds": { "min": 1, "max": 10000 },
  "start": 10000,
  "end": 1,
  "direction": "desc",
  "laneCount": 1,
  "laneIndex": 0
}
```

`laneIndex` 从 **0** 开始。钱包编号是 `/connect` 中从 1 开始的全局顺序，不是 HD 派生索引。在该页面点击“导出编号与地址清单”，将下载的 `wallet-manifest.json` 复制为 `private-data/wallets.json`。文件自动包含全部钱包的 `walletNumber` 和 `address`，无需手写 JSON 或转换地址 TXT。保留导出的编号和顺序，并与恢复后页面核对；不要把备份文件或私钥传给计划器。

配置示例使用 `.local/` 保存本地清单和进度，`usernamePrefix` 默认为 `ybtl`，例如第 10000 个钱包的默认用户名是 `ybtl10000`。可以修改前缀或显式提供用户名规则；官网名称必须与本地一次授权的完整名称一致。计划器 CLI 会将配置中的路径相对于配置文件所在目录解析，命令行路径参数相对于当前工作目录。

以下示例改用操作者自行准备的 `private-data/` 文件。首次运行应显式创建一个**新的空 NDJSON 文件**，或将本地配置中的 `progressPaths` 设为 `[]` 并省略 `--progress`。配置指向的文件不存在会停止，不能为了重新运行而清空已有进度。

```powershell
node scripts/registration/cli.mjs status --config registration.config.local.json --wallets private-data/wallets.json --progress private-data/progress.ndjson
node scripts/registration/cli.mjs plan --config registration.config.local.json --wallets private-data/wallets.json --progress private-data/progress.ndjson --output private-data/plan.json
```

命令行 `--progress` 覆盖配置中的 `progressPaths`；多个进度文件可重复传入 `--progress`。`plan` 和 `status` 输出 JSON，`merge` 输出 NDJSON。省略 `--output` 时输出到终端；指定时只允许创建新文件，拒绝覆盖已有文件。使用 `merge` 合并到新输出文件，保留原始记录便于核对：

```powershell
node scripts/registration/cli.mjs merge --config registration.config.local.json --wallets private-data/wallets.json --progress private-data/lane-0.ndjson --progress private-data/lane-1.ndjson --output private-data/merged.ndjson
```

计划器按固定的完整遍历序列分片，再跳过已完成项，不能先删去完成项再重新按位置分片。两条通道使用相同的范围、方向、清单和 `laneCount: 2`，分别设置 `laneIndex: 0`、`laneIndex: 1`；默认倒序分别从 `10000、9998…` 和 `9999、9997…` 开始。改变分片数量前应停止所有通道、合并进度并重新生成计划。

成功日志是历史完成证据，不代表换设备后浏览器仍然登录，也不证明充值或交易资格。冲突编号、重复地址或不一致的记录应先核对，不能通过覆盖旧记录假装完成。

`scripts/registration/cua-runner.mjs` 导出 `createPlannedNadoRunner`，在已初始化的 CUA 会话中使用。调用者提供配置 `config`、已读取的历史记录 `records`、本地页与官网页对象、公开地址清单及进度写入回调；也可提供 `fs` 与 `progressPath`。它按配置和历史记录建立固定队列，默认使用“`usernamePrefix` + 编号”，也允许显式提供 `usernameForWallet`。它不会自行读取保险库密码或创建浏览器配置。

这个函数接收解析后的对象，不知道配置文件的位置。直接调用时应传入已解析的**绝对 `progressPath`**，或用 `appendProgress` 回调固定写入目标；不能把 CLI 的相对路径规则套用到函数调用。

- `prepareNext()` 连接并核对当前分片的下一个未完成钱包，返回当前六项声明和链接，停在条款确认前；队列为空时返回 `null`。
- `finish(prepared, confirmation)` 仅处理本运行器当前准备的钱包，全部核验并写入进度成功后才推进队列；失败不会跳号。确认对象必须来自本次操作者明确决定，包含 `confirmed: true`、非空上下文、六项准确声明、官方条款及隐私链接；文档不提供预先批准的对象。
- `status()` 返回 `nextWalletNumber`、剩余和完成数量，以及外部浏览器首钱包验证状态。每个运行器串行处理，支持通过 `AbortSignal` 中止后续操作；中止不会撤销已经完成的官网操作。

需要明确指定单个编号时，可使用底层 `createNadoBatchRunner` 的 `prepare(walletNumber)`；它不负责按计划选取下一编号。CLI 的 `plan` 命令只输出计划，实际按计划执行使用上述 `createPlannedNadoRunner`。

运行器只在官网地址、用户名、Ink 网络和本地签署结果都核实后写成功记录。失败时保留已完成状态并人工核对；不要在不知道官网是否保存成功时重复提交。

## 旧 CUA 辅助方式与并行限制

以下仅适用于 `cua-runner.mjs`，独立执行器无需此扩展。**旧 CUA 官网辅助流程仅实测 Codex 内置浏览器（IAB）；外部 Edge/Chrome 的官网并行流程尚未验证。** 不把打开多个普通窗口当作多个独立身份，普通窗口可能共享官网登录状态。

如后续使用外部浏览器，需要为每条通道准备独立浏览器用户配置，并按[官方 ChatGPT 浏览器扩展说明](https://learn.chatgpt.com/docs/chrome-extension)连接：

1. 在应用“设置 → Computer Use”选择目标浏览器，点击 **Install** 安装官方扩展；安装后确认显示 **Manage**。
2. 在安装扩展的对应用户配置中使用 `@Edge` 或 `@Chrome` 连接。保持用户设置的网站权限，不自动扩大权限。
3. 每个独立浏览器配置分别恢复自己的保险库副本并自行解锁，核对钱包总数、编号和完整地址。
4. 每条通道使用独立计划分片和进度文件，处理不同编号；先完成单个钱包的完整验证，再评估是否适合扩展到多通道。

外部浏览器运行器设置 `browser: "chrome"` 或 `"edge"` 时，必须指定 `smokeTestWalletNumber`。使用计划运行器时，它必须等于当前分片的首个未完成编号。新运行器只能先处理该编号；官网与本地全部核验、进度写入成功后才允许处理其他编号。这个门槛是本机单钱包验证，不代表外部浏览器并行已经经过实测。

同机 Edge/Chrome 即使使用独立配置，也可能共享系统剪贴板。并行通道必须在**同一 CUA 会话中复用同一个运行器模块实例**，让模块共享锁协调连接码复制、读取、填入和清空。不同 CUA 会话或独立模块实例没有这把共享锁，禁止让这些执行器并发进行 **Copy link**；不要在配对期间手动复制其他内容。

源码中的 CUA 运行器通过已连接的浏览器对象调用受支持的工具 API，需要当前操作者明确提供条款确认上下文；示例不预置批准，也不授权未来操作者自动接受条款。遇到声明变化、验证码、权限拒绝、来源不匹配或未知签名时停止当前项，按实际页面处理。

## 发布与隐私

提交前检查暂存区和历史，确保没有以下内容：

- 助记词、私钥、保险库密码、加密保险库备份及恢复会话密钥。
- `.env` 类本地配置、个人 Project ID、WalletConnect URI、浏览器配置目录、Cookie、令牌或存储导出。
- 真实公开地址清单、用户名映射、注册进度、截图和运行日志。这些资料不含私钥也可能关联操作者身份，按需单独移交。
- `private-data/`、本地 `registration.config.local.json`、`.local/`、`test-results/`、构建产物和依赖目录。

忽略规则只影响未跟踪文件，不能清除已提交的内容。发布源码不需要上传保险库；Git 远端不是钱包备份介质。开发者可结合 `pnpm redaction:gate` 检查，但不能以自动扫描替代人工核对待发布内容。

## 归属与许可证

本项目保留上游 [juu17/nado-trading-desk](https://github.com/juu17/nado-trading-desk) 的归属；本版本增加了中文界面、本地启动、加密备份迁移及受控官网连接等功能。

许可证以当前发布版本实际附带的许可证文件及上游有效授权为准。若检出版本没有 `LICENSE`，不能仅凭本 README 宣称整仓库获得 MIT 授权；发布者应先核实授权并保留原版权声明。第三方依赖各自适用其许可证。
