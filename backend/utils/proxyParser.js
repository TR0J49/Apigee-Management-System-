// ============================================================
// NEW FILE: proxyParser.js
// PURPOSE: Parse Apigee proxy bundle ZIP in memory
//          Extracts BasePath, VirtualHosts, Flows, Policies
//          from apiproxy/proxies/*.xml files
// CALLED BY: inventoryRoutes.js when revision inventory is requested
// ============================================================

const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["Flow", "Step", "VirtualHost", "RouteRule"].includes(name),
});

// --- Extract path suffixes from Apigee flow conditions ---
// e.g. '(proxy.pathsuffix MatchesPath "/users") and (request.verb = "GET")'
//       → ["/users"]
function findPathsFromCondition(condition) {
  const paths = [];
  // Match quoted strings after MatchesPath or proxy.pathsuffix ~
  const regex = /(?:MatchesPath|proxy\.pathsuffix\s*(?:~|Matches|MatchesPath))\s*"([^"]+)"/gi;
  let match;
  while ((match = regex.exec(condition)) !== null) {
    paths.push(match[1]);
  }
  // Also match JavaRegex patterns
  const regexPattern = /proxy\.pathsuffix\s*(?:JavaRegex|~~)\s*"([^"]+)"/gi;
  while ((match = regexPattern.exec(condition)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

// --- Extract policy names from Step elements (PreFlow/PostFlow/Flow) ---
function extractStepPolicies(stepContainer) {
  if (!stepContainer) return [];
  const policies = [];

  const processSteps = (section) => {
    if (!section || !section.Step) return;
    const steps = Array.isArray(section.Step) ? section.Step : [section.Step];
    for (const step of steps) {
      if (step && step.Name) policies.push(step.Name);
    }
  };

  processSteps(stepContainer.Request);
  processSteps(stepContainer.Response);
  return policies;
}

// --- Main: Parse a ZIP buffer and return structured inventory ---
function parseProxyBundle(zipBuffer) {
  if (!zipBuffer || zipBuffer.length === 0) {
    throw new Error("parseProxyBundle: empty or null ZIP buffer");
  }

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  if (entries.length === 0) {
    throw new Error("parseProxyBundle: ZIP contains no entries");
  }

  console.log(`parseProxyBundle: ZIP has ${entries.length} entries, scanning for apiproxy/ files...`);

  const result = {
    proxyEndpoints: [],   // Each proxy XML file's parsed data
    basePaths: [],
    virtualHosts: [],
    flows: [],            // All flows with conditions & paths
    policies: [],         // All policy names found in policies/ folder
    usedPolicies: [],     // Policies actually referenced in proxy flows
    targetEndpoints: [],  // Target endpoint names
  };

  // --- 1. Parse apiproxy/proxies/*.xml (Proxy Endpoints) ---
  // Also handle backslash paths (Windows ZIP tools may use backslashes)
  const proxyXmlEntries = entries.filter(
    (e) => e.entryName.replace(/\\/g, "/").match(/apiproxy\/proxies\/[^/]+\.xml$/)
  );
  console.log(`parseProxyBundle: found ${proxyXmlEntries.length} proxy XML file(s)`);

  for (const entry of proxyXmlEntries) {
    try {
      const xml = entry.getData().toString("utf8");
      const parsed = xmlParser.parse(xml);
      const pe = parsed.ProxyEndpoint;
      if (!pe) continue;

      const fileName = entry.entryName.split("/").pop().replace(".xml", "");

      // BasePath & VirtualHost
      const basePath = pe.HTTPProxyConnection?.BasePath || "/";
      let vhosts = pe.HTTPProxyConnection?.VirtualHost || [];
      if (!Array.isArray(vhosts)) vhosts = [vhosts];

      result.basePaths.push(basePath);
      result.virtualHosts.push(...vhosts);

      // Collect policies from PreFlow, PostFlow
      const preFlowPolicies = extractStepPolicies(pe.PreFlow);
      const postFlowPolicies = extractStepPolicies(pe.PostFlow);
      result.usedPolicies.push(...preFlowPolicies, ...postFlowPolicies);

      // Parse Flows
      let flows = [];
      if (pe.Flows && pe.Flows !== "" && pe.Flows.Flow) {
        flows = Array.isArray(pe.Flows.Flow) ? pe.Flows.Flow : [pe.Flows.Flow];
      }

      let flowFound = false;
      for (const flow of flows) {
        const flowName = flow["@_name"] || "";
        const condition = flow.Condition ? flow.Condition.toString() : "";
        const flowPolicies = extractStepPolicies(flow);
        result.usedPolicies.push(...flowPolicies);

        const hasPathSuffix = condition.toLowerCase().includes("proxy.pathsuffix");
        let pathSuffix = "";
        let fullPath = basePath;

        if (hasPathSuffix) {
          const paths = findPathsFromCondition(condition);
          pathSuffix = paths.join("/");
          if (pathSuffix) fullPath = basePath + (pathSuffix.startsWith("/") ? "" : "/") + pathSuffix;
        }

        result.flows.push({
          name: flowName,
          condition: condition,
          pathSuffix: pathSuffix,
          fullPath: fullPath,
          basePath: basePath,
          hasPathSuffix: hasPathSuffix ? "y" : "n",
          policies: flowPolicies,
          proxyEndpointFile: fileName,
        });
        flowFound = true;
      }

      // If no flows with conditions, add a single entry for the base path
      if (!flowFound) {
        result.flows.push({
          name: fileName,
          condition: "",
          pathSuffix: "",
          fullPath: basePath,
          basePath: basePath,
          hasPathSuffix: "n",
          policies: [],
          proxyEndpointFile: fileName,
        });
      }

      // RouteRules
      let routeRules = pe.RouteRule || [];
      if (!Array.isArray(routeRules)) routeRules = [routeRules];
      for (const rr of routeRules) {
        if (rr && rr.TargetEndpoint) {
          result.targetEndpoints.push(rr.TargetEndpoint);
        }
      }

      result.proxyEndpoints.push(fileName);
    } catch (err) {
      // Skip malformed XML files
      console.error(`Failed to parse ${entry.entryName}:`, err.message);
    }
  }

  // --- 2. Scan apiproxy/policies/*.xml for all policy names ---
  const policyEntries = entries.filter(
    (e) => e.entryName.replace(/\\/g, "/").match(/apiproxy\/policies\/[^/]+\.xml$/)
  );
  for (const entry of policyEntries) {
    const policyName = entry.entryName.split("/").pop().replace(".xml", "");
    result.policies.push(policyName);
  }

  // --- 3. Scan apiproxy/targets/*.xml for target endpoint names ---
  const targetEntries = entries.filter(
    (e) => e.entryName.replace(/\\/g, "/").match(/apiproxy\/targets\/[^/]+\.xml$/)
  );
  for (const entry of targetEntries) {
    try {
      const xml = entry.getData().toString("utf8");
      const parsed = xmlParser.parse(xml);
      const te = parsed.TargetEndpoint;
      if (te && te.HTTPTargetConnection && te.HTTPTargetConnection.URL) {
        const targetName = entry.entryName.split("/").pop().replace(".xml", "");
        if (!result.targetEndpoints.includes(targetName)) {
          result.targetEndpoints.push(targetName);
        }
      }
    } catch (err) {
      // Skip
    }
  }

  // Deduplicate
  result.virtualHosts = [...new Set(result.virtualHosts)];
  result.usedPolicies = [...new Set(result.usedPolicies)];
  result.policies = [...new Set(result.policies)];
  result.targetEndpoints = [...new Set(result.targetEndpoints)];
  result.proxyEndpoints = [...new Set(result.proxyEndpoints)];
  result.basePaths = [...new Set(result.basePaths)];

  return result;
}

module.exports = { parseProxyBundle };
