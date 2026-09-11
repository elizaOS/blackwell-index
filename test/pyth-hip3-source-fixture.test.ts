import { expect, test } from "bun:test";
import { hip3SourceFixture } from "./pyth-hip3-source-fixture";

test("HIP-3 local fixture uses the calculated scoped SBX value and original source time", () => {
  const fixture = hip3SourceFixture();
  const accepted = fixture.cases.filter(c => c.eligible);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({ name: "eligible_b200", feedId: "SBX:B200", price: "3.123457", observedAt: fixture.now - 1000, calculatedAt: fixture.now, inputBatchCount: 3 });
  expect(fixture.cases.filter(c => !c.eligible).map(c => c.name)).toEqual([
    "missing_fixed_constituent", "draft_methodology", "stale_source", "invalid_signatures", "outside_approved_scope",
  ]);
});
