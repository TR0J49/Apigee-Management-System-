const pLimit = require("p-limit");

const ALLOWED_PROXIES = ["EazyPay", "Composite", "CIB", "NPCI", "D365"];
const ALLOWED_SHAREDFLOWS = ["PreFlow", "Security-Flow", "Encryption-Flow", "Hybrid-Decryption", "Symmetric"];

function isAllowedProxy(name) {
  return ALLOWED_PROXIES.includes(name);
}

async function concurrentPool(items, concurrency, fn) {
  const limit = pLimit(concurrency);
  const results = await Promise.allSettled(
    items.map((item) => limit(() => fn(item)))
  );

  return results;
}

module.exports = { ALLOWED_PROXIES, ALLOWED_SHAREDFLOWS, isAllowedProxy, concurrentPool };
