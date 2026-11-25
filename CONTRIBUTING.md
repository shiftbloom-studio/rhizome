# Contributing to rhizome

Thanks for wanting to help. rhizome is small on purpose: TypeScript written for Cloudflare Workers, Hono as its only framework, and a thin Node runtime (`src/node/`) that stands in for the Cloudflare bindings. Please keep it that way.

## Getting started

The quickest way is the Node runtime with a local model server such as Ollama:

```sh
git clone https://github.com/shiftbloom-studio/rhizome
cd rhizome
npm run setup
cp .env.example .env    # then fill in your values
npm run local
```

To work on the Worker itself, run it against your own Cloudflare account, because Vectorize and Workers AI have no local emulation. Create your own resources first (see "Run it on Cloudflare" in the README).

```sh
cp .env.deploy.example .env.deploy   # then fill in your values
npm run dev
```

Code in `src/` must keep running on both. Anything Node-only belongs in `src/node/`, and the Worker must never import it.

## Checks

```sh
npm test        # unit tests (vitest)
npm run check   # type check and a wrangler dry-run build
npm run build:node   # bundle the Node server
```

CI runs both on every pull request.

## Pull requests

* One topic per pull request, with a short description of what changes and why.
* Changes to the Durable Object schema go into a new entry at the end of `MIGRATIONS` in `src/schema.ts`. Never edit an existing migration.
* Changes to the control plane go into a new numbered file in `migrations/`.
* Never commit secrets, API keys, `.env`, `.env.deploy`, `data/` or real memory content.
* Everything in the repository is written in English.

## License

By contributing you agree that your contributions are licensed under the AGPL-3.0-or-later, like the rest of the project.

## Code of conduct

Be kind and assume good intent. We review code like gardeners, not judges. Harassment of any kind is not tolerated; report it to safety@shiftbloom.studio.
