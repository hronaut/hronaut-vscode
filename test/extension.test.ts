import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const connection = require('../connection.js') as {
  DEFAULT_MCP_PORT: number
  PROFILE_FOLDER: string
  profileDirectory(environment?: Record<string, string | undefined>, platform?: string, home?: string): string
  mcpPort(configured: unknown, environment?: Record<string, string | undefined>): number
  mcpEndpoint(port: unknown): string
  ownerToken(environment?: Record<string, string | undefined>, profile?: string): Promise<string | undefined>
}
const extension = require('../extension.js') as {
  activate(context: { extension: { packageJSON: { version: string } }; subscriptions: Array<{ dispose(): void }> }, vscode: unknown): void
  createProvider(vscode: unknown, version: string, readToken?: () => Promise<string | undefined>, environment?: Record<string, string | undefined>): {
    provider: {
      onDidChangeMcpServerDefinitions: (listener: () => void) => void
      provideMcpServerDefinitions(): Array<{ label: string; uri: string; headers: Record<string, string>; version: string }>
      resolveMcpServerDefinition(server: { headers: Record<string, string> }): Promise<{ headers: Record<string, string> }>
    }
    dispose(): void
  }
}

const STORE_DESCRIPTION = 'Connects your coding agent to Hronaut — a visible desktop browser it can drive over MCP. '
  + 'Watch every step, pause and take over, keep logins between sessions. Requires the Hronaut app (free 10-day trial at hronaut.dev).'
const TOKEN = 'b'.repeat(24) + '-_C7'.repeat(4)

/** A checkout of the Hronaut app, whose port, profile folder and terms the extension follows. */
const APP = process.env.HRONAUT_APP_DIR ?? '../hronaut'

async function appFile(path: string): Promise<string> {
  try {
    return await readFile(join(APP, path), 'utf8')
  } catch (error) {
    throw new Error(`The tests compare the extension with ${path} of hronaut/hronaut, checked out at ${APP}. `
      + 'Clone it there or set HRONAUT_APP_DIR to its folder.', { cause: error })
  }
}

/** The app's default and lowest MCP ports. */
async function appPorts(): Promise<{ DEFAULT_MCP_PORT: number; MIN_MCP_PORT: number }> {
  const source = await appFile('src/shared/mcp-port.ts')
  const constant = (name: string) => {
    const value = source.match(new RegExp(`^export const ${name} = ([\\d_]+)$`, 'm'))?.[1]
    if (!value) throw new Error(`${name} was not found in the app's src/shared/mcp-port.ts`)
    return Number(value.replaceAll('_', ''))
  }
  return { DEFAULT_MCP_PORT: constant('DEFAULT_MCP_PORT'), MIN_MCP_PORT: constant('MIN_MCP_PORT') }
}

interface ExtensionManifest {
  version: string
  license: string
  description: string
  engines: { vscode: string }
  extensionKind: string[]
  main: string
  files: string[]
  icon: string
  pricing: string
  contributes: {
    mcpServerDefinitionProviders: Array<{ id: string; label: string }>
    configuration: { properties: Record<string, { default: unknown; minimum: number; scope: string; ignoreSync: boolean }> }
  }
}

/**
 * The parts of the editor's `vscode` API the extension uses, recording what it was given. `port` is set in the user's
 * settings and `workspacePort` in a workspace's or folder's.
 */
function fakeEditor(port: unknown, workspacePort?: unknown) {
  const listeners: Array<(event: { affectsConfiguration(section: string): boolean }) => void> = []
  class EventEmitter {
    listeners: Array<() => void> = []
    disposed = false
    event = (listener: () => void) => { this.listeners.push(listener) }
    fire() { for (const listener of this.listeners) listener() }
    dispose() { this.disposed = true }
  }
  const editor = {
    EventEmitter,
    Uri: { parse: (value: string) => `uri:${value}` },
    McpHttpServerDefinition: class {
      constructor(public label: string, public uri: string, public headers: Record<string, string>, public version: string) {}
    },
    workspace: {
      // The setting's default is not a value set anywhere.
      getConfiguration: (section: string) => ({
        inspect: (key: string) => (section === 'hronaut' && key === 'mcpPort'
          ? { defaultValue: 47812, globalValue: port, workspaceValue: workspacePort, workspaceFolderValue: workspacePort }
          : undefined)
      }),
      onDidChangeConfiguration: (listener: (typeof listeners)[number]) => {
        listeners.push(listener)
        return { dispose: () => { listeners.length = 0 } }
      }
    },
    setPort: (next: unknown) => { port = next },
    changeSettings: (section: string) => { for (const listener of [...listeners]) listener({ affectsConfiguration: (name) => name === section }) },
    settingsListeners: listeners
  }
  return editor
}

describe('the VS Code extension', () => {
  it('registers the MCP server provider it declares, under the store description, from the local machine', async () => {
    const { DEFAULT_MCP_PORT, MIN_MCP_PORT } = await appPorts()
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as ExtensionManifest
    expect(manifest.description).toBe(STORE_DESCRIPTION)
    expect(manifest.contributes.mcpServerDefinitionProviders).toEqual([{ id: 'hronaut', label: 'Hronaut' }])
    expect(await readFile('extension.js', 'utf8')).toContain("const PROVIDER_ID = 'hronaut'")
    // The MCP server provider API is final from VS Code 1.101.
    expect(manifest.engines.vscode).toBe('^1.101.0')
    // Hronaut and its token file are on the person's computer, not on a remote host the editor is connected to.
    expect(manifest.extensionKind).toEqual(['ui'])
    expect(manifest.contributes.configuration.properties['hronaut.mcpPort']).toMatchObject({ default: DEFAULT_MCP_PORT, minimum: MIN_MCP_PORT })
    // The token goes to this port, so only this computer's user settings choose it: not a workspace's, nor a remote
    // host's or a dev container's, which a machine scope would read in a remote window, nor another computer's synced ones.
    expect(manifest.contributes.configuration.properties['hronaut.mcpPort']).toMatchObject({ scope: 'application', ignoreSync: true })
    // Hronaut needs a subscription after its trial.
    expect(manifest.pricing).toBe('Trial')
    expect(connection.DEFAULT_MCP_PORT).toBe(DEFAULT_MCP_PORT)
    for (const file of [manifest.main, manifest.icon, ...manifest.files]) await expect(stat(file)).resolves.toBeTruthy()
  })

  it('is MIT-licensed, unlike the Hronaut app, and has a changelog entry for its version', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as ExtensionManifest
    expect(await readFile('LICENSE.md', 'utf8')).toMatch(/^MIT License\r?\n\r?\nCopyright \(c\) 2026 Hronaut\r?\n/)
    expect(manifest.license).toBe('MIT')
    // The stores show the changelog, and the Publish workflow takes the release notes from it.
    expect(await readFile('CHANGELOG.md', 'utf8')).toMatch(new RegExp(`^## ${manifest.version.replaceAll('.', '\\.')}$`, 'm'))
  })

  it('states its own license and Hronaut’s current terms on its store page', async () => {
    const readme = await readFile('README.md', 'utf8')
    const { subscription } = JSON.parse(await appFile('docs/PUBLIC_FACTS.json')) as {
      subscription: { trialDays: number; monthlyPerNamedUser: number; annualPerNamedUser: number; annualReferenceTotal: number; annualSavingsPercent: number }
    }
    expect(readme).toContain('open source under the [MIT License](LICENSE.md)')
    expect(readme).toContain('source-available under the [Subscription and Trial License](https://github.com/hronaut/hronaut/blob/main/LICENSE)')
    expect(readme).toContain(`The ${subscription.trialDays}-day trial`)
    expect(readme).toContain(`$${subscription.monthlyPerNamedUser}/month or $${subscription.annualPerNamedUser}/year per named user `
      + `(${subscription.annualSavingsPercent}% off $${subscription.annualReferenceTotal})`)
  })

  it('offers Hronaut’s local endpoint on the configured port and adds the owner token when the editor starts it', async () => {
    const editor = fakeEditor(48123)
    const readToken = vi.fn(async (): Promise<string | undefined> => TOKEN)
    const { provider } = extension.createProvider(editor, '3.7.0', readToken, {})
    const [server, ...others] = provider.provideMcpServerDefinitions()
    expect(others).toEqual([])
    expect(server).toMatchObject({ label: 'Hronaut', uri: 'uri:http://127.0.0.1:48123/mcp', headers: {}, version: '3.7.0' })
    // The token is read only when the editor starts the server, so it is the one Hronaut uses then.
    expect(readToken).not.toHaveBeenCalled()
    expect((await provider.resolveMcpServerDefinition(server!)).headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
    // The editor passes the same definition on the next start, when the token may be gone.
    readToken.mockResolvedValue(undefined)
    expect((await provider.resolveMcpServerDefinition(server!)).headers).toEqual({})
  })

  it('registers its provider when the editor starts it, and only where the editor can take MCP servers', () => {
    const editor = { ...fakeEditor(undefined), lm: { registerMcpServerDefinitionProvider: vi.fn(() => ({ dispose: vi.fn() })) }, window: { showWarningMessage: vi.fn() } }
    const context = { extension: { packageJSON: { version: '3.7.0' } }, subscriptions: [] as Array<{ dispose(): void }> }
    extension.activate(context, editor)
    expect(editor.lm.registerMcpServerDefinitionProvider).toHaveBeenCalledExactlyOnceWith('hronaut', expect.objectContaining({
      provideMcpServerDefinitions: expect.any(Function), resolveMcpServerDefinition: expect.any(Function)
    }))
    expect(context.subscriptions).toHaveLength(2)
    for (const subscription of context.subscriptions) subscription.dispose()
    expect(editor.settingsListeners).toEqual([])
    expect(editor.window.showWarningMessage).not.toHaveBeenCalled()

    const without = { ...fakeEditor(undefined), window: { showWarningMessage: vi.fn(() => Promise.resolve(undefined)) } }
    const bare = { extension: { packageJSON: { version: '3.7.0' } }, subscriptions: [] as Array<{ dispose(): void }> }
    extension.activate(bare, without)
    expect(without.window.showWarningMessage).toHaveBeenCalledExactlyOnceWith('This editor does not let extensions add MCP servers. Add Hronaut from Hronaut Home instead.')
    expect(bare.subscriptions).toEqual([])
    expect(without.settingsListeners).toEqual([])
  })

  it('starts the server without a header while there is no token, and offers it again when the port setting changes', async () => {
    const { DEFAULT_MCP_PORT } = await appPorts()
    const editor = fakeEditor(undefined)
    const { provider, dispose } = extension.createProvider(editor, '3.7.0', async () => undefined, {})
    const [server] = provider.provideMcpServerDefinitions()
    expect(server?.uri).toBe(`uri:http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`)
    expect((await provider.resolveMcpServerDefinition(server!)).headers).toEqual({})

    const changed = vi.fn()
    provider.onDidChangeMcpServerDefinitions(changed)
    editor.changeSettings('editor.fontSize')
    expect(changed).not.toHaveBeenCalled()
    editor.setPort(47999)
    editor.changeSettings('hronaut.mcpPort')
    expect(changed).toHaveBeenCalledOnce()
    expect(provider.provideMcpServerDefinitions()[0]?.uri).toBe('uri:http://127.0.0.1:47999/mcp')
    dispose()
    expect(editor.settingsListeners).toEqual([])
  })

  it('takes the port from the user’s settings only, after HRONAUT_MCP_PORT as Hronaut does', async () => {
    const { DEFAULT_MCP_PORT } = await appPorts()
    const uri = (editor: ReturnType<typeof fakeEditor>, environment: Record<string, string | undefined>) =>
      extension.createProvider(editor, '3.7.0', async () => undefined, environment).provider.provideMcpServerDefinitions()[0]?.uri
    // A repository's settings cannot send the token to another port.
    expect(uri(fakeEditor(undefined, 3000), {})).toBe(`uri:http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`)
    expect(uri(fakeEditor(undefined), { HRONAUT_MCP_PORT: '48500' })).toBe('uri:http://127.0.0.1:48500/mcp')
    expect(uri(fakeEditor(48001), { HRONAUT_MCP_PORT: '48500' })).toBe('uri:http://127.0.0.1:48500/mcp')
    expect(uri(fakeEditor(48001), { HRONAUT_MCP_PORT: '80' })).toBe('uri:http://127.0.0.1:48001/mcp')
  })
})

describe('where the VS Code extension finds Hronaut', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hronaut-vscode-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('looks in the profile folder Electron gives Hronaut on each system, or the one HRONAUT_USER_DATA_DIR names', async () => {
    // Electron names the folder after the packaged app's productName, or its name, which is lowercase.
    const app = JSON.parse(await appFile('package.json')) as { name: string; productName?: string }
    const folder = app.productName ?? app.name
    expect(connection.PROFILE_FOLDER).toBe(folder)
    // electron-builder writes only extraMetadata into the packaged package.json, never its own productName.
    expect(await appFile('electron-builder.yml')).not.toMatch(/^extraMetadata:/m)
    expect(connection.profileDirectory({}, 'linux', '/home/person')).toBe(`/home/person/.config/${folder}`)
    expect(connection.profileDirectory({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/person')).toBe(`/xdg/${folder}`)
    expect(connection.profileDirectory({}, 'darwin', '/Users/person')).toBe(`/Users/person/Library/Application Support/${folder}`)
    expect(connection.profileDirectory({ APPDATA: 'C:\\Users\\person\\AppData\\Roaming' }, 'win32', 'C:\\Users\\person'))
      .toBe(`C:\\Users\\person\\AppData\\Roaming\\${folder}`)
    expect(connection.profileDirectory({ HRONAUT_USER_DATA_DIR: '/profiles/client-a' }, 'darwin', '/Users/person')).toBe('/profiles/client-a')
  })

  it('connects to the port HRONAUT_MCP_PORT names, else the one set in the editor, else the default', async () => {
    const { DEFAULT_MCP_PORT } = await appPorts()
    expect(connection.mcpEndpoint(48000)).toBe('http://127.0.0.1:48000/mcp')
    for (const port of [undefined, 0, 1023, 65536, 1.5, '48000']) expect(connection.mcpEndpoint(port)).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`)
    expect(connection.mcpPort(48001, { HRONAUT_MCP_PORT: '48002' })).toBe(48002)
    expect(connection.mcpPort(48001, { HRONAUT_MCP_PORT: '80' })).toBe(48001)
    expect(connection.mcpPort(undefined, { HRONAUT_MCP_PORT: '48002' })).toBe(48002)
    for (const variable of ['', '80', '48002x', '1@other.example:80']) expect(connection.mcpPort(undefined, { HRONAUT_MCP_PORT: variable })).toBe(DEFAULT_MCP_PORT)
    expect(connection.mcpPort(undefined, {})).toBe(DEFAULT_MCP_PORT)
  })

  it('reads the owner token from HRONAUT_MCP_TOKEN first, as Hronaut does, then from the profile, and never a malformed one', async () => {
    await mkdir(join(home, 'profile'))
    await writeFile(join(home, 'profile', 'mcp-token'), `${TOKEN}\r\n`, { mode: 0o600 })
    expect(await connection.ownerToken({}, join(home, 'profile'))).toBe(TOKEN)
    expect(await connection.ownerToken({ HRONAUT_MCP_TOKEN: `${TOKEN}env` }, join(home, 'profile'))).toBe(`${TOKEN}env`)
    expect(await connection.ownerToken({ HRONAUT_MCP_TOKEN: 'short' }, join(home, 'profile'))).toBeUndefined()
    expect(await connection.ownerToken({}, join(home, 'missing'))).toBeUndefined()
    await writeFile(join(home, 'profile', 'mcp-token'), `${TOKEN}"}\n`)
    expect(await connection.ownerToken({}, join(home, 'profile'))).toBeUndefined()
  })
})
