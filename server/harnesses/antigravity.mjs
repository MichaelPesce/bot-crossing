/**
 * Harness adapter: Antigravity (Google).
 *
 * Antigravity IDE / Desktop (2.0) stores sessions under `~/.gemini/antigravity/brain/<sessionId>/`
 * and Antigravity CLI stores sessions under `~/.gemini/antigravity-cli/brain/<sessionId>/`.
 * Transcripts are JSONL files located at `.system_generated/logs/transcript.jsonl`
 * or `transcript.jsonl` inside the session directory.
 *
 * Read-only, no subprocess, and no modifications to harness files.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, jsonLines, listDirs, readHead, readTail, findExecutable } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const OVERRIDE_HOME = process.env.BOT_CROSSING_ANTIGRAVITY_HOME || process.env.ANTIGRAVITY_HOME || ''
const ANTIGRAVITY_HOME = OVERRIDE_HOME || path.join(HOME, '.gemini', 'antigravity')
const CLI_HOME = path.join(HOME, '.gemini', 'antigravity-cli')
const BRAIN_DIR = path.join(ANTIGRAVITY_HOME, 'brain')
const BRAIN_DIRS = OVERRIDE_HOME
  ? [{ dir: path.join(OVERRIDE_HOME, 'brain'), source: 'cli' }]
  : [
      { dir: path.join(ANTIGRAVITY_HOME, 'brain'), source: 'desktop' },
      { dir: path.join(CLI_HOME, 'brain'), source: 'cli' },
    ]

const HEAD_BYTES = 96 * 1024
const TAIL_BYTES = 32 * 1024
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `antigravity:${raw}`

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (typeof p === 'string' ? p : p?.text || p?.input_text || ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Tool call argument values in `transcript.jsonl` are often JSON-encoded strings
 * (e.g. `"\"/Users/me/repo\""` or `"[{\"Role\":\"...\"}]"`). Unwrap one layer when needed.
 */
function unwrapArg(v) {
  if (typeof v !== 'string') return v
  const trimmed = v.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      /* keep raw string */
    }
  }
  return v
}

/** Ignore paths inside ~/.gemini (such as brain/ artifacts or built-in skills) when inferring repo cwd. */
function isWorkspacePath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false
  const norm = path.normalize(p)
  const geminiDir = path.join(HOME, '.gemini') + path.sep
  if (norm.startsWith(geminiDir)) return false
  if (OVERRIDE_HOME && norm.startsWith(path.normalize(OVERRIDE_HOME) + path.sep)) return false
  return true
}

/** Extract user query text from prompt/input record. */
function userText(record) {
  const raw = contentText(record?.content || record?.message?.content || '')
  const query = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw)
  const text = query ? query[1] : raw.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/gi, ' ')
  return clean(text)
}

/** Try to extract workspace/cwd from prompt user_information tags if present. */
function extractCwd(text) {
  if (!text) return ''
  const legacy = /active workspaces, each defined by a URI[\s\S]*?\[(.*?)\]\s*->/i.exec(text)
  if (legacy && isWorkspacePath(legacy[1])) return legacy[1].trim()

  const cmdDir = /Command Working Directory:\s*([^\r\n<]+)/i.exec(text)
  if (cmdDir && isWorkspacePath(cmdDir[1].trim())) return cmdDir[1].trim()

  const activeWs = /Active Workspaces:\s*(?:\r?\n)+\s*-\s*([^\r\n<]+)/i.exec(text)
  if (activeWs && isWorkspacePath(activeWs[1].trim())) return activeWs[1].trim()

  return ''
}

/** Extract model and effort from `<USER_SETTINGS_CHANGE>` if present. */
function extractModelSettings(text) {
  if (!text) return null
  const m = /Model Selection`?\s+from\s*.*?to\s+([^.\r\n(]+?)(?:\s*\(([^)]+)\))?\s*\./i.exec(text)
  if (!m) return null
  return {
    model: clean(m[1]),
    effort: m[2] ? clean(m[2]).toLowerCase() : '',
  }
}

const gitRootCache = new Map()
async function findGitRoot(startDir) {
  if (gitRootCache.has(startDir)) return gitRootCache.get(startDir)
  let cur = startDir
  const stop = path.parse(cur).root
  while (cur && cur !== stop && cur !== HOME) {
    if (await exists(path.join(cur, '.git'))) {
      gitRootCache.set(startDir, cur)
      return cur
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  gitRootCache.set(startDir, '')
  return ''
}

function commonDirPrefix(dirs) {
  if (!dirs.length) return ''
  const split = dirs.map((d) => path.normalize(d).split(path.sep))
  const first = split[0]
  let len = first.length
  for (let i = 1; i < split.length; i++) {
    len = Math.min(len, split[i].length)
    for (let j = 0; j < len; j++) {
      if (split[i][j] !== first[j]) {
        len = j
        break
      }
    }
  }
  const joined = first.slice(0, len).join(path.sep)
  return joined && joined !== path.sep && joined !== HOME ? joined : dirs[0]
}

async function inferWorkspaceFromFiles(files) {
  const dirs = [...new Set(files.map((f) => path.dirname(path.normalize(f))).filter(isWorkspacePath))]
  if (!dirs.length) return ''
  for (const d of dirs) {
    const root = await findGitRoot(d)
    if (root) return root
  }
  return commonDirPrefix(dirs)
}

async function findTranscriptFile(sessionDir) {
  const candidates = [
    path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(sessionDir, 'transcript.jsonl'),
  ]
  for (const c of candidates) {
    if (await exists(c)) return c
  }
  return null
}

async function scanTranscripts() {
  const byId = new Map()
  for (const { dir: brainDir, source } of BRAIN_DIRS) {
    for (const sessionDir of await listDirs(brainDir)) {
      const id = path.basename(sessionDir)
      if (!UUID.test(id)) continue
      const file = await findTranscriptFile(sessionDir)
      if (!file) continue
      try {
        const st = await fsp.stat(file)
        if (!st.size) continue
        const prev = byId.get(id)
        if (!prev || st.mtimeMs >= prev.mtime) {
          byId.set(id, {
            id,
            file,
            sessionDir,
            source,
            size: st.size,
            mtime: st.mtimeMs,
            born: st.birthtimeMs,
          })
        }
      } catch {
        /* vanished */
      }
    }
  }
  return [...byId.values()]
}

const FILE_ARG_KEYS = ['AbsolutePath', 'TargetFile', 'SearchPath', 'DirectoryPath', 'Path']

function inspectRecordMeta(r, entryId, state) {
  if (!r || typeof r !== 'object') return

  if (!state.startedAt && (r.created_at || r.timestamp)) {
    const t = Date.parse(r.created_at || r.timestamp)
    if (!Number.isNaN(t)) state.startedAt = t
  }
  if (!state.cwd && isWorkspacePath(r.cwd)) state.cwd = r.cwd
  if (r.model && typeof r.model === 'string') state.model = r.model

  const isUser = r.type === 'USER_INPUT' || r.role === 'user' || r.source === 'USER_EXPLICIT'
  if (isUser) {
    const text = userText(r)
    if (!state.prompt && text) state.prompt = text
    const rawContent = contentText(r.content || r.message?.content || '')
    if (!state.cwd) {
      const extracted = extractCwd(rawContent)
      if (extracted) state.cwd = extracted
    }
    const modelCfg = extractModelSettings(rawContent)
    if (modelCfg) {
      if (modelCfg.model) state.model = modelCfg.model
      if (modelCfg.effort) state.effort = modelCfg.effort
    }
  }

  if (Array.isArray(r.tool_calls)) {
    for (const tc of r.tool_calls) {
      const args = tc?.args
      if (!args || typeof args !== 'object') continue
      if (!state.cwd) {
        const cwdArg = unwrapArg(args.Cwd ?? args.cwd)
        if (isWorkspacePath(cwdArg)) state.cwd = cwdArg
      }
      if (!state.cwd) {
        for (const k of FILE_ARG_KEYS) {
          const fp = unwrapArg(args[k])
          if (isWorkspacePath(fp)) state.files.push(fp)
        }
      }
      if (tc.name === 'invoke_subagent') {
        const subs = unwrapArg(args.Subagents)
        const tasks = Array.isArray(subs)
          ? subs.map((s) => clean(s?.Prompt || s?.Role || 'Subagent')).filter(Boolean)
          : []
        state.pendingSubagentTasks.push(...(tasks.length ? tasks : ['Subagent']))
      }
      if (tc.name === 'send_message') {
        const recipient = unwrapArg(args.Recipient)
        if (typeof recipient === 'string' && UUID.test(recipient) && recipient.toLowerCase() !== entryId) {
          const id = recipient.toLowerCase()
          if (!state.subagents.has(id)) {
            state.subagents.set(id, clean(unwrapArg(args.Message) || 'Subagent'))
          }
        }
      }
    }
  }

  if (r.type === 'GENERIC') {
    const raw = contentText(r.content)
    if (!state.cwd && raw) {
      const fileMatch = /File Path:\s*`?file:\/\/(\/[^\s`\r\n]+)`?/i.exec(raw)
      if (fileMatch && isWorkspacePath(fileMatch[1])) state.files.push(fileMatch[1])
    }
    if (state.pendingSubagentTasks.length && raw) {
      const matches = raw.match(UUID_GLOBAL) || []
      for (const m of matches) {
        const subId = m.toLowerCase()
        if (subId === entryId) continue
        if (!state.subagents.has(subId)) {
          const task = state.pendingSubagentTasks.shift() || 'Subagent'
          state.subagents.set(subId, task)
        }
      }
      state.pendingSubagentTasks.length = 0
    }
  }
}

/**
 * Determine whether the last record in an Antigravity transcript leaves the turn closed or still running.
 *
 * Every completed step in Antigravity's `transcript.jsonl` (`USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC`)
 * carries `status: "DONE"`. A turn is only finished (idle) when the last step is a `PLANNER_RESPONSE`
 * with no `tool_calls` (or when `ask_question` blocks waiting on the user), or when the turn was
 * explicitly aborted/errored. While the last step is `USER_INPUT`, `GENERIC` (tool output), or a
 * `PLANNER_RESPONSE` invoking tools, the agent is actively mid-turn.
 */
function turnLifecycle(last) {
  if (!last || typeof last !== 'object') {
    return { closed: true, errored: false, waitingOnUser: false }
  }
  const status = String(last.status || '').toUpperCase()
  const type = String(last.type || '').toUpperCase()
  const aborted = status === 'CANCELED' || status === 'CANCELLED' || type === 'TURN_ABORTED'
  if (aborted) {
    return { closed: true, errored: false, waitingOnUser: false }
  }
  const errored = status === 'ERROR' || Boolean(last.error)
  if (errored) {
    return { closed: true, errored: true, waitingOnUser: false }
  }
  if (type === 'DONE' || status === 'COMPLETED') {
    return { closed: true, errored: false, waitingOnUser: false }
  }
  if (status === 'RUNNING' || status === 'IN_PROGRESS') {
    return { closed: false, errored: false, waitingOnUser: false }
  }
  if (type === 'PLANNER_RESPONSE') {
    const calls = Array.isArray(last.tool_calls) ? last.tool_calls : []
    if (calls.some((tc) => tc?.name === 'ask_question')) {
      return { closed: true, errored: false, waitingOnUser: true }
    }
    return { closed: calls.length === 0, errored: false, waitingOnUser: false }
  }
  if (type === 'USER_INPUT' || type === 'GENERIC' || last.source === 'USER_EXPLICIT' || last.role === 'user') {
    return { closed: false, errored: false, waitingOnUser: false }
  }
  return { closed: true, errored: false, waitingOnUser: false }
}

const parseCache = new Map()
async function facts(entry) {
  const hit = parseCache.get(entry.id)
  if (hit && hit.mtime === entry.mtime && hit.size === entry.size) return hit.value

  const state = {
    prompt: '',
    cwd: '',
    model: 'antigravity',
    effort: '',
    startedAt: 0,
    closed: true,
    errored: false,
    waitingOnUser: false,
    files: [],
    pendingSubagentTasks: [],
    subagents: new Map(),
  }

  try {
    const entryId = entry.id.toLowerCase()
    const headRecords = jsonLines(await readHead(entry.file, HEAD_BYTES))
    for (const r of headRecords) {
      inspectRecordMeta(r, entryId, state)
    }

    const tailRecords = jsonLines(await readTail(entry.file, TAIL_BYTES))
    for (const r of tailRecords) {
      inspectRecordMeta(r, entryId, state)
    }

    if (!state.cwd && state.files.length) {
      state.cwd = await inferWorkspaceFromFiles(state.files)
    }

    const last = tailRecords.length > 0 ? tailRecords[tailRecords.length - 1] : headRecords[headRecords.length - 1]
    if (last) {
      const lc = turnLifecycle(last)
      state.closed = lc.closed
      state.errored = lc.errored
      state.waitingOnUser = lc.waitingOnUser
    }
  } catch {
    /* mid-write, or vanished */
  }

  const value = {
    prompt: state.prompt,
    cwd: state.cwd,
    model: state.model,
    effort: state.effort,
    startedAt: state.startedAt,
    closed: state.closed,
    errored: state.errored,
    waitingOnUser: state.waitingOnUser,
    subagents: state.subagents,
  }
  parseCache.set(entry.id, { mtime: entry.mtime, size: entry.size, value })
  return value
}

async function scanThreads() {
  const entries = await scanTranscripts()
  const now = Date.now()
  const byId = new Map()

  for (const entry of entries) {
    const f = await facts(entry)
    byId.set(entry.id.toLowerCase(), { entry, f })
  }

  // Subagents spawned via `invoke_subagent` belong to their parent thread rather than standing
  // as top-level bots on their own.
  const childIds = new Set()
  for (const { f } of byId.values()) {
    for (const subId of f.subagents.keys()) {
      childIds.add(subId)
    }
  }

  const threads = []
  for (const [id, { entry, f }] of byId) {
    if (childIds.has(id)) continue

    let cwd = f.cwd || ''
    // If a parent session has not run a workspace tool itself yet, inherit cwd from its subagents.
    if (!cwd && f.subagents.size) {
      for (const subId of f.subagents.keys()) {
        const sub = byId.get(subId)
        if (sub?.f?.cwd) {
          cwd = sub.f.cwd
          break
        }
      }
    }

    const projectPath = cwd
    const project = cwd ? path.basename(cwd) : 'unknown'
    const prompt = f.prompt

    const activeSubagents = []
    for (const [subId, task] of f.subagents) {
      const sub = byId.get(subId)
      if (!sub) continue
      const subRunning = !sub.f.closed && now - sub.entry.mtime < ACTIVE_WINDOW_MS
      if (subRunning) {
        activeSubagents.push({
          id: sub.entry.id,
          task: (sub.f.prompt || task || 'Subagent').slice(0, 120),
          lastActivityAt: sub.entry.mtime,
        })
      }
    }

    const thread = {
      id: ID(entry.id),
      title: (prompt || 'Untitled thread').slice(0, 120),
      preview: prompt.slice(0, 240),
      project,
      projectPath,
      worktree: '',
      cwd,
      gitBranch: '',
      model: f.model || 'antigravity',
      effort: f.effort || '',
      createdAt: f.startedAt || entry.born || entry.mtime,
      lastActivityAt: entry.mtime,
      lastFocusedAt: 0,
      unread: Boolean(f.waitingOnUser),
      running: !f.closed && now - entry.mtime < ACTIVE_WINDOW_MS,
      hasError: f.errored,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: entry.size,
      source: entry.source || 'cli',
      canOpen: true,
      ref: { sessionId: entry.id, cwd },
    }
    if (activeSubagents.length) thread.subagents = activeSubagents
    threads.push(thread)
  }
  return threads
}

const CLI_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.npm-global', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
]

async function cliBinary() {
  for (const name of ['agy', 'antigravity', 'antigravity-cli']) {
    const bin = await findExecutable(name, CLI_DIRS)
    if (bin) return bin
  }
  return null
}

async function openThread(ref) {
  const id = ref?.sessionId
  if (typeof id !== 'string' || !UUID.test(id)) {
    return { ok: false, error: 'No openable Antigravity session id on that thread' }
  }
  const cwd = typeof ref?.cwd === 'string' ? ref.cwd : ''
  const bin = await cliBinary()
  const url = `antigravity://resume?session=${id}`
  let command
  if (bin) {
    command = { argv: [bin, '--resume', id], cwd }
  }
  return { ok: true, url, command }
}

async function newSession(dir) {
  const abs = String(dir || '').replace(/\\/g, '/')
  if (!abs.startsWith('/')) return { ok: false, error: 'That folder is not somewhere Antigravity can open' }
  const bin = await cliBinary()
  const url = `antigravity://new?${new URLSearchParams({ path: abs })}`
  let command
  if (bin) {
    command = { argv: [bin], cwd: abs }
  }
  return { ok: true, url, command }
}

async function detect() {
  for (const { dir } of BRAIN_DIRS) {
    if (await exists(dir)) return true
  }
  return false
}

export default {
  id: 'antigravity',
  name: 'Antigravity',
  detect,
  scanThreads,
  openThread,
  newSession,
  paths: { ANTIGRAVITY_HOME, BRAIN_DIR, BRAIN_DIRS },
}

