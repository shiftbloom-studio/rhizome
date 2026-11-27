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

To measure a change to extraction or recall, run the LongMemEval benchmark on the `bench` branch before and after it and compare the two runs ([bench/README.md](https://github.com/shiftbloom-studio/rhizome/blob/bench/bench/README.md)).

## Pull requests

* One topic per pull request, with a short description of what changes and why.
* Changes to the Durable Object schema go into a new entry at the end of `MIGRATIONS` in `src/schema.ts`. Never edit an existing migration.
* Changes to the control plane go into a new numbered file in `migrations/`.
* Never commit secrets, API keys, `.env`, `.env.deploy`, `data/` or real memory content.
* Everything in the repository is written in English.

## Working on an issue

Issues labeled `good first issue` or `help wanted` are open to anyone. Before you write code:

1. Comment on the issue and say how you plan to approach it: the files you expect to touch, and anything you would do differently from what the issue suggests. A few sentences are enough.
2. Wait until a maintainer assigns the issue to you. That way two people don't build the same thing, and we can point out a dead end before you spend an evening on it.
3. Open the pull request and link the issue (`Closes #123`).

Typo fixes and other small, obvious changes can go straight to a pull request.

If an assigned issue sees no activity for 14 days, we'll check in and may hand it to someone else. You're welcome to pick it up again later.

## Using AI tools

You're welcome to use AI assistants, the same way you'd use an editor or a linter. We only ask that a person stands behind every contribution:

- You have read and understood every line you submit, and you ran the checks yourself.
- You answer review questions in your own words and can change the code when we ask.
- The pull request description explains what you decided and why. The diff already shows what changed.

Issues, comments and pull requests that an agent wrote and posted on its own, with nobody actually involved, will be closed. This isn't about the tool. We'd like to get to know the people who work on this project.

## License

By contributing you agree that your contributions are licensed under the AGPL-3.0-or-later, like the rest of the project.

## Code of conduct

Be kind and assume good intent. We review code like gardeners, not judges. Harassment of any kind is not tolerated; report it to safety@shiftbloom.studio.
