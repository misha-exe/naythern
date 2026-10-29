# Bluebee v2 - super admin + publisher workspaces

## How it works
```
Super admin (env login)
  └─ Publisher (workspace)  ── plan limits: posts/month, X accounts, team size ── status: active/suspended
       ├─ Owner   : manages X accounts + team, posts with every account
       ├─ Editor  : posts only with the X accounts assigned to them
       ├─ Viewer  : read-only
       └─ X accounts: label, Ads account ID, encrypted auth_token + ct0
```
* **Account switching:** the Composer dropdown is filled from `/api/me/accounts`, which returns only the accounts the signed-in
  user may use. Uploads, the media library and Publish all send that `accountId`; the server re-checks access every time and
  builds the X client from THAT account's Ads ID and cookies.
* **Super admin:** signs in with `AUTH_EMAIL` / `AUTH_PASSWORD_HASH`. Creates publishers (+ owner), resets passwords,
  sets limits, suspends, sends announcements, and can **Open** a publisher's workspace (acts as its owner; "Exit workspace" returns).
* **Security:** every request re-loads the user + workspace (suspension/role changes apply instantly), cookies are encrypted
  (AES-256-GCM), passwords are scrypt hashes, history/media/accounts are scoped by publisher, URL uploads block private addresses.

## Setup
1. Replace your project files with this folder (keep `services/twitterClient.js`; it is unchanged).
2. Vercel -> Storage -> add **Upstash Redis** (sets `KV_REST_API_URL` / `KV_REST_API_TOKEN`).
3. Set env vars from `.env.example` (`npm run hash-password` makes `AUTH_PASSWORD_HASH`). Remove the old single-account `TWITTER_*` vars except `TWITTER_ADS_BEARER`.
4. Deploy. Sign in as super admin -> Publishers -> create one -> **Open** -> X Accounts -> add accounts -> Team -> add editors.
5. `npm test` runs an offline self-test of roles, isolation, limits and suspension.

Old data (`share2x_media_library`, old history) is not migrated; re-upload media per account.
