/**
 * The widget's main menu: what it lists, in what order, and what each item does.
 *
 * Excalidraw's own hamburger menu is an editor's menu - saving to a file,
 * loading a scene, clearing the canvas, and three links to Excalidraw's own
 * channels. In a read-only chat widget the file actions are blocked by the
 * sandbox and the links advertise a third party, so the menu is replaced
 * wholesale (issue #72) with the four actions a reader of a room actually has,
 * plus Excalidraw's own search and help, which work as they are.
 *
 * The items are declared here and the Excalidraw components are passed in:
 * this module is React and nothing else, so it renders under Node with
 * renderToStaticMarkup and the menu's contents are pinned by test rather than
 * by screenshot. menu-excalidraw.tsx supplies the real MainMenu pieces.
 */
import type { ComponentType, ReactNode } from "react";
import { OPEN_IN_BROWSER_LABEL } from "./status.js";

/** Ask the model to look at what the reader is looking at. */
export const SNAPSHOT_LABEL = "Send snapshot to Claude";

/** Save the picture, through the host rather than through the sandbox. */
export const EXPORT_IMAGE_LABEL = "Export image";

/** Excalidraw's own search, whose label upstream is search.title. */
export const FIND_ON_CANVAS_LABEL = "Find on canvas";

/** Excalidraw's own shortcut help. */
export const HELP_LABEL = "Help";

/**
 * The menu, in order. The acceptance contract for issue #72 pins both the
 * membership and the order, and the operator check reads this list off the
 * screen; keep the two the same.
 */
export const ROOM_MENU_LABELS = [SNAPSHOT_LABEL, EXPORT_IMAGE_LABEL, OPEN_IN_BROWSER_LABEL, FIND_ON_CANVAS_LABEL, HELP_LABEL] as const;

/** The props MainMenu.Item takes, as far as this module uses them. */
export interface MenuItemProps {
  onSelect?: () => void;
  children: ReactNode;
}

/**
 * The Excalidraw menu pieces this module renders. Injected rather than
 * imported: the package assumes a DOM, and this file has to run under Node.
 * `Search` and `Help` are Excalidraw's default items, which bring their own
 * labels from its locale - the two constants above restate them so the list
 * can be asserted, and the operator check (H2 in the contract) is what
 * confirms the screen agrees.
 */
export interface MenuParts {
  Item: ComponentType<MenuItemProps>;
  Search: ComponentType;
  Help: ComponentType;
}

export interface RoomMenuItemsProps {
  parts: MenuParts;
  /** Render what the reader can see and offer it to the model. */
  onSnapshot: () => void;
  /** Save the image through the host, or fall back to Excalidraw's dialog. */
  onExport: () => void;
  /** Open the room on excalidraw.com, the same action as the status bar's control. */
  onOpen: () => void;
}

/**
 * The five items. A separator between the room's actions and Excalidraw's own
 * would be one more injected part for no information, so the order carries it:
 * ours first, theirs last.
 */
export function RoomMenuItems({ parts, onSnapshot, onExport, onOpen }: RoomMenuItemsProps) {
  const { Item, Search, Help } = parts;
  return (
    <>
      <Item onSelect={onSnapshot}>{SNAPSHOT_LABEL}</Item>
      <Item onSelect={onExport}>{EXPORT_IMAGE_LABEL}</Item>
      <Item onSelect={onOpen}>{OPEN_IN_BROWSER_LABEL}</Item>
      <Search />
      <Help />
    </>
  );
}
