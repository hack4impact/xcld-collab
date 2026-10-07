// The tab's side of merging (versions and merge, slice 5). The tab sees the board through
// Excalidraw's restore, which fills in defaults (an agent's minimal JSON gains a seed, colors,
// an index...); the server merges the board as written. These helpers keep the two apart, so a
// filled-in default never counts as this tab's edit, and both local merges use the server's
// merge module (tools/merge.mjs): units, bindings and deletions follow the same rules.
// Retired: re-applying unsaved edits in the tab before saving (app/src/reconcile.mjs). The tab now
// saves first, with its base, and the server merges.
import { mergeBoard, sameContent } from "../../tools/merge.mjs";

const TAB = "tab";

const byId = (elements) => {
  const map = new Map();
  for (const element of elements ?? []) {
    if (element && typeof element.id === "string" && !map.has(element.id)) {
      map.set(element.id, element);
    }
  }
  return map;
};

/**
 * What the server wrote, per element id, with the version stamp of the restored copy the tab
 * shows. `raw` is the board as the server sent it; `shown` is what the tab put on the canvas.
 * @returns {Map<string, { raw: object, version: unknown, versionNonce: unknown }>}
 */
export const serverCopies = (raw, shown) => {
  const shownById = byId(shown);
  const copies = new Map();
  for (const element of raw ?? []) {
    const copy = shownById.get(element?.id);
    if (copy && !copies.has(element.id)) {
      copies.set(element.id, { raw: element, version: copy.version, versionNonce: copy.versionNonce });
    }
  }
  return copies;
};

/**
 * The elements a save sends: an element this tab hasn't touched since the server sent it (same
 * version stamp as when it was shown) goes out exactly as the server wrote it.
 */
export const wireElements = (elements, copies) => elements.map((element) => {
  const copy = copies?.get(element.id);
  return copy && copy.version === element.version && copy.versionNonce === element.versionNonce ? copy.raw : element;
});

/**
 * After a merged save: the server's merged board plus the edits this tab made while the save was
 * in flight. `sent` is the tab's own copy of the elements at send time, `wire` what the save
 * carried (wireElements), `masterRaw` the merged board as the server answered it, `master` that
 * board restored for the canvas, `local` the canvas now.
 *
 * A unit the merge left as this tab sent it keeps the tab's copy. Master wins a unit both changed
 * since `sent`: it holds the merge result, which may be another writer's newer edit, and keeping
 * the tab's copy would send this tab's losing version again with master as its base, where it
 * would silently win. `dropped` lists those units.
 */
export const keepEditsSinceSave = ({ sent, wire = sent, masterRaw, master = masterRaw, local }) => {
  const sentById = byId(sent);
  const wireById = byId(wire);
  const masterById = byId(master);
  const aligned = [];
  for (const element of masterRaw ?? master) {
    const wired = wireById.get(element.id);
    const unchanged = wired !== undefined && sentById.has(element.id) && sameContent(element, wired, { withArrowRefs: true });
    const shown = unchanged ? sentById.get(element.id) : masterById.get(element.id);
    if (shown) {
      aligned.push(shown);
    }
  }
  const result = mergeBoard({
    base: sent,
    master: aligned,
    branch: local,
    branchWrittenAt: 0,
    branchAuthor: TAB,
    masterDefault: { writtenAt: Number.MAX_SAFE_INTEGER, author: "server" },
  });
  return { elements: result.elements, shownMaster: aligned, kept: result.applied, dropped: result.overwritten };
};

/**
 * Offline fallback, only when the server answers 409 (it no longer knows the tab's base, e.g. a
 * base expired after a day without reads): merge the tab's unsaved edits onto the board as it is
 * now, against the version the tab last loaded. The tab's edits are the newest, so they win a unit
 * both changed; `overwritten` lists those units (winner: `author`, this tab's key). The tab then
 * saves the result on the new base.
 */
export const reapplyUnsavedEdits = ({ base, remote, local, author = TAB }) => {
  const result = mergeBoard({ base, master: remote, branch: local, branchWrittenAt: 0, branchAuthor: author });
  return { elements: result.elements, overwritten: result.overwritten };
};
