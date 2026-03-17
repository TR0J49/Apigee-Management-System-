const pLimit = require("p-limit");

const ALLOWED_KEYWORDS = ["EazyPay", "composite", "CIB", "NPCI", "D365"];

function isAllowedProxy(name) {
  const lower = name.toLowerCase();
  return ALLOWED_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

async function concurrentPool(items, concurrency, fn) {
  const limit = pLimit(concurrency);
  const results = await Promise.allSettled(
    items.map((item) => limit(() => fn(item)))
  );
  return results;
}

module.exports = { ALLOWED_KEYWORDS, isAllowedProxy, concurrentPool };
