import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LISTENER,
  LISTEN_LEASE_GRACE_MS,
  ListenLease,
  leaseLine,
  refusalText,
  waitUnderLease,
} from "./lease.js";

/** A clock the test moves by hand, so the grace window is exercised without waiting for it. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

test("the first call takes the lease under its name", () => {
  const clock = fakeClock();
  const lease = new ListenLease(clock.now);

  assert.equal(lease.current(), null);
  const claim = lease.claim("listener", 60_000);
  assert.deepEqual(claim, { granted: true });
  assert.deepEqual(lease.current(), {
    listener: "listener",
    secondsRemaining: (60_000 + LISTEN_LEASE_GRACE_MS) / 1000,
  });
});

test("a call under the same name renews the lease rather than being refused", () => {
  const clock = fakeClock();
  const lease = new ListenLease(clock.now);
  lease.claim("listener", 60_000);

  clock.advance(50_000);
  assert.deepEqual(lease.claim("listener", 600_000), { granted: true });
  assert.deepEqual(lease.current(), {
    listener: "listener",
    secondsRemaining: (600_000 + LISTEN_LEASE_GRACE_MS) / 1000,
  });
});

test("a call under a different name is refused while the lease is live, and names the holder", () => {
  const clock = fakeClock();
  const lease = new ListenLease(clock.now);
  lease.claim(DEFAULT_LISTENER, 600_000);

  clock.advance(100_000);
  const claim = lease.claim("canvas-listener", 60_000);
  assert.deepEqual(claim, { granted: false, listener: DEFAULT_LISTENER, secondsRemaining: 530 });
  // The refused call changes nothing: the holder keeps its own deadline.
  assert.deepEqual(lease.current(), { listener: DEFAULT_LISTENER, secondsRemaining: 530 });
});

test("a 600 second wait does not look stale before its own deadline plus the grace window", () => {
  const clock = fakeClock();
  const lease = new ListenLease(clock.now);
  lease.claim("listener", 600_000);

  clock.advance(600_000 + LISTEN_LEASE_GRACE_MS - 1);
  assert.equal(lease.claim("other", 60_000).granted, false);
  assert.notEqual(lease.current(), null);
});

test("the lease expires a grace window after the in-flight wait's deadline", () => {
  const clock = fakeClock();
  const lease = new ListenLease(clock.now);
  lease.claim("listener", 60_000);

  clock.advance(60_000 + LISTEN_LEASE_GRACE_MS);
  assert.equal(lease.current(), null);
});

test("the next caller takes an expired lease under any name, which is how a dead listener unsticks itself", () => {
  const clock = fakeClock();
  const lease = new ListenLease(clock.now);
  lease.claim("killed-listener", 60_000);

  clock.advance(60_000 + LISTEN_LEASE_GRACE_MS);
  assert.deepEqual(lease.claim("lead", 60_000), { granted: true });
  assert.deepEqual(lease.current(), {
    listener: "lead",
    secondsRemaining: (60_000 + LISTEN_LEASE_GRACE_MS) / 1000,
  });
});

test("a restarted listener reusing its name reclaims immediately", () => {
  const clock = fakeClock();
  const lease = new ListenLease(clock.now);
  lease.claim("canvas-listener", 600_000);

  clock.advance(1_000);
  assert.deepEqual(lease.claim("canvas-listener", 600_000), { granted: true });
});

test("reset drops the lease, so a join starts the next room with nobody listening", () => {
  const clock = fakeClock();
  const lease = new ListenLease(clock.now);
  lease.claim("listener", 600_000);

  lease.reset();
  assert.equal(lease.current(), null);
  assert.deepEqual(lease.claim("lead", 60_000), { granted: true });
});

test("room_status prints the holder and the seconds remaining, or none", () => {
  const clock = fakeClock();
  const lease = new ListenLease(clock.now);
  assert.equal(leaseLine(lease), "listening: none");

  lease.claim("canvas-listener", 600_000);
  assert.equal(leaseLine(lease), `listening: canvas-listener (${600 + LISTEN_LEASE_GRACE_MS / 1000}s remaining)`);

  clock.advance(600_000 + LISTEN_LEASE_GRACE_MS);
  assert.equal(leaseLine(lease), "listening: none");
});

test("the refusal names the holder and points at mention_list", () => {
  const out = refusalText({ granted: false, listener: "canvas-listener", secondsRemaining: 530 });
  assert.match(out, /canvas-listener/);
  assert.match(out, /530s/);
  assert.match(out, /mention_list/);
});

test("a refused wait returns the refusal at once and never starts the wait", async () => {
  const clock = fakeClock();
  const lease = new ListenLease(clock.now);
  lease.claim("canvas-listener", 600_000);

  let started = false;
  const outcome = await waitUnderLease(lease, "lead", 600_000, () => {
    started = true;
    // A wait that never settles: the test only completes if the refusal short-circuits it.
    return new Promise<string>(() => {});
  });

  assert.equal(started, false);
  assert.equal(outcome.granted, false);
  assert.ok(outcome.granted === false && outcome.text.includes("canvas-listener"));
});

test("a granted wait runs under the lease and hands back its value", async () => {
  const clock = fakeClock();
  const lease = new ListenLease(clock.now);

  const outcome = await waitUnderLease(lease, "lead", 60_000, async () => "a mention");
  assert.deepEqual(outcome, { granted: true, value: "a mention" });
  assert.equal(lease.current()?.listener, "lead");
});
