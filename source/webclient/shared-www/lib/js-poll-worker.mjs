// js-poll-worker.mjs — dedicated worker that pings main every 10 s.
//
// Why: under .NET 10 MT (Mercury) with OffscreenCanvas transferred
// to the deputy, the MAIN thread has no compositor work and Chrome
// suspends `requestAnimationFrame` on it. The deputy's rAF still
// runs (FNA3D rendering), but main-thread callbacks scheduled via
// rAF / setInterval / setTimeout get starved.
//
// Workers have their own independent event loop. setInterval inside
// a worker fires reliably regardless of main-thread compositor
// state. The worker posts a message to main; main's worker.onmessage
// handler runs as a regular DOM event task and calls flush().
//
// Same-origin URL (resolved via new URL('./lib/js-poll-worker.mjs',
// import.meta.url)) is allowed by the page CSP `script-src 'self'`.
// blob: URL would have been blocked (worker-src not set), which is
// why v0.4.37's blob: experiment failed.

setInterval(() => { self.postMessage({ kind: 'js-poll-tick' }); }, 10000);
