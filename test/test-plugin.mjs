// 端到端 mock 测试：加载插件 apply()，验证工具注册 + 真实执行（模拟已登录）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(__dirname, '..')

// 加载 dsh-tools（用 junction / 直接路径均可）
const dshToolsPath = 'C:/Users/Lenovo/.npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const { defineTool } = await import('file:///' + dshToolsPath.replace(/\\/g, '/'))

const { apply } = await import('file:///' + join(pluginRoot, 'lib', 'index.js').replace(/\\/g, '/'))

const tools = []
const ctx = {
  tools: { register: (t) => tools.push(t) },
  systemPrompt: { section: () => {} },
  get: () => null,
  effect: () => {},
}

const stateDir = mkdtempSync(join(tmpdir(), 'wps-cloud-test-'))
const config = {
  autoOpenLogin: false,
  openLoginOnUnauthorized: false,
  loginTimeoutMs: 20000,
  timeoutMs: 30000,
  stateFile: join(stateDir, 'auth.json'),
  cliPath: join(__dirname, '..', '..', 'tools', 'kdocs-cli.exe'),
  sid: process.env.WPS_SID || '',
}

apply(ctx, config)
console.log('注册工具数:', tools.length)
console.log('工具列表:', tools.map((t) => t.name).join(', '))

const t = async (label, name, args) => {
  const tool = tools.find((x) => x.name === name)
  if (!tool) return console.log(`❌ ${label}: 工具 ${name} 未注册`)
  try {
    const value = await tool.execute(args || {}, {})
    console.log(`✅ ${label}`)
    return value
  } catch (e) {
    console.log(`❌ ${label}: ${e.message}`)
    return null
  }
}

const list = await t('wps_auth_status', 'wps_auth_status', {})
if (list) console.log('   ->', list.summary.split('\n').slice(0, 3).join(' | '))

const listFiles = await t('wps_list_files（根目录）', 'wps_list_files', { count: 5 })
if (listFiles) console.log('   ->', listFiles.summary.split('\n').slice(0, 3).join('\n      '))

const recent = await t('wps_recent_files', 'wps_recent_files', { count: 3 })
if (recent) console.log('   ->', recent.summary.split('\n').slice(0, 2).join(' | '))

const search = await t('wps_search_files（搜索人工智能）', 'wps_search_files', { fileName: '人工智能', count: 3 })
if (search) console.log('   ->', search.summary.split('\n').slice(0, 2).join(' | '))

// 读取一个真实小文件（pdf）
const readDoc = await t('wps_read_document（读取pdf）', 'wps_read_document', { fileToken: '8ZYo5RxRKxMT6DghhPR1BxhVkpSsmn6sL' })
if (readDoc) console.log('   -> fname:', readDoc.fname, '| 内容长度:', readDoc.charCount)

// 下载一个真实文件
const dl = await t('wps_download_file', 'wps_download_file', { fileToken: '8ZYo5RxRKxMT6DghhPR1BxhVkpSsmn6sL' })
if (dl) console.log('   -> 保存到:', dl.savedPath, '|', dl.sizeText)

console.log('\n测试状态文件:', join(stateDir, 'auth.json'))
