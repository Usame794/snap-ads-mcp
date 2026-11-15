// Ready-made playbooks (MCP prompts). In Claude they appear in the "+" / slash menu. Each one tells the assistant which tools to
// use, in what order, and how to report. They only ever read and preview: applying anything still needs the person's approval.
import { z } from "zod";

const SAFETY =
  "Rules: only read and preview. Do not call any tool with confirm=true. If something should change, show the preview and the approval_token step, and wait for the person to say yes in their own words.";

const user = (text) => ({ messages: [{ role: "user", content: { type: "text", text } }] });

export const PROMPTS = {
  weekly_review: {
    title: "Weekly review",
    description: "Last 7 days vs the 7 before: results, problems, tired ads, pacing, and a short action list.",
    argsSchema: { focus: z.string().max(200).optional().describe("Optional: a campaign name or topic to focus on") },
    text: ({ focus }) =>
      [
        "Do a weekly review of my Snapchat ad account.",
        focus ? `Focus on: ${focus}.` : null,
        "1. snap_ping (which account, which limits).",
        "2. snap_list_campaigns with status ACTIVE, then snap_report_compare for each of them with breakdown adsquad: current = the last 7 full local days (SNAP_REPORT_UTC_OFFSET), previous = the 7 days before. Spend, purchases, ROAS, CPA. Skip campaigns with no spend in either window.",
        "3. snap_health_check for the last 7 days.",
        "4. snap_creative_fatigue for the 3 campaigns with the most spend this week.",
        "5. snap_review_issues, snap_spend_pacing, snap_anomaly_check (did anything change sharply yesterday?) and snap_check_landing_pages (do the links of active ads still open?).",
        "Report in this order: (a) three-line summary with the numbers, (b) what got better / worse and why, (c) problems found, each with the ad squad or ad name, (d) at most 5 actions, most valuable first, each with the exact tool that would do it.",
        "Say that purchases and ROAS are Snap-attributed and can differ from the store's own numbers.",
        SAFETY,
      ]
        .filter(Boolean)
        .join("\n"),
  },
  launch_checklist: {
    title: "Launch checklist",
    description: "Check a paused campaign or ad squad before turning it on: targeting size, pixel, budget, creatives, review status, preview links.",
    argsSchema: { name_or_id: z.string().min(1).max(200).describe("The campaign or ad squad to check (name or id)") },
    text: ({ name_or_id }) =>
      [
        `Run a pre-launch checklist for "${name_or_id}" in my Snapchat ad account.`,
        "1. Find it: snap_list_campaigns or snap_list_adsquads with name_contains, then snap_get_entity.",
        "2. For each ad squad: snap_audience_size (flag VERY_SMALL or SMALL), check the pixel is set and snap_pixel_health is fine, the daily budget and bid against the limits in snap_ping, the countries and the schedule.",
        "3. For each ad: its creative's headline, link and call to action (snap_get_entity), its review status, and a snap_ad_preview link. Then snap_check_landing_pages for the links (it checks all active ads, so look only at the ones of this campaign).",
        "4. Check the parents: an ad squad under a PAUSED campaign will not deliver.",
        "Answer with a checklist: PASS / WARN / FAIL per item, then the preview links, then what to fix first.",
        "If everything passes, show the snap_set_status preview for turning it on (confirm=false) and stop there.",
        SAFETY,
      ].join("\n"),
  },
  replace_tired_ads: {
    title: "Replace tired ads",
    description: "Find ads that are wearing out and draft paused replacements from new media.",
    argsSchema: { campaign: z.string().min(1).max(200).describe("Campaign name or id") },
    text: ({ campaign }) =>
      [
        `Find tired ads in the Snapchat campaign "${campaign}" and plan replacements.`,
        "1. Find the campaign (snap_list_campaigns with name_contains).",
        "2. snap_creative_fatigue for it (last 7 days vs the 7 before). List FATIGUED and WATCH ads with spend, frequency, swipe rate and ROAS change.",
        "3. snap_list_media (newest first) to find media not used yet.",
        "4. For each FATIGUED ad, propose a replacement: which new media, the same headline / link / call to action, and the ad squad. Show the snap_create_creative and snap_create_ad previews (confirm=false). New ads are always created PAUSED.",
        "5. Suggest which tired ads to pause, as snap_set_status previews only.",
        "Ask me which replacements to create before doing anything.",
        SAFETY,
      ].join("\n"),
  },
};

export function registerPrompts(server) {
  for (const [name, p] of Object.entries(PROMPTS)) {
    server.registerPrompt(name, { title: p.title, description: p.description, argsSchema: p.argsSchema }, (args) => user(p.text(args ?? {})));
  }
}
