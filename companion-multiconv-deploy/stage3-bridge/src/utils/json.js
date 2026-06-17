function parseJsonObject(raw, fallback = {}) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function stringifyMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) return null;
  return JSON.stringify(meta);
}

module.exports = { parseJsonObject, stringifyMeta };
