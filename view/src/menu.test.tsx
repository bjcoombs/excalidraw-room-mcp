import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EXPORT_IMAGE_LABEL,
  FIND_ON_CANVAS_LABEL,
  HELP_LABEL,
  ROOM_MENU_LABELS,
  RoomMenuItems,
  SNAPSHOT_LABEL,
  type MenuItemProps,
  type MenuParts,
} from "./menu.js";
import { openInBrowser, OPEN_IN_BROWSER_LABEL, type OpenLinkCapable } from "./status.js";

const LINK = "https://excalidraw.com/#room=0123456789abcdef0123,AbCdEfGhIjKlMnOpQrStUv";

/**
 * Stand-ins for the Excalidraw menu pieces, which cannot run under Node. Each
 * records what it was asked to render and what it would do when selected, so a
 * static render is enough to read the menu off the component and to press an
 * item. The two default items carry Excalidraw's own labels.
 */
function parts(): { parts: MenuParts; labels: string[]; select: (label: string) => void } {
  const labels: string[] = [];
  const handlers = new Map<string, () => void>();
  const Item = ({ onSelect, children }: MenuItemProps) => {
    const label = String(children);
    labels.push(label);
    if (onSelect) handlers.set(label, onSelect);
    return <button type="button">{label}</button>;
  };
  const Default = (label: string) => () => {
    labels.push(label);
    return <button type="button">{label}</button>;
  };
  return {
    parts: { Item, Search: Default(FIND_ON_CANVAS_LABEL), Help: Default(HELP_LABEL) },
    labels,
    select: (label) => {
      const handler = handlers.get(label);
      assert.ok(handler, `no item labelled ${label}`);
      handler();
    },
  };
}

/** A host that takes, refuses or drops an open-link request, and records what it was asked. */
function openLinkHost(behaviour: "accept" | "refuse"): OpenLinkCapable & { asked: { url: string }[] } {
  const asked: { url: string }[] = [];
  return {
    asked,
    openLink: async (params) => {
      asked.push(params);
      return behaviour === "refuse" ? { isError: true } : {};
    },
  };
}

function render(over: Partial<Parameters<typeof RoomMenuItems>[0]> = {}) {
  const fake = parts();
  const markup = renderToStaticMarkup(
    <RoomMenuItems parts={fake.parts} onSnapshot={() => undefined} onExport={() => undefined} onOpen={() => undefined} {...over} />,
  );
  return { ...fake, markup };
}

test("the main menu lists exactly Send snapshot to Claude, Export image, Open in browser, Find on canvas and Help", () => {
  const { labels, markup } = render();
  // Order included: the reader's own actions first, Excalidraw's last, and
  // nothing else at all - no Save to, no scene loading, no clearing the
  // canvas, and none of the three links to Excalidraw's own channels.
  assert.deepEqual(labels, [...ROOM_MENU_LABELS]);
  assert.deepEqual(labels, [SNAPSHOT_LABEL, EXPORT_IMAGE_LABEL, OPEN_IN_BROWSER_LABEL, FIND_ON_CANVAS_LABEL, HELP_LABEL]);
  for (const label of ROOM_MENU_LABELS) assert.ok(markup.includes(label), markup);
  for (const absent of ["Save to", "Load", "Reset the canvas", "GitHub", "Discord", "Follow us"]) {
    assert.ok(!markup.includes(absent), `${absent} is still in the menu: ${markup}`);
  }
});

test("Open in browser in the menu opens the room link", async () => {
  const host = openLinkHost("accept");
  let outcome = "";
  const { select } = render({ onOpen: () => void openInBrowser(host, LINK).then((result) => (outcome = result)) });
  select(OPEN_IN_BROWSER_LABEL);
  // The request is asynchronous; the assertion below waits for it rather than
  // for a fixed delay.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(host.asked, [{ url: LINK }]);
  assert.equal(outcome, "opened");
});

test("selecting an item runs the action it was given", () => {
  const pressed: string[] = [];
  const { select } = render({
    onSnapshot: () => pressed.push("snapshot"),
    onExport: () => pressed.push("export"),
    onOpen: () => pressed.push("open"),
  });
  select(SNAPSHOT_LABEL);
  select(EXPORT_IMAGE_LABEL);
  select(OPEN_IN_BROWSER_LABEL);
  assert.deepEqual(pressed, ["snapshot", "export", "open"]);
});
