# Message to Snap (before announcing the shared login)

Send this through Snap's developer or Business support. Replace the placeholders. Attach the privacy page address of the deployed service.

**Subject:** Question about a shared OAuth app for an open-source Marketing API tool

Hello,

I maintain an open-source, unofficial tool called "Ads MCP for Snapchat" (https://github.com/Usame794/snap-ads-mcp). It runs on each advertiser's own computer and lets an AI assistant read reports and make previewed, approved changes to the advertiser's **own** ad account through the Marketing API. It is not affiliated with Snap Inc.

Today each advertiser creates their own OAuth app. To make setup easier I built an optional login service (code in the `broker` folder of the repository, privacy page: [PRIVACY PAGE ADDRESS]) that uses **one shared OAuth app**:

- An advertiser logs in with Snapchat and approves the app, as with any OAuth app.
- The service exchanges the code for a refresh token using the app's secret, and immediately **seals the token to a key that exists only on the advertiser's own computer**, then redirects to that computer (127.0.0.1). It stores no tokens, no ad account data and no logs.
- Later the advertiser's computer sends its refresh token to the service to get a short-lived access token (that step needs the secret).
- All Marketing API calls are made directly from the advertiser's computer to Snap. The service never reads ad account data.

My questions:
1. May an OAuth app owned by me be used by advertisers outside my own organization in this way? Does the app need review, approval or allowlisting before other advertisers can authorize it?
2. Are there requirements for such an app (privacy policy, data retention, security measures, a terms acknowledgement) beyond the Developer Terms and Business Tools Terms that I should meet?
3. Are there restrictions on open-source tools that let an AI assistant make changes to ad accounts, beyond the existing API terms? The tool shows a preview and needs the advertiser's approval for every change, enforces spend limits the advertiser sets, and creates everything paused.
4. Is the shared-app design acceptable, or would you prefer that each advertiser registers their own app?

Thank you,
[YOUR NAME]
[YOUR BUSINESS / CONTACT]
