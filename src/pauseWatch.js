// Notices when this process stood still: a paused or saved VM, a sleeping host, heavy
// swapping. Nothing else in the log shows it, yet everything breaks at once: the speaker
// runs out of audio, YouTube drops the cast session, the status page doesn't answer. With
// this line in the log, such a drop-out can be told apart from a network problem.

const fmt = (ms) => (ms >= 600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/**
 * What to log for one tick, from the monotonic and the wall clock (ms) at the previous tick
 * and now, or null. A paused VM's monotonic clock may or may not count the pause; when it
 * doesn't, the pause shows up as the wall clock being corrected (stepped) later.
 */
export function pauseMessage(prev, cur, intervalMs, thresholdMs) {
  const stood = cur.mono - prev.mono - intervalMs;
  if (stood > thresholdMs) {
    return `This process stood still for ${fmt(stood)} - the VM or host was paused or asleep, or ran out of CPU or memory`;
  }
  const jump = (cur.wall - prev.wall) - (cur.mono - prev.mono);
  if (Math.abs(jump) > thresholdMs) {
    return `The clock jumped ${jump > 0 ? 'forward' : 'back'} ${fmt(Math.abs(jump))} - on a VM, usually because it was paused and its clock was corrected`;
  }
  return null;
}

/** Check once a second; returns a function that stops it. */
export function watchPauses(logger, { intervalMs = 1000, thresholdMs = 5000 } = {}) {
  const read = () => ({ mono: Number(process.hrtime.bigint() / 1_000_000n), wall: Date.now() });
  let prev = read();
  const timer = setInterval(() => {
    const cur = read();
    const msg = pauseMessage(prev, cur, intervalMs, thresholdMs);
    prev = cur;
    if (msg) logger.warn(msg);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
