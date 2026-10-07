// Element-level merge for the stale-save guard: when the board changed on disk under
// unsaved tab edits, re-apply the tab's edits on top of the newer board.
//
// Not Excalidraw's own reconcileElements: that has no base, so an agent edit that didn't
// bump `version` loses to the tab's untouched copy, and an element an agent removed by
// leaving it out of the file comes back.

const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

const byId = (elements) => {
  const map = new Map();
  for (const element of elements ?? []) {
    if (element && typeof element === "object" && element.id !== undefined && !map.has(String(element.id))) {
      map.set(String(element.id), element);
    }
  }
  return map;
};

const versionOf = (element) => (typeof element?.version === "number" ? element.version : 0);

const sameContent = (element, baseElement) => baseElement !== undefined && stableStringify(element) === stableStringify(baseElement);

// Excalidraw bumps version/versionNonce on every edit, so the tab's copy is unchanged when
// they match base (this ignores harmless normalisation). Agents writing the file often
// don't bump versions, so the board on disk is compared by content.
const tabUnchanged = (element, baseElement) => {
  if (baseElement === undefined) {
    return false;
  }
  if (typeof element.version === "number" && typeof element.versionNonce === "number") {
    return element.version === baseElement.version && element.versionNonce === baseElement.versionNonce;
  }
  return sameContent(element, baseElement);
};

/**
 * Merge `local` (the tab) onto `remote` (the board on disk now), per element id.
 *
 * With `base` (the elements the tab last loaded or saved):
 * - only one side changed an element since base: that side wins;
 * - an element missing on one side and unchanged on the other since base was removed there:
 *   drop it;
 * - both changed: higher `version` wins, ties go to the tab.
 * Without `base`: higher `version` wins, ties go to the tab, elements on one side are kept.
 * Deletions are `isDeleted: true` tombstones with a bumped version, so they follow the same
 * rules.
 *
 * Order follows `remote`; tab-only elements are inserted after their nearest preceding tab
 * neighbour. When every element has a fractional `index` string, the result is sorted by it.
 *
 * @template {{ id: string }} T
 * @param {{ base?: readonly T[] | null, local?: readonly T[], remote?: readonly T[] }} input
 * @returns {T[]}
 */
export function reconcileElements({ base = null, local = [], remote = [] }) {
  const baseById = base ? byId(base) : null;
  const localById = byId(local);
  const remoteById = byId(remote);

  const pick = (id) => {
    const localElement = localById.get(id);
    const remoteElement = remoteById.get(id);
    const baseElement = baseById?.get(id);
    if (localElement && !remoteElement) {
      return baseById && tabUnchanged(localElement, baseElement) ? null : localElement;
    }
    if (remoteElement && !localElement) {
      return baseById && sameContent(remoteElement, baseElement) ? null : remoteElement;
    }
    if (baseById && baseElement !== undefined) {
      if (tabUnchanged(localElement, baseElement)) {
        return remoteElement;
      }
      if (sameContent(remoteElement, baseElement)) {
        return localElement;
      }
    }
    return versionOf(remoteElement) > versionOf(localElement) ? remoteElement : localElement;
  };

  const result = [];
  const placed = new Set();
  for (const id of remoteById.keys()) {
    const chosen = pick(id);
    if (chosen) {
      result.push(chosen);
      placed.add(id);
    }
  }

  let previousLocalId = null;
  for (const id of localById.keys()) {
    if (!remoteById.has(id)) {
      const chosen = pick(id);
      if (chosen) {
        const anchor = previousLocalId === null ? -1 : result.findIndex((element) => String(element.id) === previousLocalId);
        result.splice(anchor + 1, 0, chosen);
        placed.add(id);
      }
    }
    if (placed.has(id)) {
      previousLocalId = id;
    }
  }

  if (result.length && result.every((element) => typeof element.index === "string")) {
    return result
      .map((element, position) => ({ element, position }))
      .sort((left, right) => (left.element.index < right.element.index ? -1 : left.element.index > right.element.index ? 1 : left.position - right.position))
      .map(({ element }) => element);
  }
  return result;
}
