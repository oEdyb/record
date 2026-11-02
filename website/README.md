# klippt.app

The Klippt marketing site: Docusaurus, built to static files and hosted on Cloudflare Pages.

```bash
npm ci
npm run dev        # local preview
npm run build      # static build in build/
npm run deploy     # build and check; refuses while any page carries KLIPPT-DRAFT
npm run deploy -- --yes   # upload to the Cloudflare Pages project "klippt" (owner only)
```

- The download page reads `https://updates.dyberg.co/klippt/latest.json` in the browser. The R2
  bucket needs a CORS rule that allows `GET` from `https://klippt.app`.
- `static/_headers` sets the security headers Cloudflare Pages serves.
