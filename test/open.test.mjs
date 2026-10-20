/**
 * Opening a thread the way the page asked: the desktop app by default, or a terminal running
 * the harness's own CLI.
 *
 * `present` gets stubbed adapter answers for the branching. The two endpoints go through a real
 * socket once each, with a fake CLI and a fake terminal on disk, because only that proves `via`
 * makes it from the request body to the spawn.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { present, vscodeLinks } from '../server/api.mjs'
import { openThread as openHarnessThread } from '../server/scan.mjs'
import { withServer } from './support/with-server.mjs'
import { withEnv, withPlatform, fakeExecutable } from './support/env.mjs'

const posixOnly = { skip: process.platform === 'win32' }
const UUID = '2df3987c-02d3-405e-b8f5-da30e3835213'

// ── present, given what an adapter said ───────────────────────────────────────

test('asked for a terminal, present never opens the app instead', async () => {
  const noCommand = await present({ ok: true, url: 'claude://resume?session=x' }, 'terminal')
  assert.equal(noCommand.ok, false)
  assert.match(noCommand.error, /CLI/, 'a missing CLI is named, not papered over with the deep link')

  const noCwd = await present({ ok: true, url: '', command: { argv: ['/bin/true'], cwd: '' } }, 'terminal')
  assert.match(noCwd.error, /no folder on record/)

  const gone = { argv: ['/bin/true'], cwd: '/definitely/not/here' }
  assert.match((await present({ ok: true, url: '', command: gone }, 'terminal')).error, /not on this machine/)
})

test('asked for a terminal on Windows, present says so rather than trying', async () => {
  const command = { argv: ['/bin/true'], cwd: os.tmpdir() }
  const shown = await withPlatform('win32', () => present({ ok: true, url: '', command }, 'terminal'))
  assert.equal(shown.ok, false)
  assert.match(shown.error, /Windows/)
})

test("an adapter's own refusal passes through whatever the page asked for", async () => {
  assert.equal((await present({ ok: false, error: 'nope' }, 'terminal')).error, 'nope')
  assert.equal((await present({ ok: false, error: 'nope' }, 'app')).error, 'nope')
})

// ── the endpoints, against a real socket ──────────────────────────────────────

async function withFakes(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-open-'))
  try {
    const claude = await fakeExecutable(dir, 'claude')
    const kitty = await fakeExecutable(dir, 'kitty')
    const env = { PATH: dir, BOT_CROSSING_TERMINAL: kitty.file, DISPLAY: ':0' }
    return await withEnv(env, () => fn({ dir, claude, kitty }))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

const post = (call, p, body) => call(p, { method: 'POST', body: JSON.stringify(body) })

test('/api/open with via: terminal resumes the session in its own folder', posixOnly, async () => {
  await withFakes(({ dir, claude, kitty }) =>
    withServer(async ({ call }) => {
      const ref = { cliSessionId: UUID, cwd: dir }
      const res = await post(call, '/api/open', { harness: 'claude-code', ref, via: 'terminal' })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { ok: true, via: 'terminal' }, 'the page is told a terminal opened')
      assert.deepEqual(await kitty.argv(), [`--directory=${dir}`, claude.file, '--resume', UUID])
    })
  )
})

test('/api/open with via: terminal and no CLI is a 400 that names the CLI', posixOnly, async () => {
  // Codex rather than Claude Code: this machine may well have a real `claude` in an install dir.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-nocli-'))
  try {
    await withEnv({ PATH: dir }, () =>
      withServer(async ({ call }) => {
        const body = { harness: 'codex', ref: { sessionId: UUID, cwd: dir }, via: 'terminal' }
        const res = await post(call, '/api/open', body)
        assert.equal(res.status, 400)
        assert.match((await res.json()).error, /CLI/)
      })
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('/api/new-session with via: terminal starts the bare CLI in that folder', posixOnly, async () => {
  await withFakes(({ dir, claude, kitty }) =>
    withServer(async ({ call }) => {
      await post(call, '/api/new-session', { harness: 'claude-code', folder: dir, via: 'terminal' })
      assert.deepEqual(await kitty.argv(), [`--directory=${dir}`, claude.file])
    })
  )
})

// ── VS Code ───────────────────────────────────────────────────────────────────

test('a VS Code offer opens the folder first, then the extension link', async () => {
  const dir = os.tmpdir()
  const url = `vscode://anthropic.claude-code/open?session=${UUID}`
  assert.deepEqual(vscodeLinks({ folder: '/work/my repo', url }), ['vscode://file//work/my%20repo', url])
  assert.deepEqual(vscodeLinks({ folder: dir }), [`vscode://file/${encodeURI(dir)}`])
  assert.deepEqual(vscodeLinks({ folder: 'relative', url: 'claude://resume' }), [], 'only absolute folders and vscode:// links')
  assert.deepEqual(vscodeLinks(undefined), [])
})

test('the Claude Code and Codex adapters offer VS Code the thread’s own folder', async () => {
  const dir = os.tmpdir()
  const claude = await openHarnessThread('claude-code', { cliSessionId: UUID, cwd: dir })
  assert.deepEqual(claude.vscode, { folder: dir, url: `vscode://anthropic.claude-code/open?session=${UUID}` })
  const desktopOnly = await openHarnessThread('claude-code', { desktopSessionId: 'local_abc', cwd: dir })
  assert.equal(desktopOnly.vscode, undefined, 'no transcript, nothing for the extension to resume')

  const codex = await openHarnessThread('codex', { sessionId: UUID, cwd: dir })
  assert.equal(codex.vscode.folder, dir)
  assert.equal(codex.vscode.url, undefined)
})

/** Linux plumbing that answers `vscode:` and keeps every URL it is handed, in order. */
async function withVsCodeOnLinux(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-vscode-'))
  try {
    const log = path.join(dir, 'opened')
    await fsp.writeFile(path.join(dir, 'xdg-mime'), '#!/bin/sh\necho code-url-handler.desktop\n', { mode: 0o755 })
    await fsp.writeFile(path.join(dir, 'xdg-open'), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\n`, { mode: 0o755 })
    const opened = async () => (await fsp.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    return await withEnv({ PATH: dir }, () => withPlatform('linux', () => fn({ dir, opened })))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

test('/api/open with via: vscode opens the repo, then the session in the extension', posixOnly, async () => {
  await withVsCodeOnLinux(({ dir, opened }) =>
    withServer(async ({ call }) => {
      const ref = { cliSessionId: UUID, cwd: dir }
      const res = await post(call, '/api/open', { harness: 'claude-code', ref, via: 'vscode' })
      assert.equal(res.status, 200)
      assert.equal((await res.json()).via, 'vscode')
      await new Promise((r) => setTimeout(r, 1800))
      assert.deepEqual(await opened(), [
        `vscode://file/${encodeURI(dir)}`,
        `vscode://anthropic.claude-code/open?session=${UUID}`,
      ])
    })
  )
})

test('asked for VS Code with no route there, present falls back to the app', async () => {
  // A harness with no VS Code offer at all, on a Linux box where nothing answers its own scheme
  // either: the error is the app route's, which proves the fallback was taken.
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-novscode-'))
  try {
    const shown = await withEnv({ PATH: empty }, () =>
      withPlatform('linux', () => present({ ok: true, url: 'antigravity://resume?session=x' }, 'vscode'))
    )
    assert.equal(shown.ok, false)
    assert.match(shown.error, /antigravity:\/\//)
  } finally {
    await fsp.rm(empty, { recursive: true, force: true })
  }
})
