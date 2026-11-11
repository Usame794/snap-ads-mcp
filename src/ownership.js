// Every write must target the configured ad account. The account is resolved from the object itself (campaign, creative,
// segment) or by walking up to its campaign (ad squad, ad). Anything that cannot be verified is refused.
export class Ownership {
  constructor(client) {
    this.client = client;
    this.campaignAccount = new Map();
    this.squadCampaign = new Map();
  }

  async accountOfCampaign(campaignId) {
    if (!campaignId) return null;
    if (!this.campaignAccount.has(campaignId)) {
      const c = await this.client.getEntity("campaign", campaignId);
      this.campaignAccount.set(campaignId, c.ad_account_id ?? null);
    }
    return this.campaignAccount.get(campaignId);
  }

  async accountOf(entity, obj) {
    if (!obj) return null;
    if (entity === "campaign") {
      if (obj.id && obj.ad_account_id) this.campaignAccount.set(obj.id, obj.ad_account_id);
      return obj.ad_account_id ?? null;
    }
    if (entity === "creative" || entity === "segment" || entity === "media") return obj.ad_account_id ?? null;
    if (entity === "adsquad") return this.accountOfCampaign(obj.campaign_id);
    if (entity === "ad") {
      const squadId = obj.ad_squad_id;
      if (!squadId) return null;
      if (!this.squadCampaign.has(squadId)) this.squadCampaign.set(squadId, (await this.client.getEntity("adsquad", squadId)).campaign_id ?? null);
      return this.accountOfCampaign(this.squadCampaign.get(squadId));
    }
    return null;
  }

  async assert(entity, obj, expectedAccount) {
    const actual = await this.accountOf(entity, obj);
    const label = `${entity} ${obj?.id ?? "?"}`;
    if (!actual) throw new Error(`Cannot verify which ad account ${label} belongs to; refusing to change it.`);
    if (actual !== expectedAccount) throw new Error(`${label} belongs to another ad account, not the configured SNAP_AD_ACCOUNT_ID; refusing to change it.`);
  }
}
