/**
 * Repos you have taken off the map.
 *
 * Colony-only, and that is the whole point: hiding writes nothing to any harness and archives
 * nothing. The threads stay exactly where they are and keep working; the map just stops drawing
 * that repo until you show it again. It is for the checkout you have forty dead threads in and
 * do not want owning a third of your ground.
 *
 * Keyed on the project *name*, which is what plots are keyed on too. That has a consequence
 * worth knowing: a second checkout of the same repo appearing renames `foo` to `1/foo` (see
 * `disambiguateProjects` in server/scan.mjs) and the hide quietly stops matching. Keying on the
 * path instead would fix it and break the moment somebody moves a folder, and the layout has the
 * same trade — so both are wrong in the same direction, which is at least predictable.
 */

export function hideProject(hidden, name) {
  const id = String(name || '')
  if (!id || hidden.includes(id)) return [...hidden]
  return [...hidden, id]
}

export function unhideProject(hidden, name) {
  const id = String(name || '')
  return hidden.filter((n) => n !== id)
}

/** The threads the colony should actually draw. */
export function liveThreadsForColony(threads, archivedIds, hiddenProjects) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds)
  const hidden = hiddenProjects instanceof Set ? hiddenProjects : new Set(hiddenProjects)
  return threads.filter((t) => !t.archived && !archived.has(t.id) && !hidden.has(t.project || 'unknown'))
}

/**
 * What the sidebar lists, with a live count each — so a hidden repo that has since gone quiet
 * reads as `0` and you can tell it is safe to forget rather than having to show it to find out.
 */
export function hiddenCatalog(hidden, threads) {
  const names = [...new Set(hidden.map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  return names.map((name) => ({
    name,
    count: threads.filter((t) => !t.archived && (t.project || 'unknown') === name).length,
  }))
}

export const DEFAULT_DORMANT_HOURS = 72
export const STALE_MS = DEFAULT_DORMANT_HOURS * 60 * 60 * 1000

export const DORMANT_PRESETS = [
  { hours: 1, short: '1h', label: '1 hour', longLabel: '1 hour' },
  { hours: 6, short: '6h', label: '6 hours', longLabel: '6 hours' },
  { hours: 12, short: '12h', label: '12 hours', longLabel: '12 hours' },
  { hours: 24, short: '1d', label: '1 day', longLabel: '1 day' },
  { hours: 48, short: '2d', label: '2 days', longLabel: '2 days' },
  { hours: 72, short: '3d', label: '3 days', longLabel: '3 days' },
  { hours: 168, short: '7d', label: '7 days', longLabel: '7 days' },
  { hours: 336, short: '14d', label: '14 days', longLabel: '14 days' },
  { hours: 720, short: '30d', label: '30 days', longLabel: '30 days' },
]

export function staleMsFromHours(hours = DEFAULT_DORMANT_HOURS) {
  const n = Number(hours)
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_DORMANT_HOURS) * 60 * 60 * 1000
}

export function formatDormantWindow(hours = DEFAULT_DORMANT_HOURS, { short = false } = {}) {
  const h = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Number(hours) : DEFAULT_DORMANT_HOURS
  if (h < 24) {
    const rounded = Math.round(h * 10) / 10
    return short ? `${rounded}h` : `${rounded} hour${rounded === 1 ? '' : 's'}`
  }
  const days = Math.round((h / 24) * 10) / 10
  return short ? `${days}d` : `${days} day${days === 1 ? '' : 's'}`
}

/** Thread → behaviour. First match wins, exactly like the board's auto-sort. */
export function statusFor(thread, now = Date.now(), staleMs = STALE_MS) {
  if (thread.hasError) return 'blocked'
  if (thread.running) return 'working'
  if (thread.prState === 'MERGED') return 'celebrating'
  if (thread.unread) return 'waiting'
  if (now - thread.lastActivityAt > staleMs) return 'sleeping'
  return 'idle'
}

/**
 * Preview how many dormant jobs on the map would be hidden for a given `dormantHours` threshold.
 *
 * Mirrors the exact two-stage dormancy logic in `Colony.setThreads`:
 *   1. Repos where 100% of threads are sleeping fold off the map when `hideDormantRepos` is on.
 *   2. Inside the remaining on-map repos, individual sleeping threads are counted as dormant jobs
 *      that `hideDormantJobs` will hide (unless every thread across the entire colony is sleeping,
 *      in which case the colony never empties the planet).
 */
export function previewDormantJobs(
  threads,
  {
    archivedIds = new Set(),
    hiddenProjects = new Set(),
    hideDormantRepos = true,
    dormantHours = DEFAULT_DORMANT_HOURS,
    now = Date.now(),
  } = {}
) {
  const staleMs = staleMsFromHours(dormantHours)
  const live = liveThreadsForColony(threads, archivedIds, hiddenProjects)

  const byProject = new Map()
  for (const thread of live) {
    const key = thread.project || 'unknown'
    if (!byProject.has(key)) byProject.set(key, [])
    byProject.get(key).push(thread)
  }

  const foldedRepos = new Set()
  if (hideDormantRepos) {
    for (const [name, list] of byProject) {
      if (list.every((t) => statusFor(t, now, staleMs) === 'sleeping')) foldedRepos.add(name)
    }
    if (foldedRepos.size === byProject.size) foldedRepos.clear()
  }

  let foldedRepoThreadCount = 0
  for (const name of foldedRepos) {
    foldedRepoThreadCount += byProject.get(name)?.length || 0
    byProject.delete(name)
  }

  let totalOnMap = 0
  let dormantOnMap = 0
  let oldAttentionCount = 0
  const hiddenThreadIds = new Set()
  const repos = []

  for (const [name, list] of byProject) {
    let dormantCount = 0
    let keptCount = 0
    for (const t of list) {
      totalOnMap++
      const st = statusFor(t, now, staleMs)
      if (st === 'sleeping') {
        dormantCount++
        dormantOnMap++
        hiddenThreadIds.add(t.id)
      } else {
        keptCount++
        if ((st === 'blocked' || st === 'waiting') && now - (t.lastActivityAt || 0) > staleMs) {
          oldAttentionCount++
        }
      }
    }
    if (dormantCount > 0) {
      repos.push({ name, dormantCount, keptCount, totalCount: list.length })
    }
  }

  repos.sort((a, b) => b.dormantCount - a.dormantCount || a.name.localeCompare(b.name))

  // Never empty the entire planet if every single thread on the map is sleeping.
  const allSleeping = totalOnMap > 0 && dormantOnMap === totalOnMap
  const hiddenCount = allSleeping ? 0 : dormantOnMap
  const keptCount = totalOnMap - hiddenCount
  if (allSleeping) hiddenThreadIds.clear()

  return {
    dormantHours: Number(dormantHours) || DEFAULT_DORMANT_HOURS,
    staleMs,
    totalOnMap,
    dormantOnMap,
    hiddenCount,
    wouldHideCount: hiddenCount,
    keptCount,
    remainingVisibleCount: keptCount,
    allSleeping,
    oldAttentionCount,
    foldedRepoCount: foldedRepos.size,
    foldedRepoThreadCount,
    foldedThreadCount: foldedRepoThreadCount,
    repos,
    affectedProjects: repos,
    hiddenThreadIds,
  }
}

