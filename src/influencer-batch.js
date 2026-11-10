// Run the influencer ad-code flow for several codes into one ad squad. Each item is independent.
import { runInfluencerFlow, validateAdCode } from "./influencer.js";

export const MAX_BATCH = 10;
const EXPIRED = /expired|not found|revoked|Invalid code|already claimed/i;

export function checkBatch(items) {
  if (!Array.isArray(items) || !items.length) throw new Error("Provide at least one item");
  if (items.length > MAX_BATCH) throw new Error(`Too many items (${items.length}, limit ${MAX_BATCH})`);
  const seen = new Set();
  return items.map((it, i) => {
    const name = String(it.name ?? "").trim();
    if (name.length < 3) throw new Error(`Item ${i + 1}: name is required`);
    const code = validateAdCode(it.ad_code);
    if (seen.has(code)) throw new Error(`Item ${i + 1}: duplicate ad code`);
    seen.add(code);
    return { name, ad_code: code, ref: it.ref ?? name };
  });
}

export async function runBatch({ client, adAccountId, profileId, adSquadId, headline, callToAction, url, items, logFile, sleep, timeoutMs }) {
  const results = [];
  for (const it of checkBatch(items)) {
    try {
      const done = await runInfluencerFlow({ client, adAccountId, profileId, adCode: it.ad_code, adSquadId, name: it.name, headline, callToAction, url, logFile, sleep, timeoutMs });
      results.push({ ref: it.ref, result: "created", ...done });
    } catch (e) {
      const claimed = Boolean(e.done?.media_id);
      results.push({ ref: it.ref, result: claimed ? "claimed_but_incomplete" : EXPIRED.test(e.message) ? "code_unusable" : "failed", message: e.message.slice(0, 220), ...(claimed ? e.done : {}) });
      if (claimed) break; // a claimed-but-broken item needs a look before spending more codes
    }
  }
  const count = (r) => results.filter((x) => x.result === r).length;
  return { created: count("created"), code_unusable: count("code_unusable"), failed: count("failed"), incomplete: count("claimed_but_incomplete"), stopped_early: results.length < items.length, results };
}
