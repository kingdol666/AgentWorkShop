import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

test('template manager forwards the selected mode and defaults to generic', async () => {
  const { ManagerChannelTemplates } = await import('../server/services/workshop/runtime/manager/channel-templates')
  const calls: Array<Record<string, unknown>> = []
  const manager = Object.create(ManagerChannelTemplates.prototype) as {
    deps: unknown
    requireTemplateReadable: () => void
    createChannel: (input: Record<string, unknown>) => Promise<{ channelId: string, workspace: string }>
    instantiateChannelTemplate: (templateId: string, user: { id: string, role: string }, name?: string, options?: { channelMode: 'generic' | 'production_line_integrated' }) => Promise<unknown>
  }
  manager.deps = { repos: { channelTemplates: { findById: () => ({ id: 'ordinary', name: 'Template', description: '', scenarioPrompt: '', workspace: '', leadJson: '', membersJson: '[]' }) } } }
  manager.requireTemplateReadable = () => undefined
  manager.createChannel = async (input: Record<string, unknown>) => {
    calls.push(input)
    return { channelId: 'channel', workspace: '' }
  }
  const user = { id: 'owner', role: 'user' }
  await manager.instantiateChannelTemplate('ordinary', user)
  await manager.instantiateChannelTemplate('ordinary', user, undefined, { channelMode: 'production_line_integrated' })
  await manager.instantiateChannelTemplate('ordinary', user, undefined, { channelMode: 'generic' })
  assert.deepEqual(calls.map(call => call.channelMode), ['generic', 'production_line_integrated', 'generic'])
})

test('instantiate API validates and forwards mode independently of line binding', () => {
  const api = read('server/api/workshop/channel-templates/[id]/instantiate.post.ts')
  assert.match(api, /channelMode:\s*z\.enum\(\['generic',\s*'production_line_integrated'\]\)\.optional\(\)/)
  assert.match(api, /instantiateChannelTemplate\(templateId, user, body\.name,\s*\{[^}]*channelMode:\s*body\.channelMode/s)
  assert.match(api, /if \(body\.bindLineId\)\s*\{\s*await manager\.bindChannelLine/)
})

test('every template opens a mode selection and preserves the knowledge base option', () => {
  const page = read('app/pages/workshop/channel-templates.vue')
  const api = read('app/composables/workshop/useWorkshopApi.ts')
  assert.match(api, /instantiateChannelTemplate:\s*\(id: string, name\?: string, options\?: \{[^}]*channelMode\?: ChannelMode/)
  assert.match(page, /const instMode = ref<ChannelMode>\('generic'\)/)
  assert.match(page, /const openInstantiate = \(t: ChannelTemplateDto\): void => \{[^}]*instMode\.value = 'generic'[^}]*instOpen\.value = true/s)
  assert.doesNotMatch(page, /if \(!t\.knowledgeBaseCapable\)\s*\{\s*void confirmInstantiate/)
  assert.match(page, /channelMode:\s*instMode\.value/)
  assert.match(page, /v-model:value="instMode"/)
  assert.match(page, /value="generic"/)
  assert.match(page, /value="production_line_integrated"/)
  assert.match(page, /v-if="instTarget\?\.knowledgeBaseCapable"/)
  assert.match(page, /enableKnowledgeBase:\s*instKb\.value/)
})
