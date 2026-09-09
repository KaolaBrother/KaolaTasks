import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, vi } from 'vitest'

// Vue rejects DOM events older than their listener. Linux VM wall-clock corrections
// can otherwise make freshly dispatched test-utils events appear older (observed -135ms).
// Keep real timers and elapsed time; stabilize Date.now only inside each test.
beforeEach(() => {
  const epoch = Date.now()
  const started = performance.now()
  vi.spyOn(Date, 'now').mockImplementation(() => epoch + Math.floor(performance.now() - started))
})

afterEach(() => {
  vi.restoreAllMocks()
})
