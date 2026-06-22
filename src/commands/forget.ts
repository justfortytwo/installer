// forget — redact/remove specific memories from the memory MCP store.
//
// The data-hygiene verb: the owner asks the assistant to forget something
// (a person, a topic, a date range, a specific entry). This is a privileged
// operation against the canonical memory store, distinct from the assistant's
// own turn-time memory writes.

export async function runForget(_argv: string[]): Promise<number> {
  // TODO(wire): delegate to @justfortytwo/memory's deletion/redaction surface.
  //   Selectors to support (from flags): --id <entryId>, --query <text> (semantic
  //   match then confirm), --since/--until (date range), --entity <name>.
  //   Flow: resolve matches -> show a confirmation summary (count + preview) ->
  //   require explicit --yes or interactive confirm -> delete from the store AND
  //   any derived indexes (FTS + embeddings) so recall can't resurface them.
  //   Report how many entries were removed.
  throw new Error('TODO(wire): runForget — redact/delete matched memories via @justfortytwo/memory');
}
