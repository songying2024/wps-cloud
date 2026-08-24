# @dsh-local/wps-cloud — WPS 云文档 DSH 插件（普通用户版）

连接 **WPS 云文档** 的 DeepSeek Harness（DSH）主机插件。**面向普通 WPS 用户设计**：不需要注册开发者账号、不需要 APPID/APPKEY、不需要 OAuth 回调地址——只需用你自己的 WPS 账号登录一次。

安装后，Agent 获得一组 `wps_*` 工具，可以直接浏览、搜索、读取、下载、上传、创建、重命名和移动你在 WPS / 金山文档个人云空间里的文档。

## 一键登录（普通用户核心流程）

1. 让 Agent 做任何 WPS 云文档操作（如“列出我的 WPS 云文档”），或点击设置页「登录 WPS 云文档」。
2. 插件**自动弹出系统浏览器的登录窗口**，打开 WPS 网页版（`https://365.kdocs.cn/`）。
3. 在窗口中用你的 **WPS 账号**登录（未登录时自动跳转到 WPS 官方统一登录页 `account.wps.cn`，账号密码 / 扫码均可）。
4. 插件自动抓取登录会话（`wps_sid`）并保存到本机——**全程无需复制任何内容**。
5. 回到 DSH 告诉 Agent“继续”，云文档工具即可使用。

> 为什么可以不用开发者账号？金山文档开放平台的官方 OpenAPI 需要企业资质（营业执照）才能申请应用凭证，普通用户走不通。本插件改用金山自家访问云文档的方式：登录 WPS 网页版后，用网页会话（`wps_sid`）调用金山官方 kdocs-cli 访问你的云空间。这也是 WPS 灵犀访问云文档所采用的方式。

## 功能

| 工具 / 界面 | 说明 |
| --- | --- |
| `wps_auth_status` | 检查登录状态；未登录时自动弹出登录窗口 |
| `wps_authorize` | 手动发起登录（自动弹窗；也可用 `sid` 参数手动回传会话） |
| `wps_logout` | 清除本地会话 |
| 设置页「WPS 云文档」 | 状态卡片 + 登录 / 退出 / 刷新按钮 |
| 输入框附件图标（+ 号左侧） | 弹出面板浏览 / 搜索 WPS 云文档（配色随 DSH 浅/深主题），点击云端文件或上传本地文档即作为「附件」暂存到本机 `~/.dsh/wps-uploads/` 并生成附件指令，Agent 读取本地副本讨论（不上传云端） |
| `wps_list_files` | 按目录列出文件/文件夹（分页、排序、类型过滤） |
| `wps_list_all_files` | 递归扁平列出全部文件 |
| `wps_recent_files` | 最近访问的文档 |
| `wps_search_files` | 按文件名搜索 |
| `wps_get_file_info` | 单个文件/文件夹详情 |
| `wps_read_document` | 读取文档正文（docx/doc/xlsx/xls/pptx/ppt/pdf/otl 等，转 Markdown） |
| `wps_download_file` | 下载到本地磁盘 |
| `wps_upload_file` | 上传本地文件到云空间 |
| `wps_create_document` | 创建空白文档（.docx/.xlsx/.pptx/.otl/.ksheet/.dbt 等） |
| `wps_create_folder` | 创建文件夹 |
| `wps_rename_file` | 重命名 |
| `wps_move_file` | 移动文件/文件夹到指定目录 |
| `wps_delete_file` | 暂不支持（kdocs-cli 未暴露删除接口，请到网页端操作） |

## 安装（本地离线方式，无需 npm 仓库）

本插件为零 JS 外部依赖（仅使用 Node 内置模块 + DSH 自带包），kdocs-cli 引擎会在首次使用时自动下载到 `$DSH_HOME/wps-cloud/`。

1. 把插件目录复制到 DSH 主目录的本地插件空间：

   ```powershell
   Copy-Item -Recurse <插件目录> <用户目录>\.dsh\node_modules\@dsh-local\wps-cloud   # <用户目录> 即 C:\Users\<你的用户名>
   ```

2. 让插件能解析 DSH 工具定义包（Windows 下用 junction 符号链接，指向 dsh 安装内的真实包）：

   ```powershell
   $dsh = "<用户目录>\.npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
   New-Item -ItemType Directory -Force <用户目录>\.dsh\node_modules\@deepseek-ai | Out-Null
   New-Item -ItemType Junction <用户目录>\.dsh\node_modules\@deepseek-ai\dsh-tools -Target "$dsh\dsh-tools" | Out-Null
   New-Item -ItemType Junction <用户目录>\.dsh\node_modules\@deepseek-ai\schemastery -Target "$dsh\schemastery" | Out-Null
   ```

3. 在 web 配置层（`<用户目录>\.dsh\profiles\web\cordis.patch.yml`，即 C:\Users\<你的用户名>\.dsh\...）追加一行（或参考 `cordis.patch.sample.yml`）：

   ```yaml
   - insert:
       - id: wps-cloud
         name: '@dsh-local/wps-cloud'
         config:
           autoOpenLogin: true
   ```

4. 重启 `dsh web`（或 `dsh --profile web`）。重启后：
   - 打开 **设置 → WPS 云文档** 可见状态卡片与登录按钮；
   - 或直接让 Agent 调用 `wps_auth_status` 验证。

## 配置

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `sid` | 手动指定会话（一般不需要，首次会自动登录抓取） | 空 |
| `stateFile` | 会话保存文件（支持 `~` 前缀） | `$DSH_HOME/wps-cloud-auth.json` |
| `cliPath` | kdocs-cli 可执行文件路径；留空自动查找/下载 | 空 |
| `autoOpenLogin` | 需要登录时是否自动弹出浏览器 | `true` |
| `openLoginOnUnauthorized` | 调用未登录工具时是否自动弹窗 | `true` |
| `loginThrottleMs` | 自动弹窗最小间隔 | `30000` |
| `loginTimeoutMs` | 登录等待超时（毫秒） | `300000` |
| `browserPath` | 受控浏览器可执行文件路径；留空自动探测 Edge/Chrome | 空 |
| `readMaxChars` | `wps_read_document` 单次返回上限 | `100000` |
| `timeoutMs` | 默认工具超时（毫秒） | `60000` |
| `callbackPath` | 设置页路由前缀 | `/api/wps/oauth` |

## 使用

### 方式一：对话中自动弹出登录窗口（推荐）

1. 让 Agent 做任何 WPS 云文档操作（如“列出我的 WPS 云文档”）。
2. 插件检测到未登录，**自动弹出系统浏览器的登录窗口**（`https://365.kdocs.cn/`）。
3. 在窗口中用 WPS 账号登录并完成（未登录会自动跳到 WPS 官方登录页）。
4. 插件自动抓取会话并保存，无需复制任何内容。
5. 回到 DSH 告诉 Agent“继续”，文档工具即可使用。

### 方式二：设置页登录

打开 **设置 → WPS 云文档**，点击「登录 WPS 云文档」按钮弹出登录窗口；完成后页面自动显示“已登录”。

### 方式四：输入框附件图标（快速选取云文档 / 本地文件，云端与本地统一作为附件）

对话输入框 **+ 号左侧**有一个云朵图标按钮（WPS 云文档）：

- 点击弹出云文档面板（面板配色使用 DSH 的 `--dsw-alias-*` 设计变量，自动跟随浅色/深色主题），可**浏览目录 / 搜索**云盘文件；点击云端文件即作为「附件」处理。
- **云端文件**：普通 Office 格式（docx/pptx/xlsx/pdf 等）直接下载到本机 `~/.dsh/wps-uploads/`；金山专有格式（.dbt 多维表格、.otl 智能文档等）不支持直接下载，自动降级为读取内容并暂存为同名 `.md` 文本附件。均在输入框生成 `请读取并讨论我添加的附件《xxx》（云端文档，文件路径：…）` 指令，回车让 Agent 读取本地副本讨论（不上传回云端）。
- **本地文档**：面板提供「**上传本地文档**」入口。因浏览器安全限制无法获得本地绝对路径、且 DSH 原生附件仅支持图片，本地文件会暂存到本机 `~/.dsh/wps-uploads/`（不上传云端），并在输入框生成 `请读取并讨论我添加的附件《xxx》（本地文档，文件路径：…）` 指令，Agent 直接读取该本地文件讨论。

### 方式三：手动回传会话（受控浏览器不可用时）

1. 用任意浏览器登录 `https://365.kdocs.cn/`。
2. 按 F12 打开开发者工具 → Application → Cookies → `365.kdocs.cn`，复制 `wps_sid` 的值。
3. 通过 `wps_authorize` 的 `sid` 参数回传完成绑定。

### 示例对话

- “列出我 WPS 云文档里的文件” → `wps_list_files`
- “找到名为‘季度报告’的文档并读取内容” → `wps_search_files` + `wps_read_document`
- “把 D:\report.docx 上传到我的文档” → `wps_upload_file`
- “在 WPS 里新建一个叫 2025 的文件夹” → `wps_create_folder`

## 数据与安全

- 会话（`wps_sid`）保存在 `$DSH_HOME/wps-cloud-auth.json`（权限 0600），仅主机进程可读。
- 所有云文档操作都在主机进程内调用金山官方 kdocs-cli 完成，会话不出进程。
- 下载默认保存到 `$DSH_HOME/wps-downloads/`；同名文件自动加序号，不覆盖。
- `wps_sid` 等同你 WPS 账号的登录会话，属高敏感凭证；请勿泄露给他人，退出登录后立即失效。
- 本插件使用金山网页版内部通道（非开放平台 OpenAPI），接口可能随网页版变动，属个人使用场景。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 弹窗打开的是 365.kdocs.cn，登录后跳到 account.wps.cn | 正常：那是 WPS 官方统一登录页，登录后自动回到云文档 |
| 自动弹窗没有出现 | 确认 `autoOpenLogin: true`、已配置 `browserPath`（或本机装有 Edge/Chrome）；或直接运行 `wps_authorize` |
| 提示“会话已失效/请重新登录” | 会话过期，重新运行 `wps_authorize` 登录一次 |
| 提示“未找到 kdocs-cli” | 插件自动下载失败时，手动把 kdocs-cli.exe 放到 `<用户目录>\.dsh\wps-cloud\`，或在配置 `cliPath` 指定路径。已安装 WPS 灵犀桌面的机器，插件会自动使用灵犀自带的 kdocs-cli（`C:\Program Files\lingxi-desktop\resources\kdocs-cli\`） |
| 设置页/面板始终显示“未登录”，但网页已登录 | 多为 dsh web 启动环境找不到 kdocs-cli 引擎（GUI 启动器无 `KDOCS_CLI_PATH` 环境变量）。解决：把 kdocs-cli.exe 复制到 `<用户目录>\.dsh\wps-cloud\`（v2.6.0 起自动兼容灵犀自带路径） |
| 显示“已登录（今日接口配额已用完）”，列文件报 `429001 调用次数已达上限` | kdocs-cli 每日调用配额耗尽，次日 08:00 自动恢复。登录状态本身正常，无需重新登录（v2.7.0 起状态检查零引擎调用，不再因轮询烧配额） |
| 读取大文件报“文件大小错误” | 超大文档内容提取受限，改用 `wps_download_file` 下载后本地处理 |
| `wps_delete_file` 不可用 | kdocs-cli 未暴露删除接口，请到 https://365.kdocs.cn 网页端删除 |
| 工具没出现 | 确认插件已装入 `$DSH_HOME\node_modules\@dsh-local\wps-cloud`、patch 行已添加，并重启 dsh |
| 设置页没有「WPS 云文档」 | 客户端插件未加载：确认 package.json 有 `dsh.client` 元数据且 `lib/client.js` 存在，重启 dsh |

## 相关链接

- WPS 网页版：https://365.kdocs.cn
- WPS 官方登录：https://account.wps.cn
- 金山文档开放平台（如需企业级接入）：https://developer.kdocs.cn
