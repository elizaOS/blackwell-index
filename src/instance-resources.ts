import type { InstanceResources } from "./types";

/** Fixed tuple avoids property-order differences in signed semantic identities. */
export function instanceResourceKey(value: InstanceResources): readonly unknown[] {
  return [value.schemaVersion, value.scope, value.vcpus, value.memoryGiB, value.storageGiB];
}
