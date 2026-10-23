import assert from "node:assert/strict";
import { test } from "node:test";

const { useBrowser } = await import("../../store/browser.ts");
const { hoverLayout, measureForHover, refreshHover, registerRow, setSidebarUi, sidebarUi } = await import("./state.ts");

const W = "hw1";
const pending = [];
const row = () => ({ measureInWindow: (done) => pending.push(done) });
const answer = (x) => pending.shift()(x, 40, 170, 30);
const side = (sidebarSide) => useBrowser.setState((s) => ({ settings: { ...s.settings, sidebarSide, tabLayout: "sidebar" } }));
const shown = (id, x) => ({ windowId: W, kind: "tab", id, anchor: { x, y: 40, width: 170, height: 30 }, layout: hoverLayout(W) });

useBrowser.setState((s) => ({ windows: { ...s.windows, [W]: { id: W, tabIds: [], activeTabIds: {}, sidebarOpen: true, profileId: "default", frame: null } } }));

function reset() {
  pending.length = 0;
  side("left");
  setSidebarUi({ hover: null });
  registerRow(W, "a", row());
  registerRow(W, "b", row());
}

test("a side switch moves the window's hover layout on, so a card measured before it is stale", () => {
  reset();
  const before = hoverLayout(W);
  side("right");
  assert.equal(hoverLayout(W), before + 1);
  side("right");
  assert.equal(hoverLayout(W), before + 1, "nothing moved, no new layout");
  useBrowser.setState((s) => ({ windows: { ...s.windows, [W]: { ...s.windows[W], tabLayout: "top" } } }));
  assert.equal(hoverLayout(W), before + 2, "tabs moving to the top changes the effective side too");
  useBrowser.setState((s) => ({ windows: { ...s.windows, [W]: { ...s.windows[W], tabLayout: undefined } } }));
});

test("a hover measured on the old side never lands once the side has switched", async () => {
  reset();
  setSidebarUi({ hover: shown("a", 10) });
  const late = measureForHover(W, "b");
  side("right");
  answer(10);
  assert.equal(await late, null, "B's old-side measurement is dropped");
  assert.equal(sidebarUi().hover.id, "a");
});

test("the card on screen is measured again after the switch, in place, without reopening anything", async () => {
  reset();
  const a = shown("a", 10);
  setSidebarUi({ hover: a });
  side("right");
  const done = refreshHover(W, () => assert.fail("not gone"));
  answer(1020);
  await done;
  const now = sidebarUi().hover;
  assert.equal(now.id, "a");
  assert.equal(now.anchor.x, 1020);
  assert.equal(now.layout, hoverLayout(W));
  await refreshHover(W, () => assert.fail("not gone"));
  assert.equal(pending.length, 0, "a current card isn't measured again");
});

test("left, right, left: only the last switch's measurement is used", async () => {
  reset();
  setSidebarUi({ hover: shown("a", 10) });
  side("right");
  const first = refreshHover(W, () => assert.fail("not gone"));
  side("left");
  const second = refreshHover(W, () => assert.fail("not gone"));
  answer(1020);
  answer(12);
  await Promise.all([first, second]);
  assert.equal(sidebarUi().hover.anchor.x, 12);
  assert.equal(sidebarUi().hover.layout, hoverLayout(W));
});

test("a row gone while it was being measured, or a card dismissed meanwhile, is never shown again", async () => {
  reset();
  setSidebarUi({ hover: shown("a", 10) });
  side("right");
  let gone = 0;
  const refreshing = refreshHover(W, () => gone++);
  registerRow(W, "a", null);
  answer(1020);
  await refreshing;
  assert.equal(gone, 1, "the vanished row's card goes");
  assert.equal(sidebarUi().hover.anchor.x, 10, "and its old geometry is not republished");

  reset();
  setSidebarUi({ hover: shown("a", 10) });
  side("right");
  const dismissed = refreshHover(W, () => assert.fail("not gone"));
  setSidebarUi({ hover: null });
  answer(1020);
  await dismissed;
  assert.equal(sidebarUi().hover, null, "a dismissed card stays dismissed");
});
