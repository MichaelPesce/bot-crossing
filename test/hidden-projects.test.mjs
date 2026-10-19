import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DORMANT_HOURS,
  STALE_MS,
  formatDormantWindow,
  hiddenCatalog,
  hideProject,
  liveThreadsForColony,
  previewDormantJobs,
  staleMsFromHours,
  statusFor,
  unhideProject,
} from '../src/game/hidden-projects.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

test('staleMsFromHours and formatDormantWindow handle hours and days', () => {
  assert.equal(staleMsFromHours(), STALE_MS)
  assert.equal(staleMsFromHours(6), 6 * HOUR)
  assert.equal(staleMsFromHours(-5), DEFAULT_DORMANT_HOURS * HOUR)

  assert.equal(formatDormantWindow(1), '1 hour')
  assert.equal(formatDormantWindow(6), '6 hours')
  assert.equal(formatDormantWindow(6, { short: true }), '6h')
  assert.equal(formatDormantWindow(24), '1 day')
  assert.equal(formatDormantWindow(72), '3 days')
  assert.equal(formatDormantWindow(72, { short: true }), '3d')
})

test('statusFor respects priority order and configurable staleMs', () => {
  const now = 1_000_000_000_000
  const old = now - 10 * DAY

  assert.equal(statusFor({ hasError: true, lastActivityAt: old }, now, 1 * HOUR), 'blocked')
  assert.equal(statusFor({ running: true, lastActivityAt: old }, now, 1 * HOUR), 'working')
  assert.equal(statusFor({ prState: 'MERGED', lastActivityAt: old }, now, 1 * HOUR), 'celebrating')
  assert.equal(statusFor({ unread: true, lastActivityAt: old }, now, 1 * HOUR), 'waiting')

  // Idle within window, sleeping past window
  assert.equal(statusFor({ lastActivityAt: now - 2 * HOUR }, now, 6 * HOUR), 'idle')
  assert.equal(statusFor({ lastActivityAt: now - 8 * HOUR }, now, 6 * HOUR), 'sleeping')
})

test('previewDormantJobs counts dormant jobs on the map across active repos', () => {
  const now = 1_000_000_000_000
  const threads = [
    // Repo A: 1 working, 2 sleeping (> 3d), 1 idle (2h ago)
    { id: 'a1', project: 'alpha', running: true, lastActivityAt: now - 5 * DAY },
    { id: 'a2', project: 'alpha', lastActivityAt: now - 4 * DAY },
    { id: 'a3', project: 'alpha', lastActivityAt: now - 6 * DAY },
    { id: 'a4', project: 'alpha', lastActivityAt: now - 2 * HOUR },
    // Repo B: 100% sleeping (> 3d) -> folded away when hideDormantRepos is true
    { id: 'b1', project: 'beta', lastActivityAt: now - 10 * DAY },
    { id: 'b2', project: 'beta', lastActivityAt: now - 12 * DAY },
    // Repo C: unread old job (waiting, NOT sleeping) + 1 sleeping job
    { id: 'c1', project: 'gamma', unread: true, lastActivityAt: now - 9 * DAY },
    { id: 'c2', project: 'gamma', lastActivityAt: now - 5 * DAY },
  ]

  const p72 = previewDormantJobs(threads, {
    hideDormantRepos: true,
    dormantHours: 72,
    now,
  })
  assert.equal(p72.foldedRepoCount, 1)
  assert.equal(p72.foldedThreadCount, 2)
  assert.equal(p72.wouldHideCount, 3) // a2, a3, c2
  assert.equal(p72.remainingVisibleCount, 3) // a1, a4, c1
  assert.equal(p72.oldAttentionCount, 1) // c1 is old but unread ('waiting')
  assert.equal(p72.affectedProjects.length, 2)
  assert.deepEqual(
    p72.affectedProjects.map((r) => [r.name, r.dormantCount, r.totalCount]),
    [
      ['alpha', 2, 4],
      ['gamma', 1, 2],
    ]
  )

  // Tightening window to 1h makes a4 dormant too
  const p1 = previewDormantJobs(threads, {
    hideDormantRepos: true,
    dormantHours: 1,
    now,
  })
  assert.equal(p1.wouldHideCount, 4) // a2, a3, a4, c2
  assert.equal(p1.remainingVisibleCount, 2) // a1 (running), c1 (waiting)
})

test('previewDormantJobs never empties the entire map if all threads are sleeping', () => {
  const now = 1_000_000_000_000
  const threads = [
    { id: 'a1', project: 'alpha', lastActivityAt: now - 10 * DAY },
    { id: 'b1', project: 'beta', lastActivityAt: now - 12 * DAY },
  ]
  const preview = previewDormantJobs(threads, {
    hideDormantRepos: true,
    dormantHours: 72,
    now,
  })
  assert.equal(preview.allSleeping, true)
  assert.equal(preview.wouldHideCount, 0)
  assert.equal(preview.remainingVisibleCount, 2)
})

test('hideProject, unhideProject, and hiddenCatalog work as expected', () => {
  const list = hideProject([], 'alpha')
  assert.deepEqual(list, ['alpha'])
  assert.deepEqual(unhideProject(list, 'alpha'), [])
  const cat = hiddenCatalog(['alpha'], [{ id: '1', project: 'alpha' }])
  assert.deepEqual(cat, [{ name: 'alpha', count: 1 }])
  assert.equal(liveThreadsForColony([{ id: '1', project: 'alpha' }], [], ['alpha']).length, 0)
})

