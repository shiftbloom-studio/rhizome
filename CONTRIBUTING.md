# Contributing to rhizome

Thanks for wanting to help. rhizome is small on purpose: TypeScript on Cloudflare Workers, one runtime dependency (Hono) and no other servers. Please keep it that way.

## Getting started

```sh
git clone https://github.com/shiftbloom-studio/rhizome
cd rhizome
npm install
cp .env.deploy.example .env.deploy   # then fill in your values
npm run config
npx wrangler dev --remote -c wrangler.deploy.jsonc
```

Vectorize and Workers AI have no local emulation, so development runs against your own Cloudflare account. Create your own resources first (see "Self-hosting" in the README).

## Checks

```sh
npm test        # unit tests (vitest)
npm run check   # type check and a wrangler dry-run build
```

CI runs both on every pull request.

## Pull requests

* One topic per pull request, with a short description of what changes and why.
* Changes to the Durable Object schema go into a new entry at the end of `MIGRATIONS` in `src/schema.ts`. Never edit an existing migration.
* Changes to the control plane go into a new numbered file in `migrations/`.
* Never commit secrets, API keys, `.env.deploy` or real memory content.
* Everything in the repository is written in English.

## License

By contributing you agree that your contributions are licensed under the AGPL-3.0-or-later, like the rest of the project.

## Code of conduct

Be kind and assume good intent. We review code like gardeners, not judges. Harassment of any kind is not tolerated; report it to the maintainers through the contact on https://shiftbloom.studio.
