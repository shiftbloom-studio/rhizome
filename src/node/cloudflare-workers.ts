// SPDX-License-Identifier: AGPL-3.0-or-later
// Stand-in for the "cloudflare:workers" module when rhizome runs on Node.
// The build aliases the import to this file (see scripts/build-node.mjs).
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: Env,
  ) {}
}
