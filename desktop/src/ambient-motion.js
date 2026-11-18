// Only activity booleans reach this controller; no keys or text.
export function motionView(work, ai, typing, doing = false) {
  if (work === 'dancing') return work;
  if (ai) return 'ai';
  if (work === 'studying' || doing) return 'studying';
  return typing ? 'typing' : 'idle';
}
export function nextMotionIndex(length, last) { return length ? (last + 1) % length : 0; }
export function idleDelay(clip, reduced = false, view = 'idle') {
  const interval = view === 'typing'
    ? (reduced ? 45_000 : 12_000)
    : (reduced ? 120_000 : 60_000);
  return Math.max(interval, (clip?.duration || 0) + 500);
}
