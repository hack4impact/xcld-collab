const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const uniqueIdFor = (wanted, used) => {
  const original = String(wanted ?? "element");
  let candidate = original;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${original}_${suffix++}`;
  }
  used.add(candidate);
  return candidate;
};

const firstMappedId = (renamesByOldId, id) => {
  const values = renamesByOldId.get(id);
  return values?.[0] ?? id;
};

export function disambiguateDuplicateElementIds(elements) {
  const cloned = JSON.parse(JSON.stringify(elements ?? []));
  const used = new Set();
  const newIdByIndex = new Map();
  const renamesByOldId = new Map();

  cloned.forEach((element, index) => {
    if (!element || typeof element !== "object" || !hasOwn(element, "id")) {
      return;
    }
    const oldId = String(element.id);
    const newId = uniqueIdFor(oldId, used);
    element.id = newId;
    newIdByIndex.set(index, newId);
    const bucket = renamesByOldId.get(oldId) ?? [];
    bucket.push(newId);
    renamesByOldId.set(oldId, bucket);
  });

  const indexByOriginalId = new Map();
  (elements ?? []).forEach((element, index) => {
    if (!element || typeof element !== "object" || !hasOwn(element, "id")) {
      return;
    }
    const id = String(element.id);
    if (!indexByOriginalId.has(id)) {
      indexByOriginalId.set(id, []);
    }
    indexByOriginalId.get(id).push(index);
  });

  const mappedReference = (id) => firstMappedId(renamesByOldId, String(id));

  cloned.forEach((element, index) => {
    if (!element || typeof element !== "object") {
      return;
    }

    if (Array.isArray(element.boundElements)) {
      element.boundElements = element.boundElements.map((bound) => ({
        ...bound,
        id: mappedReference(bound.id),
      }));
    }

    if (element.containerId) {
      const original = elements[index];
      let mapped = null;
      for (const containerIndex of indexByOriginalId.get(String(original.containerId)) ?? []) {
        const container = elements[containerIndex];
        if (Array.isArray(container.boundElements) && container.boundElements.some((bound) => bound.id === original.id)) {
          mapped = newIdByIndex.get(containerIndex);
          break;
        }
      }
      element.containerId = mapped ?? mappedReference(element.containerId);
    }

    for (const key of ["startBinding", "endBinding"]) {
      if (element[key]?.elementId) {
        element[key] = { ...element[key], elementId: mappedReference(element[key].elementId) };
      }
    }

    for (const key of ["start", "end"]) {
      if (element[key]?.id) {
        element[key] = { ...element[key], id: mappedReference(element[key].id) };
      }
    }
  });

  return cloned;
}