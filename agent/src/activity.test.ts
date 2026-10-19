import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityTracker, deriveActivity, visibleRuns, type ActivitySnapshot } from "./activity.ts";

function fakeClock(start = Date.parse("2026-10-08T01:00:00Z")) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => new Date(now),
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id as any; },
    clearTimer: (t: any) => { timers.delete(t); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

class FakeRuns {
  list: { id: string; kind: string; title: string; startedAt: string; status: string }[] = [];
  fns = new Set<(u: { type: string }) => void>();
  active() { return this.list.filter((r) => r.status === "running"); }
  subscribe(fn: (u: { type: string }) => void) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
  start(id: string, kind: string, at: Date) { this.list.push({ id, kind, title: kind, startedAt: at.toISOString(), status: "running" }); this.emit(); }
  end(id: string) { const r = this.list.find((x) => x.id === id)!; r.status = "done"; this.emit(); }
  emit() { for (const f of this.fns) f({ type: "runs" }); }
}

test("deriveActivity: dancing > studying > idle", () => {
  assert.equal(deriveActivity(0, false), "idle");
  assert.equal(deriveActivity(2, false), "studying");
  assert.equal(deriveActivity(2, true), "dancing");
  assert.equal(deriveActivity(0, true), "dancing");
});

test("visibleRuns: chat 은 빼고, 주기 중계는 grace 뒤에만", () => {
  const t0 = Date.parse("2026-10-08T01:00:00Z");
  const at = (ms: number) => new Date(t0 + ms).toISOString();
  const runs = [
    { id: "a", kind: "chat", title: "", startedAt: at(0) },
    { id: "b", kind: "slack-ingest", title: "", startedAt: at(0) },
    { id: "c", kind: "fix", title: "", startedAt: at(0) },
  ];
  const v1 = visibleRuns(runs, t0 + 5e3);
  assert.deepEqual(v1.runs.map((r) => r.id), ["c"]);
  assert.equal(v1.recheckInMs, 15e3);
  const v2 = visibleRuns(runs, t0 + 20e3);
  assert.deepEqual(v2.runs.map((r) => r.id), ["b", "c"]);
  assert.equal(v2.recheckInMs, undefined);
});

test("ActivityTracker: runs 기록을 따라 studying, 춤이 끝나면 그 전 상태로", () => {
  const clk = fakeClock();
  const src = new FakeRuns();
  const a = new ActivityTracker(clk);
  const seen: ActivitySnapshot[] = [];
  a.onChange = (s) => seen.push(s);
  a.bindRuns(src);
  assert.equal(a.snapshot().activity, "idle");

  src.start("r1", "briefing", clk.now());
  assert.equal(a.snapshot().activity, "studying");
  assert.equal(seen.at(-1)!.runs[0].id, "r1");

  const danceId = a.startDance(8000);
  assert.equal(a.snapshot().activity, "dancing");
  assert.equal(a.snapshot().danceId, danceId);
  clk.advance(8000);
  assert.equal(a.snapshot().activity, "studying"); // 일이 아직 돌고 있으니 공부로 돌아감
  assert.equal(a.snapshot().danceId, undefined);

  src.end("r1");
  assert.equal(a.snapshot().activity, "idle");
  a.startDance(1000);
  clk.advance(1000);
  assert.equal(seen.at(-1)!.activity, "idle");
});

test("ActivityTracker: 짧은 주기 작업은 깜빡이지 않고, 길어지면 그때 studying 을 알린다", () => {
  const clk = fakeClock();
  const src = new FakeRuns();
  const a = new ActivityTracker(clk);
  const seen: string[] = [];
  a.onChange = (s) => seen.push(s.activity);
  a.bindRuns(src);
  src.start("s1", "slack-ingest", clk.now());
  clk.advance(5e3);
  src.end("s1");
  assert.deepEqual(seen, ["idle"]); // bind 때 한 번만, 바뀐 게 없으면 다시 안 보냄

  src.start("s2", "slack-ingest", clk.now());
  clk.advance(21e3); // grace(20s) 지나면 recheck 타이머가 알린다
  assert.equal(seen.at(-1), "studying");
  src.end("s2");
  assert.equal(seen.at(-1), "idle");
});

test("ActivityTracker.begin/track: 기록 밖 일도 studying, 끝내기는 한 번만", async () => {
  const clk = fakeClock();
  const a = new ActivityTracker(clk);
  const end = a.begin("other", "뭔가");
  assert.equal(a.snapshot().activity, "studying");
  end(); end();
  assert.equal(a.snapshot().activity, "idle");
  const v = await a.track("profile", "학습", async () => { assert.equal(a.snapshot().activity, "idle"); return 3; }); // profile 은 grace 15s
  assert.equal(v, 3);
  await assert.rejects(a.track("fix", "x", async () => { assert.equal(a.snapshot().activity, "studying"); throw new Error("boom"); }));
  assert.equal(a.snapshot().activity, "idle");
});
