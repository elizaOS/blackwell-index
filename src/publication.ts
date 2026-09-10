/** Scope changes never supply source rights, methodology approval or delivery approval. */
import { z } from "zod";
import type { PublicationScope, Snapshot } from "./types";

export const publicationScopeSchema = z.strictObject({ kind: z.literal("MODEL"), model: z.literal("B200") });
export const methodologyPublicationScopeSchema = publicationScopeSchema.extend({
  approvalEvidence: z.string().min(1).max(4000).refine(value => Boolean(value.trim()), "Publication scope requires approval evidence"),
});

export function parsePublicationScope(value: unknown): PublicationScope | undefined {
  return value === undefined ? undefined : publicationScopeSchema.parse(value);
}

/** Both sides must explicitly select the same policy; omission is never an upgrade. */
export function assertSnapshotPublicationScope(snapshot: Snapshot, expected: PublicationScope | undefined): void {
  const actual = parsePublicationScope(snapshot.publicationScope), scope = parsePublicationScope(expected);
  if (Boolean(actual) !== Boolean(scope) || actual?.kind !== scope?.kind || actual?.model !== scope?.model) {
    throw new Error("Snapshot publication scope does not match the approved delivery scope");
  }
  if (actual) {
    const matches = snapshot.feeds.filter(feed => feed.id === `SBX:${actual.model}`);
    if (matches.length !== 1 || matches[0]!.kind !== "MODEL" || matches[0]!.model !== actual.model || matches[0]!.provider !== null) {
      throw new Error("Invalid scoped publication feed identity");
    }
  }
}

export function isFeedPublishable(snapshot: Snapshot, feedId: string): boolean {
  if (!snapshot.publishable) return false;
  const scope = parsePublicationScope(snapshot.publicationScope);
  // Preserve the historical API meaning for snapshots without a scope.
  if (!scope) return true;
  assertSnapshotPublicationScope(snapshot, scope);
  const feed = snapshot.feeds.find(value => value.id === feedId);
  return feedId === `SBX:${scope.model}` && feed?.status === "READY" && feed.price !== null && feed.observedAt !== null;
}
