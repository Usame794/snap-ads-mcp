// Turns an HTTP status from Snap into one short sentence saying what to do next. Appended to Snap's own message, never replacing it.
export function fixFor(status, { retryAfter = null } = {}) {
  const s = Number(status);
  if (s === 400 || s === 422) return "Fix: check the values you sent (ids, dates on the hour, budgets as numbers). Run the tool without confirm to see a preview first.";
  if (s === 401) return "Fix: the Snapchat login is no longer valid. Run `npx -y ads-mcp-for-snapchat setup` again, or ask Claude to connect the ad account.";
  if (s === 403) return "Fix: this Snapchat login has no permission for that item. Ask an Admin of the organization to give you access in Ads Manager (Members), or use a login that has it.";
  if (s === 404) return "Fix: Snap does not know that id in this ad account. Get the id from the matching snap_list_* tool and check it belongs to the account set in SNAP_AD_ACCOUNT_ID.";
  if (s === 409) return "Fix: the item changed or already exists. Read it again (snap_get_entity) and repeat the request with the current values.";
  if (s === 429) return `Fix: Snap's rate limit was reached. Wait ${retryAfter && retryAfter > 0 ? `about ${Math.ceil(retryAfter)} seconds` : "a minute"} and try again; run fewer requests at once.`;
  if (s >= 500) return "Fix: Snap had a problem on its side. Wait a minute and try again; if it keeps failing, check Snap's status page.";
  return "";
}
