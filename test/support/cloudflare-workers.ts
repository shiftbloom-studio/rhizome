// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal stand-in for the "cloudflare:workers" module in unit tests.
export class DurableObject<Env = unknown> {
  constructor(
    public ctx: unknown,
    public env: Env,
  ) {}
}
export class WorkflowEntrypoint {}
