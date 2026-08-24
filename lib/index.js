/**
 * @dsh-local/wps-cloud — WPS 云文档 DSH 插件（v2 · 普通用户版）
 *
 * 针对「普通 WPS 用户、无开发者账号」场景：
 *   - 授权：弹出系统浏览器打开 WPS 网页版（365.kdocs.cn），用户用 WPS 账号
 *     手动登录后，插件通过 CDP 自动抓取登录会话 wps_sid，保存到本地。
 *   - 引擎：调用金山官方 kdocs-cli（首次自动下载）访问个人云文档。
 *   - 无需开发者账号 / APPID / APPKEY，也无需 OAuth 回调地址。
 *
 * 依赖说明：仅使用 Node 内置模块 + DSH 自带包 + 全局 fetch/WebSocket（Node>=22）。
 * 出于账号安全，wps_sid 属高敏感凭证，只保存在本机令牌文件（0600），绝不外发。
 */

import { createHash } from 'node:crypto'
import { spawn, spawnSync, execSync } from 'node:child_process'
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, renameSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis 插件名。 */
export const name = 'wps-cloud'

/** 插件硬依赖：工具注册表、系统提示与 web 设置页路由（web profile 提供）。 */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** 可配置项（schemastery 驱动设置表单 / 行配置校验）。 */
export const Config = z.object({
  /** WPS 网页版登录后抓取的会话凭证。留空则首次使用时弹出浏览器登录。 */
  sid: z.string().default(''),
  /** 会话持久化文件；为空时使用 $DSH_HOME/wps-cloud-auth.json。 */
  stateFile: z.string().default(''),
  /** kdocs-cli 可执行文件路径；留空时自动查找/下载。 */
  cliPath: z.string().default(''),
  /** 需要授权时是否自动打开系统浏览器登录窗口（默认 true）。 */
  autoOpenLogin: z.boolean().default(true),
  /** 调用未授权的 wps_* 工具时是否自动弹窗（受 loginThrottleMs 节流）。 */
  openLoginOnUnauthorized: z.boolean().default(true),
  /** 自动弹窗最小间隔（毫秒）。 */
  loginThrottleMs: z.number().default(30000),
  /** 受控浏览器登录等待超时（毫秒），超时后提示手动回传 sid。 */
  loginTimeoutMs: z.number().default(300000),
  /** 本机设置页路由前缀（无需回调，仅用于状态/登录/退出）。 */
  callbackPath: z.string().default('/wps-oauth'),
  /** 受控浏览器可执行文件路径；留空时自动探测 Edge/Chrome。 */
  browserPath: z.string().default(''),
  /** wps_read_document 单次返回最大字符数。 */
  readMaxChars: z.number().default(100000),
  /** 默认工具超时（毫秒）。 */
  timeoutMs: z.number().default(60000),
})

/** kdocs-cli 下载地址（Windows amd64，金山官方 KS3 存储）。 */
const KDOCS_CLI_DOWNLOAD = 'https://solution.ks3-cn-beijing.ksyuncs.com/kdocs_cli/win/kdocs-cli.exe'
const KDOCS_CLI_NAME = 'kdocs-cli.exe'

/** 登录页：WPS 网页版（365.kdocs.cn），未登录会自动跳转到 WPS 官方统一登录页。 */
const LOGIN_PAGE = 'https://365.kdocs.cn/'

/** DSH 主目录。 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 本插件目录。 */
function pluginDir() {
  return dirname(fileURLToPath(import.meta.url))
}

/** 展开带 ~ 的路径。 */
function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/**
 * 从 Windows 凭据管理器读取 wps365-cli 保存的 wps_sid。
 * 该 sid 与 kdocs-cli 引擎（密钥链 token）同属一个登录会话，
 * 是唯一能用于下载 URL 鉴权的有效凭证。
 * 返回 sid 字符串（如 V02ShV...），读不到返回空串。
 */
function readKeychainSid() {
  const script = join(pluginDir(), 'read_keychain_sid.py')
  if (!existsSync(script)) return ''
  const pyCandidates = [
    process.env.WPS_CLOUD_PYTHON || '',
    process.env.PYTHON || '',
    join(homedir(), 'AppData', 'Roaming', 'WPS 灵犀', 'python-env', 'python.exe'),
    'python',
    'python3',
    'py',
  ].filter(Boolean)
  for (const py of pyCandidates) {
    try {
      const out = execSync(`"${py}" "${script}"`, {
        timeout: 5000,
        encoding: 'utf-8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const sid = String(out || '').trim()
      if (sid && /^V02[A-Za-z0-9]{10,}/.test(sid)) return sid
    } catch {
      /* try next */
    }
  }
  return ''
}

/** 默认令牌文件路径。 */
function defaultStateFile() {
  return join(dshHome(), 'wps-cloud-auth.json')
}

/** sleep。 */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

/** 格式化字节数。 */
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return String(n ?? '')
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 下载文件到本地。可带 wps_sid 会话与 365 来源头（签名下载地址需要）。 */
async function downloadToFile(url, destPath, label, sid) {
  const headers = {
    Referer: 'https://365.kdocs.cn/',
    Origin: 'https://365.kdocs.cn',
    ...(sid ? { Cookie: `wps_sid=${sid}; csrf=${sid}` } : {}),
  }
  const res = await fetch(url, { headers })
  if (!res.ok) {
    throw new Error(`WPS ${label} 下载失败：HTTP ${res.status}${res.status === 403 ? '（下载地址需登录会话，已自动携带）' : ''}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  mkdirSync(dirname(destPath), { recursive: true })
  writeFileSync(destPath, buffer, { mode: 0o600 })
  return buffer.length
}

/** 在目标目录下寻找给定名字的可执行文件。 */
function findInDir(dir, names) {
  if (!dir || !existsSync(dir)) return null
  for (const n of names) {
    const p = join(dir, n)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * WPS 会话（wps_sid）管理器：负责读写本地令牌、校验有效期。
 */
class WpsSidAuth {
  constructor(config) {
    this.config = config
    this.stateFile = config.stateFile ? expandHome(config.stateFile) : defaultStateFile()
    this.state = this.load()
    if (config.sid && config.sid !== this.state.sid) {
      this.save({ sid: config.sid, savedAt: Date.now() })
    }
  }

  load() {
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch {
      return {}
    }
  }

  save(patch = {}) {
    this.state = { ...this.state, ...patch }
    const file = this.stateFile
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSafe(tmp, file)
  }

  hasSid() {
    return Boolean(this.state.sid)
  }

  sid() {
    return this.state.sid || ''
  }

  clear() {
    this.save({ sid: undefined, savedAt: undefined, user: undefined, driveId: undefined })
  }

  driveId() {
    return this.state.driveId || ''
  }

  setDriveId(driveId) {
    if (driveId && driveId !== this.state.driveId) this.save({ driveId })
  }

  summary() {
    const sid = this.sid()
    const masked = sid ? `${sid.slice(0, 4)}…${sid.slice(-4)}` : ''
    return [
      `会话凭证 wps_sid: ${sid ? `已保存（${masked}）` : '未保存'}`,
      `令牌文件: ${this.stateFile}`,
      ...(this.state.user ? [`当前用户: ${this.state.user}`] : []),
    ].join('\n')
  }
}

/** 跨进程临时文件替换（Windows 下 rename 到已存在目标会失败，先删旧文件）。 */
function renameSafe(from, to) {
  try {
    rmSync(to, { force: true })
  } catch {
    /* ignore */
  }
  try {
    renameSync(from, to)
  } catch {
    // 极端并发下再试一次
    renameSync(from, to)
  }
}

/**
 * kdocs-cli 引擎：定位 / 自动下载 / 调用金山官方 CLI。
 */
class KdocsCli {
  constructor(config) {
    this.config = config
  }

  /** 候选可执行文件路径（按优先级）。 */
  candidatePaths() {
    const paths = []
    if (this.config.cliPath) paths.push(expandHome(this.config.cliPath))
    if (process.env.KDOCS_CLI_PATH) paths.push(process.env.KDOCS_CLI_PATH)
    paths.push(join(dshHome(), 'wps-cloud', KDOCS_CLI_NAME))
    paths.push(join(pluginDir(), 'tools', KDOCS_CLI_NAME))
    paths.push(join(homedir(), 'AppData', 'Roaming', 'WPS 灵犀', 'serverdir', KDOCS_CLI_NAME))
    return [...new Set(paths.filter(Boolean))]
  }

  findCli() {
    for (const p of this.candidatePaths()) {
      try {
        if (existsSync(p) && statSync(p).isFile()) return p
      } catch {
        /* ignore */
      }
    }
    return null
  }

  ensureCli() {
    const found = this.findCli()
    if (found) return found
    const dest = join(dshHome(), 'wps-cloud', KDOCS_CLI_NAME)
    throw new Error(
      `WPS: 未找到 kdocs-cli（${dest} 不存在）。请手动把 kdocs-cli.exe 放到 ${join(dshHome(), 'wps-cloud')} 目录，或在插件配置 cliPath 中指定路径。`,
    )
  }

  /** 解析 kdocs-cli 输出：code!=0 时抛错；并递归解包嵌套的 {code,data} 包装。 */
  parseOutput(text, label) {
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`WPS ${label}: kdocs-cli 输出不是 JSON（前 200 字符：${text.slice(0, 200)}）`)
    }
    if (json.code !== 0) {
      const message = json.message || json.msg || '未知错误'
      throw new Error(`WPS ${label} 失败（code=${json.code}）：${message}`)
    }
    let data = json.data
    // 部分接口返回 {code, data:{code, data:{...}}} 双层包装，递归解包
    while (
      data &&
      typeof data === 'object' &&
      typeof data.code === 'number' &&
      data.code === 0 &&
      data.data !== undefined
    ) {
      data = data.data
    }
    if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
      const message = data.message || data.msg || '未知错误'
      throw new Error(`WPS ${label} 失败（内层 code=${data.code}）：${message}`)
    }
    return data
  }

  /**
   * 调用 kdocs-cli。
   * 关键：子进程环境里必须清空 TMP_LX_UUID / 只注入本插件保存的 WPS_SID，
   * 避免覆盖成宿主环境（如灵犀）注入的会话。
   */
  run(service, action, params = {}, options = {}) {
    const cli = this.ensureCli()
    const sid = this.sid
    const timeout = options.timeout || this.config.timeoutMs
    const args = [service, action, JSON.stringify(params || {}), '--compact']
    const env = { ...process.env, WPS_SID: sid, TMP_LX_UUID: '' }
    return new Promise((resolvePromise, rejectPromise) => {
      let child
      try {
        child = spawn(cli, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        rejectPromise(new Error(`WPS: 无法启动 kdocs-cli（${error.message}）`))
        return
      }
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        rejectPromise(new Error(`WPS ${label(service, action)}: kdocs-cli 执行超时（${timeout}ms）`))
      }, timeout)
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      child.on('error', (error) => {
        clearTimeout(timer)
        rejectPromise(new Error(`WPS ${label(service, action)}: 启动失败（${error.message}）`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0 && !stdout) {
          rejectPromise(new Error(`WPS ${label(service, action)}: kdocs-cli 退出码 ${code}（${stderr.trim().slice(0, 200)}）`))
          return
        }
        try {
          resolvePromise(this.parseOutput(stdout, label(service, action)))
        } catch (error) {
          rejectPromise(error)
        }
      })
    })
  }
}

function label(service, action) {
  return `${service}.${action}`
}

/**
 * 最小 CDP 客户端（基于 Node 全局 WebSocket）。
 */
class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl)
    this.ws.addEventListener('message', (ev) => this.onMessage(ev))
    await new Promise((resolvePromise, rejectPromise) => {
      this.ws.addEventListener('open', () => resolvePromise(), { once: true })
      this.ws.addEventListener('error', () => rejectPromise(new Error('无法连接浏览器调试端口')), { once: true })
    })
  }

  onMessage(ev) {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolvePromise, rejectPromise } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) rejectPromise(new Error(`CDP ${msg.error.message || 'error'}`))
      else resolvePromise(msg.result || {})
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolvePromise, rejectPromise })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() {
    try { this.ws?.close() } catch { /* ignore */ }
  }
}

/** 探测系统浏览器（优先 Edge，其次 Chrome）。 */
function findBrowser(config) {
  if (config.browserPath) {
    const p = expandHome(config.browserPath)
    if (existsSync(p)) return p
  }
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const candidates = [
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 从 CDP cookie 列表中提取 wps_sid。优先匹配 kdocs 域（365.kdocs.cn / .kdocs.cn），
 * 避免抓到 login.wps.cn 等其他域下同名的无效会话。 */
function findWpsSid(cookies) {
  if (!Array.isArray(cookies)) return ''
  const wpsSids = cookies.filter((c) => c.name === 'wps_sid' && c.value)
  if (!wpsSids.length) return ''
  const kdocs = wpsSids.filter((c) => /kdocs\.cn/i.test(c.domain || ''))
  return (kdocs[0] || wpsSids[0]).value
}

/** 杀掉受控浏览器进程树并清理临时 profile。 */
function killBrowser(proc, userDataDir) {
  if (proc && proc.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* ignore */
    }
  }
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/**
 * 受控浏览器登录：启动独立浏览器实例 → 打开 WPS 网页版 → 轮询抓取 wps_sid。
 * 返回 { sid, nickname }。超时抛错。
 */
async function captureSidViaBrowser(browserPath, config) {
  const port = 9333 + Math.floor(Math.random() * 500)
  const userDataDir = join(tmpdir(), `wps-cloud-login-${process.pid}-${Date.now()}`)
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'about:blank',
  ]
  let proc
  try {
    proc = spawn(browserPath, args, { detached: true, stdio: 'ignore', windowsHide: true })
  } catch (error) {
    throw new Error(`WPS: 无法启动浏览器（${error.message}）`)
  }

  // 等待调试端口就绪
  let wsUrl = ''
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      const info = await res.json()
      if (info.webSocketDebuggerUrl) {
        wsUrl = info.webSocketDebuggerUrl
        break
      }
    } catch {
      /* not ready yet */
    }
    await sleep(250)
  }
  if (!wsUrl) {
    killBrowser(proc, userDataDir)
    throw new Error('WPS: 浏览器调试端口未就绪，请重试或改用手动回传 sid 方式')
  }

  const cdp = new CdpConnection(wsUrl)
  await cdp.open()

  // 打开登录页
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: LOGIN_PAGE, newWindow: true })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const deadline = Date.now() + config.loginTimeoutMs
    // 记录已验证无效的 sid，避免反复验证同一无效值造成空等
    const badSids = new Set()
    while (Date.now() < deadline) {
      const { cookies } = await cdp.send('Network.getAllCookies', {}, sessionId)
      const sid = findWpsSid(cookies)
      if (sid && !badSids.has(sid)) {
        // 可选：用真实下载验证 sid 是否与 kdocs-cli 引擎（密钥链 token）同一会话
        if (config.verifySid) {
          let ok = false
          try {
            ok = await config.verifySid(sid)
          } catch {
            ok = false
          }
          if (!ok) {
            badSids.add(sid)
            // 无效 sid：继续等待登录完成后 cookie 更新为有效会话
            await sleep(2000)
            continue
          }
        }
        // 顺带取登录用户信息（365.kdocs.cn 页面 cookie 里的 nickname 或驱动 kdocs-cli 验证）
        const user = readNicknameCookie(cookies)
        cdp.close()
        killBrowser(proc, userDataDir)
        return { sid, nickname: user }
      }
      await sleep(2000)
    }
  } catch (error) {
    cdp.close()
    killBrowser(proc, userDataDir)
    throw error
  }

  cdp.close()
  killBrowser(proc, userDataDir)
  throw new Error(
    `WPS: 等待登录超时（${Math.round(config.loginTimeoutMs / 1000)} 秒）。` +
      '请在浏览器中登录 WPS 账号后，把 wps_sid 通过 wps_authorize 的 sid 参数回传（可从浏览器开发者工具 → Application → Cookies 复制）。',
  )
}

/** 从 CDP cookie 里尝试读取用户名（非必须，读不到忽略）。 */
function readNicknameCookie(cookies) {
  if (!Array.isArray(cookies)) return ''
  for (const c of cookies) {
    if ((c.name === 'nickname' || c.name === 'user_nickname' || c.name === 'display_name') && c.value) {
      try {
        return decodeURIComponent(c.value)
      } catch {
        return c.value
      }
    }
  }
  return ''
}

/** 判断错误是否属于「未登录/会话失效」。 */
function isAuthError(error) {
  const text = String(error && error.message ? error.message : error)
  return /未登录|尚未登录|登录态|会话已?失效|token.*invalid|auth.*fail|请先登录|请重新登录|login.*required/i.test(text)
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const auth = new WpsSidAuth(config)
  const cli = new KdocsCli(config)
  // 引擎持有的 sid 统一指向 auth（run 时读取）
  Object.defineProperty(cli, 'sid', { get: () => auth.sid() })

  /**
   * 验证 wps_sid 是否有效：用 kdocs-cli 引擎（密钥链 token）获取一个真实文件的下载地址，
   * 再用该 sid 作为 cookie 下载；HTTP 200 说明 sid 与引擎同属一个有效会话。
   * 返回 true/false。
   */
  async function verifySid(sid) {
    if (!sid) return false
    try {
      // 遍历文件（含翻页），找到第一个“可下载”的普通文件做真实下载探活。
      // .dbt/.otl 等金山专有格式不支持 download-file（会降级为 read-file、不走 sid），
      // 验证须落在“普通文件经 sid 下载”链路上：一旦找到可下载类型，按其结果立即判定。
      let pageToken = ''
      for (let page = 0; page < 8; page += 1) {
        const params = { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) }
        const data = await cli.run('drive', 'list-my-files', params, { timeout: 15000 })
        const items = Array.isArray(data.items) ? data.items : []
        for (const it of items) {
          if (!it || !it.id || it.type === 'folder' || it.type === 'dir') continue
          // 尝试拿到下载地址；不支持的类型会抛错，跳过
          let dlUrl = ''
          try {
            const info = await cli.run('drive', 'download-file', { file_id: it.id, with_hash: true }, { timeout: 10000 })
            dlUrl = info.url || info.download_url || info.downloadUrl || ''
          } catch {
            continue
          }
          if (!dlUrl) continue
          // 找到了可下载类型：用该 sid 下载，一次即可判定
          try {
            const res = await fetch(dlUrl, {
              headers: {
                Referer: 'https://365.kdocs.cn/',
                Origin: 'https://365.kdocs.cn',
                Cookie: `wps_sid=${sid}; csrf=${sid}`,
              },
              signal: AbortSignal.timeout(10000),
            })
            if (res.body) {
              try {
                await res.body.cancel()
              } catch { /* ignore */ }
            }
            return res.ok
          } catch {
            return false
          }
        }
        pageToken = data.next_page_token || ''
        if (!pageToken) break
      }
      // 云盘没有可下载的普通文件（空盘/全是文件夹或 dbt/otl 专有格式）：
      // 无法经 sid 下载验证，退化为“接受 sid”，交由后续请求兜底。
      return true
    } catch {
      return false
    }
  }
  // 供 captureSidViaBrowser 抓取后验证使用
  config.verifySid = verifySid

  /** 自动打开登录窗口（节流）。 */
  let lastLoginOpenAt = 0
  function maybeOpenLogin(force) {
    if (!config.autoOpenLogin) return null
    const now = Date.now()
    if (!force && now - lastLoginOpenAt < config.loginThrottleMs) return null
    lastLoginOpenAt = now
    const browser = findBrowser(config)
    if (!browser) return null
    // 异步触发，不阻塞调用方
    captureSidViaBrowser(browser, config)
      .then(({ sid, nickname }) => {
        if (sid) {
          auth.save({ sid, savedAt: Date.now(), user: nickname || undefined })
        }
      })
      .catch(() => {})
    return { browser }
  }

  /** 未授权时的提示生成器。 */
  function unauthorizedHint() {
    if (config.openLoginOnUnauthorized) {
      const opened = maybeOpenLogin(false)
      if (opened) {
        return '已自动打开 WPS 网页版登录窗口（365.kdocs.cn），请在弹出的浏览器窗口中用 WPS 账号登录；登录完成后插件会自动完成绑定，然后请重试。若窗口未弹出，可运行 wps_authorize 重新发起。'
      }
    }
    return '请运行 wps_authorize 完成登录（会弹出 WPS 网页版登录窗口）。'
  }

  /** 确保已授权：校验 sid 有效性（探活），失效时自动弹窗。 */
  /** 尝试从 Windows 密钥链恢复有效 sid（与 kdocs-cli 引擎同一会话）。成功返回 true。 */
  async function tryRestoreFromKeychain() {
    const kcSid = readKeychainSid()
    if (!kcSid || kcSid === auth.sid()) return false
    // 用真实下载验证密钥链 sid 是否有效
    const ok = await verifySid(kcSid)
    if (ok) {
      auth.save({ sid: kcSid, savedAt: Date.now() })
      try {
        await finalizeAuthorization()
      } catch { /* ignore */ }
      return true
    }
    return false
  }

  async function ensureAuthorized() {
    // 优先：若本地无 sid，先尝试从密钥链恢复
    if (!auth.hasSid()) {
      if (await tryRestoreFromKeychain()) return
      const hint = unauthorizedHint()
      throw new Error(`WPS: 尚未登录。${hint}`)
    }
    // 引擎探活：list-my-files 走 kdocs-cli 密钥链 token，与 sid 无关。
    // 引擎正常即认为已登录（列文件/读取/搜索均可用）；仅引擎认证失败才算未登录。
    // 注意：不用 download 探活结果判死刑——下载验证受环境因素影响（网络/代理/超时），
    // 误杀有效 sid 会导致“登录状态保持不了”；下载失败由具体下载接口用密钥链 sid 兑底重试。
    try {
      await cli.run('drive', 'list-my-files', { page_size: 1 }, { timeout: 20000 })
      return
    } catch (error) {
      if (isAuthError(error)) {
        // 引擎认证失败：先尝试密钥链恢复（可能引擎 token 已换新会话）
        if (await tryRestoreFromKeychain()) return
        auth.clear()
        const hint = unauthorizedHint()
        throw new Error(`WPS: 登录已失效（${error.message}）。${hint}`)
      }
      throw error
    }
  }

  /** 授权后校验 + 记录用户/云盘信息。 */
  async function finalizeAuthorization() {
    const data = await cli.run('drive', 'list-my-files', { page_size: 1 })
    const driveId = data.drive_id || ''
    if (driveId) auth.setDriveId(driveId)
    const first = (data.items || [])[0]
    const userName = first?.created_by?.name || ''
    if (userName) auth.save({ user: userName })
    return { driveId, userName }
  }

  /** 通过 file_id 解析 drive_id（优先缓存）。 */
  async function resolveDriveId(fileId) {
    if (!fileId || fileId === '0') {
      if (auth.driveId()) return auth.driveId()
      const data = await cli.run('drive', 'list-my-files', { page_size: 1 })
      const driveId = data.drive_id || ''
      if (driveId) auth.setDriveId(driveId)
      return driveId
    }
    const info = await cli.run('drive', 'get-file-info', { file_id: fileId, with_drive: true })
    const driveId = info.drive_id || ''
    if (driveId) auth.setDriveId(driveId)
    return driveId
  }

  /* ---------------- 注册工具 ---------------- */

  function register(tool) {
    ctx.tools.register(defineTool(tool))
  }

  function textRender(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  }

  /** 文件列表条目投影（kdocs-cli 原始字段 → 干净 JSON）。兼容两种结构：扁平条目 / {file:{...}} 嵌套条目。 */
  function projectItem(item) {
    const file = item && typeof item === 'object' && item.file && typeof item.file === 'object' ? item.file : item
    if (!file || typeof file !== 'object') {
      return { name: '', sizeText: '', isFolder: false, id: '', driveId: '', parentId: '', modifiedAt: null, linkUrl: '' }
    }
    const isFolder = file.type === 'folder' || file.type === 'dir' || file.type === 'shortcut'
    return {
      name: file.name ?? '',
      sizeText: formatBytes(file.size),
      isFolder,
      id: file.id ?? '',
      driveId: file.drive_id ?? '',
      parentId: file.parent_id ?? '',
      modifiedAt: file.mtime ?? null,
      linkUrl: file.link_url ?? '',
    }
  }

  function renderList(items, extra = '') {
    if (!items.length) return '（无文件）' + extra
    const lines = items.map((f) => {
      const kind = f.isFolder ? '📁 目录' : '📄 文件'
      const time = f.modifiedAt ? new Date(f.modifiedAt * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''
      return `- ${f.name}  [${kind}${f.isFolder ? '' : `, ${f.sizeText}`}]  id=${f.id}  mtime=${time}`
    })
    return lines.join('\n') + extra
  }

  register({
    name: 'wps_auth_status',
    description:
      '检查 WPS 云文档插件的登录状态：是否已保存会话（wps_sid）、会话是否有效、当前登录用户。首次使用先调用本工具；未登录时会自动弹出 WPS 网页版登录窗口。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          authorized: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      let authorized = false
      let loginHint = ''
      if (auth.hasSid()) {
        try {
          await finalizeAuthorization()
          authorized = true
        } catch (error) {
          if (isAuthError(error)) {
            auth.clear()
            loginHint = `\n登录已失效：${error.message}`
          } else {
            loginHint = `\n会话校验失败：${error.message}`
          }
        }
      } else if (config.openLoginOnUnauthorized) {
        const opened = maybeOpenLogin(false)
        loginHint = opened
          ? '\n已自动打开 WPS 网页版登录窗口（365.kdocs.cn），请在浏览器中登录 WPS 账号；完成后插件自动绑定，重新检查即可。'
          : '\n未登录：请运行 wps_authorize 完成登录。'
      }
      return {
        authorized,
        summary: (authorized ? '✅ 已登录 WPS 云文档\n' : '❌ 未登录\n') + auth.summary() + loginHint,
      }
    },
  })

  register({
    name: 'wps_authorize',
    description:
      '登录 WPS 云文档。不带 sid 时自动弹出 WPS 网页版登录窗口（365.kdocs.cn）：在弹窗中用 WPS 账号登录后，插件自动抓取会话并完成绑定，无需复制任何内容。若受控浏览器不可用或自动抓取失败，可手动把浏览器里的 wps_sid（开发者工具 → Application → Cookies → 365.kdocs.cn → wps_sid）通过 sid 参数回传。',
    parameters: {
      sid: { type: 'string', description: '（可选）手动回传的 wps_sid 会话值；自动弹窗流程不需要传' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nextStep: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.nextStep}\n\n${value.detail}` }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.sid) {
        // 手动回传模式：先保存，再用真实下载验证 sid 本身
        auth.save({ sid: args.sid, savedAt: Date.now() })
        try {
          const ok = await verifySid(args.sid)
          if (!ok) {
            auth.clear()
            return {
              nextStep: '登录失败',
              detail: '会话校验未通过：该 wps_sid 无法访问云文档下载（可能是已过期、不完整或复制自非 365.kdocs.cn 登录页）。\n请确认复制的 wps_sid 完整且来自登录后的 365.kdocs.cn。',
            }
          }
          const { driveId, userName } = await finalizeAuthorization()
          return {
            nextStep: '登录成功！',
            detail: `会话已保存并通过校验。${userName ? `当前用户：${userName}` : ''}（drive_id=${driveId || '未知'}）\n现在可以列出、读取、下载你的 WPS 云文档了。`,
          }
        } catch (error) {
          auth.clear()
          return {
            nextStep: '登录失败',
            detail: `会话校验未通过：${error.message}\n请确认复制的 wps_sid 完整且来自登录后的 365.kdocs.cn。`,
          }
        }
      }

      // 自动弹窗模式
      const browser = findBrowser(config)
      if (!browser) {
        return {
          nextStep: '无法自动打开浏览器',
          detail: '未找到 Edge/Chrome。请在插件配置 browserPath 中指定浏览器可执行文件路径，或改用手动回传 sid 方式（在浏览器登录 https://365.kdocs.cn 后，把 wps_sid 通过本工具的 sid 参数传回）。',
        }
      }
      try {
        const { sid, nickname } = await captureSidViaBrowser(browser, config)
        // captureSidViaBrowser 内部已用 verifySid 验证，此处二次确认
        const ok = await verifySid(sid)
        if (!ok) {
          // 抓取的 sid 无效（与引擎不同会话）：尝试从密钥链恢复有效 sid
          if (await tryRestoreFromKeychain()) {
            const { driveId, userName } = await finalizeAuthorization()
            return {
              nextStep: '登录成功！',
              detail: `已通过系统密钥链恢复 WPS 登录会话（与 kdocs-cli 引擎同一会话）。${userName ? `当前用户：${userName}` : ''}（drive_id=${driveId || '未知'}）\n现在可以列出、读取、下载你的 WPS 云文档了。`,
            }
          }
          return {
            nextStep: '自动登录未完成',
            detail: '抓取到的会话无法访问云文档下载，且系统密钥链中未找到有效会话。请确认已在 WPS 灵犀或 WPS 365 客户端登录 WPS 账号，然后重试。也可改用手动回传 sid 方式：在浏览器登录 https://365.kdocs.cn 后，把 wps_sid 通过本工具的 sid 参数回传。',
          }
        }
        auth.save({ sid, savedAt: Date.now(), user: nickname || undefined })
        const { driveId, userName } = await finalizeAuthorization()
        return {
          nextStep: '登录成功！',
          detail: `已在弹出的浏览器窗口中完成 WPS 登录，会话已自动保存并通过下载验证。${userName || nickname ? `当前用户：${userName || nickname}` : ''}（drive_id=${driveId || '未知'}）\n现在可以列出、读取、下载你的 WPS 云文档了。`,
        }
      } catch (error) {
        return {
          nextStep: '自动登录未完成',
          detail: `${error.message}\n可改用手动回传 sid 方式：在浏览器登录 https://365.kdocs.cn 后，把 wps_sid 通过本工具的 sid 参数回传。`,
        }
      }
    },
  })

  register({
    name: 'wps_logout',
    description: '清除本地保存的 WPS 云文档登录会话（wps_sid），使插件回到未登录状态。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, detail: { type: 'string', required: true } },
      },
      render: textRender,
    },
    isConcurrencySafe: () => false,
    async execute() {
      auth.clear()
      return { ok: true, detail: '已清除本地 WPS 会话，需重新登录才能继续使用云文档。' }
    },
  })

  register({
    name: 'wps_list_files',
    description: '列出 WPS 云文档指定目录下的文件与文件夹（默认“我的文档”根目录），支持分页、排序与类型过滤。',
    parameters: {
      parentId: { type: 'string', description: '目标目录 ID（文件列表中的 id 字段）；不传或 "0" 表示根目录' },
      count: { type: 'integer', description: '获取数量，默认 50' },
      pageToken: { type: 'string', description: '分页 token；翻页时传上次返回的 nextPageToken' },
      filter: { type: 'string', description: '只列类型：folder 或 file' },
      orderBy: { type: 'string', description: '排序字段：ctime / mtime / dtime / fname / fsize' },
      order: { type: 'string', description: '排序方向：asc / desc' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                sizeText: { type: 'string', required: true },
                isFolder: { type: 'boolean', required: true },
                id: { type: 'string', required: true },
                modifiedAt: { type: 'integer' },
              },
            },
          },
          nextPageToken: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await ensureAuthorized()
      const parentId = args.parentId || '0'
      const pageSize = args.count || 50
      let data
      if (parentId === '0') {
        data = await cli.run('drive', 'list-my-files', {
          page_size: pageSize,
          ...(args.pageToken ? { page_token: args.pageToken } : {}),
        })
      } else {
        const driveId = await resolveDriveId(parentId)
        data = await cli.run('drive', 'list-files', {
          drive_id: driveId,
          parent_id: parentId,
          page_size: pageSize,
          ...(args.pageToken ? { page_token: args.pageToken } : {}),
          ...(args.filter ? { filter_type: args.filter } : {}),
          ...(args.orderBy ? { order_by: args.orderBy } : {}),
          ...(args.order ? { order: args.order } : {}),
        })
      }
      const items = (data.items || []).map(projectItem)
      const next = data.next_page_token || ''
      const tail = next ? `\n（还有更多，page_token=${next}）` : ''
      return {
        files: items.map((f) => ({ name: f.name, sizeText: f.sizeText, isFolder: f.isFolder, id: f.id, modifiedAt: f.modifiedAt })),
        nextPageToken: next,
        summary: `WPS 云文档列表（${items.length} 项）：\n${renderList(items, tail)}`,
      }
    },
  })

  register({
    name: 'wps_list_all_files',
    description: '递归列出 WPS 云文档全部文件（忽略目录结构，扁平列表）。注意：大型云空间可能较慢，仅建议在文件不多时使用。',
    parameters: {
      count: { type: 'integer', description: '每层最多获取数量，默认 100' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                sizeText: { type: 'string', required: true },
                isFolder: { type: 'boolean', required: true },
                id: { type: 'string', required: true },
                path: { type: 'string', required: true },
              },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await ensureAuthorized()
      const pageSize = args.count || 100
      const driveId = await resolveDriveId('0')
      const all = []
      const seen = new Set()

      async function walk(parentId, pathName) {
        let pageToken = ''
        do {
          const data = await cli.run('drive', 'list-files', {
            drive_id: driveId,
            parent_id: parentId,
            page_size: pageSize,
            ...(pageToken ? { page_token: pageToken } : {}),
          })
          const items = data.items || []
          for (const item of items) {
            const f = projectItem(item)
            if (seen.has(f.id)) continue
            seen.add(f.id)
            all.push({ ...f, path: pathName ? `${pathName}/${f.name}` : f.name })
            if (f.isFolder) await walk(f.id, pathName ? `${pathName}/${f.name}` : f.name)
          }
          pageToken = data.next_page_token || ''
        } while (pageToken)
      }

      // 根目录
      const root = await cli.run('drive', 'list-my-files', { page_size: pageSize })
      for (const item of root.items || []) {
        const f = projectItem(item)
        if (seen.has(f.id)) continue
        seen.add(f.id)
        all.push({ ...f, path: f.name })
        if (f.isFolder) await walk(f.id, f.name)
      }

      return {
        files: all,
        summary: `WPS 云文档全部文件（${all.length} 项）：\n${renderList(all)}`,
      }
    },
  })

  register({
    name: 'wps_recent_files',
    description: '列出当前用户最近访问过的 WPS 云文档。',
    parameters: {
      count: { type: 'integer', description: '获取数量，默认 20' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                sizeText: { type: 'string', required: true },
                isFolder: { type: 'boolean', required: true },
                id: { type: 'string', required: true },
              },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await ensureAuthorized()
      const data = await cli.run('drive', 'list-latest-items', { page_size: args.count || 20 })
      const items = (data.items || []).map(projectItem)
      return {
        files: items.map((f) => ({ name: f.name, sizeText: f.sizeText, isFolder: f.isFolder, id: f.id })),
        summary: `最近访问的 WPS 云文档（${items.length} 项）：\n${renderList(items)}`,
      }
    },
  })

  register({
    name: 'wps_search_files',
    description: '按文件名搜索 WPS 云文档中的文件与文件夹。',
    parameters: {
      fileName: { type: 'string', required: true, description: '搜索关键词（匹配文件名）' },
      count: { type: 'integer', description: '获取数量，默认 50' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                sizeText: { type: 'string', required: true },
                isFolder: { type: 'boolean', required: true },
                id: { type: 'string', required: true },
              },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await ensureAuthorized()
      const data = await cli.run('drive', 'search-files', {
        keyword: args.fileName,
        type: 'file_name',
        page_size: args.count || 50,
      })
      const items = (data.items || []).map(projectItem)
      return {
        files: items.map((f) => ({ name: f.name, sizeText: f.sizeText, isFolder: f.isFolder, id: f.id })),
        summary: `搜索“${args.fileName}”结果（${items.length} 项）：\n${renderList(items)}`,
      }
    },
  })

  register({
    name: 'wps_get_file_info',
    description: '获取 WPS 云文档单个文件/文件夹的详细信息（名称、大小、类型、时间戳、ID、链接）。',
    parameters: {
      fileToken: { type: 'string', required: true, description: '文件 ID（列表中的 id 字段）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          info: { type: 'object', required: true, additionalProperties: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await ensureAuthorized()
      const info = await cli.run('drive', 'get-file-info', { file_id: args.fileToken, with_drive: true })
      const projected = projectItem(info)
      return {
        info: projected,
        summary: `文件信息：\n${JSON.stringify(projected, null, 2)}`,
      }
    },
  })

  register({
    name: 'wps_read_document',
    description:
      '读取 WPS 云文档的正文内容（支持 docx/doc/xlsx/xls/pptx/ppt/pdf/otl 等），自动转为 Markdown 文本返回；超长内容截断。',
    parameters: {
      fileToken: { type: 'string', required: true, description: '文件 ID（列表中的 id 字段）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fname: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          charCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.text + (value.truncated ? `\n\n（内容已截断，完整字符数 ${value.charCount}）` : '') },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await ensureAuthorized()
      const data = await cli.run('drive', 'read-file', { file_id: args.fileToken }, { timeout: Math.max(config.timeoutMs, 120000) })
      // 兼容两种返回：直接文本 / 结构化
      const rawText =
        typeof data === 'string' ? data : (data.content ?? data.markdown ?? data.text ?? JSON.stringify(data))
      const text = String(rawText)
      const truncated = text.length > config.readMaxChars
      return {
        fname: data.fname || data.name || args.fileToken,
        text: truncated ? text.slice(0, config.readMaxChars) : text,
        truncated,
        charCount: text.length,
      }
    },
  })

  register({
    name: 'wps_download_file',
    description: '把 WPS 云文档下载到本地磁盘。返回本地保存路径与文件大小。',
    parameters: {
      fileToken: { type: 'string', required: true, description: '文件 ID（列表中的 id 字段）' },
      targetPath: { type: 'string', description: '本地保存路径（可为目录或完整文件名）；缺省保存到 $DSH_HOME/wps-downloads/ 下' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          savedPath: { type: 'string', required: true },
          size: { type: 'integer', required: true },
          sizeText: { type: 'string', required: true },
          sha1: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已下载到 ${value.savedPath}（${value.sizeText}，sha1=${value.sha1 || '未知'}）` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await ensureAuthorized()
      const info = await cli.run('drive', 'download-file', { file_id: args.fileToken, with_hash: true })
      const url = info.url || info.download_url || info.downloadUrl || ''
      if (!url) {
        throw new Error(`WPS: 未能获取下载地址（返回：${JSON.stringify(info).slice(0, 300)}）`)
      }
      // 优先用文件信息里的真实文件名；失败则回退
      let fname = info.fname || info.name || ''
      if (!fname) {
        try {
          const meta = await cli.run('drive', 'get-file-info', { file_id: args.fileToken })
          fname = meta.name || ''
        } catch {
          /* ignore */
        }
      }
      if (!fname) fname = `${args.fileToken}.bin`
      let target
      if (args.targetPath) {
        target = args.targetPath
      } else {
        target = join(dshHome(), 'wps-downloads', fname)
      }
      // 避免同名覆盖：加序号
      let finalPath = target
      let counter = 1
      while (existsSync(finalPath)) finalPath = `${target}.${counter++}`
      // 下载失败（403 等）时用密钥链 sid 兑底重试（下载 URL 签名与引擎会话绑定）
      let size = 0
      try {
        size = await downloadToFile(url, finalPath, '文件', auth.sid())
      } catch (dlError) {
        const kcSid = readKeychainSid()
        if (kcSid && kcSid !== auth.sid()) {
          size = await downloadToFile(url, finalPath, '文件', kcSid)
          auth.save({ sid: kcSid, savedAt: Date.now() })
        } else {
          throw dlError
        }
      }
      const sha1 = info.hash?.sum || info.hashes?.sha1 || info.sha1 || ''
      return { savedPath: finalPath, size, sizeText: formatBytes(size), sha1 }
    },
  })

  register({
    name: 'wps_upload_file',
    description: '把本地文件上传到 WPS 云文档指定目录（默认“我的文档”根目录）。',
    parameters: {
      localPath: { type: 'string', required: true, description: '本地文件路径（绝对路径或相对当前工作目录）' },
      parentId: { type: 'string', description: '目标目录 ID；不传上传到根目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fileId: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已上传 ${value.name}，fileId=${value.fileId}` }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      await ensureAuthorized()
      const localPath = args.localPath
      if (!existsSync(localPath)) throw new Error(`本地文件不存在：${localPath}`)
      const stat = statSync(localPath)
      if (stat.isDirectory()) throw new Error(`目标是目录，请指定文件：${localPath}`)
      const buffer = readFileSync(localPath)
      const name = basename(localPath)
      const driveId = args.parentId ? await resolveDriveId(args.parentId) : (auth.driveId() || await resolveDriveId('0'))
      const data = await cli.run('drive', 'upload-new-file', {
        drive_id: driveId,
        parent_id: args.parentId || '0',
        name,
        content_base64: buffer.toString('base64'),
      }, { timeout: Math.max(config.timeoutMs, 120000) })
      return {
        fileId: data.id || data.file_id || '',
        name: data.name || name,
      }
    },
  })

  register({
    name: 'wps_create_document',
    description:
      '在 WPS 云文档指定目录创建空白文档。扩展名决定类型：.docx/.doc（文字）、.xlsx/.xls（表格）、.pptx/.ppt（演示）、.otl（在线文档）、.ksheet（在线表格）、.dbt（多维表）。',
    parameters: {
      filename: { type: 'string', required: true, description: '文档名，需包含扩展名，例如 report.docx' },
      parentId: { type: 'string', description: '所属目录 ID；不传创建到根目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fileId: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已创建 ${value.name}，fileId=${value.fileId}` }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      await ensureAuthorized()
      const extMatch = /\.([A-Za-z0-9]+)$/.exec(args.filename)
      if (!extMatch) throw new Error(`文件名需包含扩展名：${args.filename}`)
      const fileExtension = extMatch[1].toLowerCase()
      const driveId = args.parentId ? await resolveDriveId(args.parentId) : (auth.driveId() || await resolveDriveId('0'))
      const data = await cli.run('drive', 'create-empty-file', {
        drive_id: driveId,
        parent_id: args.parentId || '0',
        name: args.filename,
        file_extension: fileExtension,
        on_name_conflict: 'rename',
      })
      return {
        fileId: data.id || data.file_id || '',
        name: data.name || args.filename,
      }
    },
  })

  register({
    name: 'wps_create_folder',
    description: '在 WPS 云文档创建文件夹（默认根目录）。',
    parameters: {
      name: { type: 'string', required: true, description: '文件夹名（不带后缀）' },
      parentId: { type: 'string', description: '父目录 ID；不传创建到根目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          folderId: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已创建文件夹 ${value.name}，folderId=${value.folderId}` }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      await ensureAuthorized()
      const driveId = args.parentId ? await resolveDriveId(args.parentId) : (auth.driveId() || await resolveDriveId('0'))
      const data = await cli.run('drive', 'create-folder', {
        drive_id: driveId,
        parent_id: args.parentId || '0',
        name: args.name,
        on_name_conflict: 'rename',
      })
      return {
        folderId: data.id || data.file_id || '',
        name: data.name || args.name,
      }
    },
  })

  register({
    name: 'wps_rename_file',
    description: '重命名 WPS 云文档中的文件或文件夹（新名需带后缀）。',
    parameters: {
      fileToken: { type: 'string', required: true, description: '文件/文件夹 ID' },
      newName: { type: 'string', required: true, description: '新文件名（需带后缀，例如 new-report.docx）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, detail: { type: 'string', required: true } },
      },
      render: textRender,
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      await ensureAuthorized()
      const driveId = await resolveDriveId(args.fileToken)
      await cli.run('drive', 'rename-file', {
        drive_id: driveId || undefined,
        file_id: args.fileToken,
        dst_name: args.newName,
      })
      return { ok: true, detail: `已将 ${args.fileToken} 重命名为 ${args.newName}` }
    },
  })

  register({
    name: 'wps_move_file',
    description: '把 WPS 云文档中的文件或文件夹移动到指定目录。',
    parameters: {
      fileToken: { type: 'string', required: true, description: '文件/文件夹 ID' },
      dstParentId: { type: 'string', required: true, description: '目标目录 ID（"0" 表示根目录）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, detail: { type: 'string', required: true } },
      },
      render: textRender,
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      await ensureAuthorized()
      const driveId = await resolveDriveId(args.fileToken)
      const dstDriveId = args.dstParentId === '0' ? driveId : await resolveDriveId(args.dstParentId)
      await cli.run('drive', 'move-file', {
        drive_id: driveId,
        file_ids: [args.fileToken],
        dst_drive_id: dstDriveId,
        dst_parent_id: args.dstParentId,
      })
      return { ok: true, detail: `已将 ${args.fileToken} 移动到 ${args.dstParentId}` }
    },
  })

  register({
    name: 'wps_delete_file',
    description:
      '把 WPS 云文档中的文件或文件夹删除。注意：当前 kdocs-cli 未暴露删除接口，本工具返回引导到 WPS 网页端操作。',
    parameters: {
      fileToken: { type: 'string', required: true, description: '文件/文件夹 ID' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, detail: { type: 'string', required: true } },
      },
      render: textRender,
    },
    isConcurrencySafe: () => false,
    async execute() {
      return {
        ok: false,
        detail: '当前版本暂不支持通过插件删除云文档（kdocs-cli 未暴露删除接口）。请登录 https://365.kdocs.cn 在网页端删除，或移入回收站。',
      }
    },
  })

  /* ---------------- 设置页路由（webServer） ---------------- */

  const webServer = ctx.webServer

  if (webServer) {
    ctx.effect(() => {
      const disposers = []
      const path = config.callbackPath || '/wps-oauth'
      const isLoopback = (req) => {
        const address = req.socket?.remoteAddress ?? ''
        return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
      }
      const writeJson = (res, status, obj) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(obj))
      }

      // 状态
      disposers.push(webServer.register({
        kind: 'exact',
        path: `${path}/status`,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const status = { authorized: false, nickname: null, openId: null, hasSid: auth.hasSid() }
          if (auth.hasSid()) {
            try {
              // 引擎探活：kdocs-cli 密钥链 token 可用即视为已登录（列文件/读取/搜索均可用）。
              // 下载验证仅用于优化（失败时尝试密钥链 sid 恢复），不作为判死刑依据。
              await cli.run('drive', 'list-my-files', { page_size: 1 }, { timeout: 20000 })
              // 引擎正常；若本地 sid 与密钥链 sid 不一致，顺手换成密钥链 sid（下载 URL 签名匹配）
              const kcSid = readKeychainSid()
              if (kcSid && kcSid !== auth.sid()) {
                auth.save({ sid: kcSid, savedAt: Date.now() })
              }
              await finalizeAuthorization()
              status.authorized = true
              status.nickname = auth.state.user || null
            } catch {
              // 引擎探活失败：尝试密钥链恢复，仍失败才报未登录
              try {
                if (await tryRestoreFromKeychain()) {
                  status.authorized = true
                  status.nickname = auth.state.user || null
                  status.hasSid = auth.hasSid()
                }
              } catch { /* ignore */ }
            }
          } else {
            // 本地无 sid：尝试从密钥链恢复
            try {
              if (await tryRestoreFromKeychain()) {
                status.authorized = true
                status.nickname = auth.state.user || null
                status.hasSid = auth.hasSid()
              }
            } catch { /* ignore */ }
          }
          writeJson(res, 200, status)
        },
      }))

      // 登录（触发受控浏览器弹窗）
      disposers.push(webServer.register({
        kind: 'exact',
        path: `${path}/login`,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const browser = findBrowser(config)
          if (!browser) return writeJson(res, 400, { error: '未找到浏览器，请在配置 browserPath 指定' })
          captureSidViaBrowser(browser, config)
            .then(({ sid, nickname }) => {
              if (sid) auth.save({ sid, savedAt: Date.now(), user: nickname || undefined })
            })
            .catch(() => {})
          writeJson(res, 200, { ok: true, message: '已打开 WPS 网页版登录窗口，请在弹出的浏览器中登录 WPS 账号' })
        },
      }))

      // 退出
      disposers.push(webServer.register({
        kind: 'exact',
        path: `${path}/logout`,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
          auth.clear()
          writeJson(res, 200, { ok: true })
        },
      }))

      // 文件浏览（输入框附件面板：列目录 / 进入子目录）
      disposers.push(webServer.register({
        kind: 'exact',
        path: `${path}/files`,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const url = new URL(req.url, 'http://localhost')
          const parentId = url.searchParams.get('parent') || '0'
          const pageToken = url.searchParams.get('page_token') || ''
          const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 100, 1), 300)
          try {
            await ensureAuthorized()
            let data
            if (parentId === '0' || parentId === '') {
              data = await cli.run('drive', 'list-my-files', {
                page_size: count,
                ...(pageToken ? { page_token: pageToken } : {}),
              })
            } else {
              const driveId = await resolveDriveId(parentId)
              data = await cli.run('drive', 'list-files', {
                drive_id: driveId,
                parent_id: parentId,
                page_size: count,
                ...(pageToken ? { page_token: pageToken } : {}),
              })
            }
            const items = (data.items || []).map(projectItem).map((f) => ({
              id: f.id,
              name: f.name,
              isFolder: f.isFolder,
              sizeText: f.sizeText,
              modifiedAt: f.modifiedAt,
              driveId: f.driveId || (data.drive_id || ''),
              parentId: f.parentId || parentId,
            }))
            items.sort((a, b) => (a.isFolder === b.isFolder ? 0 : a.isFolder ? -1 : 1))
            writeJson(res, 200, {
              ok: true,
              parent: parentId,
              items,
              nextPageToken: data.next_page_token || '',
              summary: `${items.length} 项`,
            })
          } catch (error) {
            writeJson(res, 200, { ok: false, error: error && error.message ? error.message : String(error) })
          }
        },
      }))

      // 文件搜索（输入框附件面板）
      disposers.push(webServer.register({
        kind: 'exact',
        path: `${path}/search`,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const url = new URL(req.url, 'http://localhost')
          const q = (url.searchParams.get('q') || '').trim()
          const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 50, 1), 200)
          if (!q) return writeJson(res, 200, { ok: true, items: [], nextPageToken: '', summary: '0 项' })
          try {
            await ensureAuthorized()
            const data = await cli.run('drive', 'search-files', { file_name: q, page_size: count })
            const items = (data.items || []).map(projectItem).map((f) => ({
              id: f.id,
              name: f.name,
              isFolder: f.isFolder,
              sizeText: f.sizeText,
              modifiedAt: f.modifiedAt,
              driveId: f.driveId || '',
              parentId: f.parentId || '',
            }))
            writeJson(res, 200, {
              ok: true,
              items,
              nextPageToken: data.next_page_token || '',
              summary: `${items.length} 项`,
            })
          } catch (error) {
            writeJson(res, 200, { ok: false, error: error && error.message ? error.message : String(error) })
          }
        },
      }))

      // 本地文件暂存上传（输入框附件面板：浏览器无法拿到本地绝对路径，
      // 由前端把文件内容 POST 到这里暂存到本机目录，再让 Agent 读取该路径）
      disposers.push(webServer.register({
        kind: 'exact',
        path: `${path}/upload-local`,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
          const url = new URL(req.url, 'http://localhost')
          const rawName = (url.searchParams.get('name') || 'upload.bin').slice(0, 200)
          try {
            const chunks = []
            let size = 0
            for await (const chunk of req) {
              size += chunk.length
              if (size > 100 * 1024 * 1024) throw new Error('文件过大（上限 100MB）')
              chunks.push(chunk)
            }
            const buf = Buffer.concat(chunks)
            const uploadsDir = join(dirname(auth.stateFile), 'wps-uploads')
            mkdirSync(uploadsDir, { recursive: true })
            const safeName = rawName.replace(/[\\/:*?"<>|\r\n]/g, '_')
            const dest = join(uploadsDir, `${Date.now()}-${safeName}`)
            writeFileSync(dest, buf)
            writeJson(res, 200, { ok: true, path: dest, name: safeName, size: buf.length })
          } catch (error) {
            writeJson(res, 200, { ok: false, error: error && error.message ? error.message : String(error) })
          }
        },
      }))

      // 云端文件下载暂存（输入框附件面板：云端文件作为附件 = 下载到本机暂存目录，
      // 与本地附件同目录，Agent 读取本地副本讨论；不上传回云端）
      disposers.push(webServer.register({
        kind: 'exact',
        path: `${path}/download-attachment`,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const url = new URL(req.url, 'http://localhost')
          const fileId = url.searchParams.get('file_id') || ''
          if (!fileId) return writeJson(res, 200, { ok: false, error: '缺少 file_id' })
          try {
            await ensureAuthorized()
            const info = await cli.run('drive', 'download-file', { file_id: fileId, with_hash: true })
            const dlUrl = info.url || info.download_url || info.downloadUrl || ''
            if (!dlUrl) throw new Error('未能获取下载地址')
            let fname = info.fname || info.name || ''
            if (!fname) {
              try {
                const meta = await cli.run('drive', 'get-file-info', { file_id: fileId })
                fname = meta.name || ''
              } catch { /* ignore */ }
            }
            if (!fname) fname = `${fileId}.bin`
            const safeName = fname.replace(/[\\/:*?"<>|\r\n]/g, '_')
            const uploadsDir = join(dirname(auth.stateFile), 'wps-uploads')
            mkdirSync(uploadsDir, { recursive: true })
            const dest = join(uploadsDir, `${Date.now()}-${safeName}`)
            // 下载失败（403 等）时用密钥链 sid 兑底重试：下载 URL 签名与 kdocs-cli 引擎
            //（密钥链 token）的会话绑定，本地保存的 sid 可能属于另一会话。
            let size = 0
            try {
              size = await downloadToFile(dlUrl, dest, '文件', auth.sid())
            } catch (dlError) {
              const kcSid = readKeychainSid()
              if (kcSid && kcSid !== auth.sid()) {
                size = await downloadToFile(dlUrl, dest, '文件', kcSid)
                // 密钥链 sid 下载成功：把它持久化，后续不再反复重试
                auth.save({ sid: kcSid, savedAt: Date.now() })
              } else {
                throw dlError
              }
            }
            writeJson(res, 200, { ok: true, path: dest, name: safeName, size })
          } catch (error) {
            const errMsg = error && error.message ? error.message : String(error)
            // 降级：.dbt（多维表格）/.otl（智能文档）等金山专有格式不支持 drive.download-file，
            // 改为 read-file 读取内容并暂存为 .md 文本附件，保证云端文件也能作为附件讨论。
            if (/不支持的文件类型|未能获取下载地址|unsupported|not support|Unsupported/i.test(errMsg)) {
              try {
                const readData = await cli.run('drive', 'read-file', { file_id: fileId }, { timeout: Math.max(config.timeoutMs, 120000) })
                let text = ''
                if (typeof readData === 'string') {
                  text = readData
                } else if (readData && typeof readData.content === 'string') {
                  text = readData.content
                } else if (readData && readData.content) {
                  text = typeof readData.content === 'string' ? readData.content : JSON.stringify(readData.content, null, 2)
                } else {
                  text = JSON.stringify(readData, null, 2)
                }
                if (text.length > 2000000) text = text.slice(0, 2000000) + '\n\n（内容过长，已截断）'
                let fname = ''
                try {
                  const meta = await cli.run('drive', 'get-file-info', { file_id: fileId })
                  fname = meta.name || ''
                } catch { /* ignore */ }
                const safeName = (fname || `${fileId}.md`).replace(/[\\/:*?"<>|\r\n]/g, '_')
                const mdName = safeName.replace(/\.(dbt|otl|ksheet|pof|pom|wps|txt)$/i, '') + '.md'
                const mdDir = join(dirname(auth.stateFile), 'wps-uploads')
                mkdirSync(mdDir, { recursive: true })
                const dest = join(mdDir, `${Date.now()}-${mdName}`)
                writeFileSync(dest, text, 'utf8')
                writeJson(res, 200, { ok: true, path: dest, name: mdName, size: Buffer.byteLength(text), downgraded: true })
              } catch (e2) {
                writeJson(res, 200, { ok: false, error: errMsg })
              }
            } else {
              writeJson(res, 200, { ok: false, error: errMsg })
            }
          }
        },
      }))

      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'wps-cloud: oauth routes')
  }

  /* ---------------- 系统提示 ---------------- */

  ctx.systemPrompt.section({
    name: 'tool:wps-cloud',
    order: 220,
    text: 'wps_* 工具用于连接 WPS 云文档（普通用户版）：首次使用先调用 wps_auth_status 检查登录状态；未登录时插件会自动弹出 WPS 网页版登录窗口（365.kdocs.cn），用户在浏览器中用 WPS 账号登录后插件自动完成绑定，无需复制任何内容。登录后即可列出、搜索、读取、下载、上传、创建、重命名云文档。',
  })
}
