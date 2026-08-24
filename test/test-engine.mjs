// 引擎层冒烟测试 v2：与插件相同的「递归解包 + 嵌套 file 投影」逻辑。
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', '..', 'tools', 'kdocs-cli.exe')

function parseOutput(text, label) {
  let json = JSON.parse(text)
  if (json.code !== 0) throw new Error(`${label} code=${json.code}: ${json.message || json.msg}`)
  let data = json.data
  while (data && typeof data === 'object' && typeof data.code === 'number' && data.code === 0 && data.data !== undefined) {
    data = data.data
  }
  if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`${label} 内层 code=${data.code}: ${data.message || data.msg}`)
  }
  return data
}

function run(service, action, params = {}, { timeout = 30000 } = {}) {
  const args = [service, action, JSON.stringify(params || {}), '--compact']
  const env = { ...process.env, TMP_LX_UUID: '' }
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} ; reject(new Error('timeout')) }, timeout)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && !stdout) return reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`))
      try { resolve(parseOutput(stdout, `${service}.${action}`)) } catch (e) { reject(e) }
    })
  })
}

function projectItem(item) {
  const file = item && typeof item === 'object' && item.file && typeof item.file === 'object' ? item.file : item
  if (!file || typeof file !== 'object') return null
  return {
    name: file.name ?? '',
    sizeText: typeof file.size === 'number' ? (file.size < 1024 ? `${file.size} B` : `${(file.size / 1024 / 1024).toFixed(1)} MB`) : '',
    isFolder: file.type === 'folder' || file.type === 'dir' || file.type === 'shortcut',
    id: file.id ?? '',
    driveId: file.drive_id ?? '',
    parentId: file.parent_id ?? '',
    mtime: file.mtime ?? null,
  }
}

const t = (label, fn) =>
  fn().then((d) => console.log(`✅ ${label}`), (e) => console.log(`❌ ${label}: ${e.message}`))

await t('list-my-files（根目录）', async () => {
  const d = await run('drive', 'list-my-files', { page_size: 5 })
  console.log('   drive_id:', d.drive_id, '| items:', (d.items || []).length)
  for (const it of (d.items || []).slice(0, 5)) {
    const f = projectItem(it)
    console.log('   -', f.name, '|', f.isFolder ? 'folder' : 'file', '|', f.id)
  }
})

await t('get-file-info', async () => {
  const d = await run('drive', 'get-file-info', { file_id: 'eScsHsverrMK772aM53jrx1kL35rWDPcJ', with_drive: true })
  const f = projectItem(d)
  console.log('   name:', f.name, '| drive_id:', f.driveId, '| type:', f.isFolder ? 'folder' : 'file')
})

await t('list-latest-items（最近）', async () => {
  const d = await run('drive', 'list-latest-items', { page_size: 3 })
  const items = (d.items || []).map(projectItem).filter(Boolean)
  console.log('   items:', items.length)
  for (const f of items.slice(0, 3)) console.log('   -', f.name, '|', f.isFolder ? 'folder' : 'file', '|', f.id)
})

await t('search-files（搜索“人工智能”）', async () => {
  const d = await run('drive', 'search-files', { keyword: '人工智能', type: 'file_name', page_size: 3 })
  const items = (d.items || []).map(projectItem).filter(Boolean)
  console.log('   items:', items.length)
  for (const f of items.slice(0, 3)) console.log('   -', f.name, '|', f.id)
})

await t('read-file（读取真实文件）', async () => {
  const list = await run('drive', 'list-my-files', { page_size: 50 })
  const folder = (list.items || []).map(projectItem).find((i) => i.isFolder)
  // 进入第一个文件夹找真实文件
  let file = (list.items || []).map(projectItem).find((i) => !i.isFolder)
  if (!file && folder) {
    const sub = await run('drive', 'list-files', { drive_id: list.drive_id, parent_id: folder.id, page_size: 50 })
    file = (sub.items || []).map(projectItem).find((i) => !i.isFolder)
  }
  if (!file) return console.log('   （未找到文件，跳过）')
  console.log('   测试文件:', file.name, '|', file.id)
  const d = await run('drive', 'read-file', { file_id: file.id }, { timeout: 60000 })
  const txt = typeof d === 'string' ? d : (d.content ?? d.markdown ?? d.text ?? '')
  console.log('   返回类型:', typeof d, '| 内容长度:', String(txt).length)
  console.log('   内容前150字:', String(txt).slice(0, 150).replace(/\n/g, ' '))
})
