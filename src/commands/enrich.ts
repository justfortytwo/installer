// enrich — deepen the persona by capturing more answers over time.
//
// init captures the minimum to boot. enrich is the ongoing "tell the assistant
// more about yourself / refine its persona" loop. It mutates the `enrichment`
// block of .fortytwo/identity.json, then re-renders the persona.
//
// CRITICAL idempotence guarantee: re-rendering MUST NOT clobber fields the user
// already captured or hand-edited. render.ts only overwrites MANAGED outputs and
// write-once-protects CAPTURED ones, so enrich is safe to run repeatedly.

import { readIdentity, writeIdentity, type Identity } from '../state.js';
import { renderPersona } from '../render.js';

export async function runEnrich(_argv: string[]): Promise<number> {
  // TODO(impl):
  //   const identity = readIdentity()  // require init has run
  //   prompt for (or take from flags) additional persona answers; MERGE into
  //     identity.enrichment without dropping existing keys.
  //   writeIdentity(identity)          // stamps updatedAt
  //   renderPersona(identity)          // idempotent re-render; reports written/skipped
  //   print which context files changed.
  void readIdentity; void writeIdentity; void renderPersona;
  void (null as unknown as Identity);
  throw new Error('TODO(impl): runEnrich — capture more answers, merge into identity.json, re-render persona');
}
