import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeTransactions, backtestTransactions, ResearchConfig, TransactionRecord } from "../src/transaction-research";

// Synthetic unit-test fixtures only. Never exported as observations or live data.
const record = (overrides = {}) => ({schemaVersion:1,source:"test-source",economicProvider:"provider-a",buyerId:"buyer-a",dealId:"deal-a",segmentId:"segment-a",revision:0,recordedAt:7200000,evidenceState:"DELIVERED",evidenceHash:"a".repeat(64),model:"B200",sku:"test-sku",region:"test-region",bundle:"test-bundle",topology:"HGX",currency:"USD",procurement:"ON_DEMAND",tenancy:"EXCLUSIVE",gpuCount:1,serviceStart:0,serviceEnd:3600000,grossComputeUsd:"2",discountUsd:"0",refundUsd:"0",mandatoryComputeFeesUsd:"0",netComputeUsd:"2",invoiceId:null,invoiceEvidenceHash:null,paidAllocatedUsd:null,paymentEvidenceHash:null,affiliated:false,cancelled:false,...overrides});
const config = (overrides = {}) => ({schemaVersion:1,asOf:7200000,windowStart:0,windowEnd:7200000,model:"B200",region:"test-region",bundle:"test-bundle",topology:"HGX",procurement:"ON_DEMAND",minimumEvidence:"DELIVERED",minProviders:2,minBuyers:2,minGpuHours:1,maxProviderShareBps:9000,maxBuyerShareBps:9000,winsorBps:500,permissions:[{source:"test-source",agreementId:"test-only",evidenceHash:"b".repeat(64),evaluationAllowed:true,validFrom:0,expiresAt:9000000}],...overrides});
const pair = () => [record(),record({economicProvider:"provider-b",buyerId:"buyer-b",dealId:"deal-b",gpuCount:3,grossComputeUsd:"12",netComputeUsd:"12"})];

describe("private transaction research", () => {
  test("weights delivered GPU-hours rather than row counts", () => {
    const report = analyzeTransactions(pair(),config());
    expect(report.candidateEstimates?.vwap).toBe("3.500000");
    expect(report.candidateEstimates?.weightedMedian).toBe("4.000000");
    expect(report.maxProviderShareBps).toBe(7500);
    expect(report.effectiveProviderCount).toBe(1.6);
    expect(report.leaveOneProviderOut).toEqual(["4.000000","2.000000"]);
    expect(report.publishable).toBe(false);
    expect(report.status).toBe("RESEARCH_ONLY");
    expect(JSON.stringify(report)).not.toContain("buyer-a");
  });
  test("empty input is unavailable, not zero price", () => {
    const r=analyzeTransactions([],config());
    expect(r.status).toBe("INSUFFICIENT_DATA"); expect(r.candidateEstimates).toBeNull();
  });
  test("fails closed without an evaluation license", () => {
    expect(()=>analyzeTransactions(pair(),config({permissions:[]}))).toThrow("permission");
  });
  test("permission expiry and duplicate sources fail closed", () => {
    const c=config(); c.permissions[0]!.expiresAt=c.asOf;
    expect(()=>analyzeTransactions(pair(),c)).toThrow("permission");
    expect(ResearchConfig.safeParse(config({permissions:[...config().permissions,...config().permissions]})).success).toBe(false);
  });
  test("duplicate polls and reseller duplicates cannot create volume", () => {
    expect(()=>analyzeTransactions([record(),record()],config())).toThrow("Duplicate");
    expect(()=>analyzeTransactions([record({revision:2}),record(),record()],config())).toThrow("Duplicate");
  });
  test("higher revision replaces rather than adds quantity", () => {
    const r=analyzeTransactions([...pair(),record({revision:1,grossComputeUsd:"4",netComputeUsd:"4"})],config());
    expect(r.acceptedSegments).toBe(2); expect(r.supersededRecords).toBe(1);
    expect(r.candidateEstimates?.vwap).toBe("4.000000");
  });
  test("half-hour segments use duration rather than GPU count alone", () => {
    const r=analyzeTransactions([record(),record({economicProvider:"provider-b",buyerId:"buyer-b",dealId:"b",gpuCount:1,serviceEnd:1800000,grossComputeUsd:"4",netComputeUsd:"4"})],config());
    expect(r.candidateEstimates?.vwap).toBe("4.000000");
  });
  test("row order does not change revision selection or estimators", () => {
    const records=[...pair(),record({revision:2,grossComputeUsd:"6",netComputeUsd:"6"})];
    expect(analyzeTransactions(records,config()).candidateEstimates).toEqual(analyzeTransactions(records.reverse(),config()).candidateEstimates);
  });
  test("cancelled corrections remove old delivered quantity", () => {
    const r=analyzeTransactions([...pair(),record({revision:1,cancelled:true})],config());
    expect(r.acceptedSegments).toBe(1); expect(r.status).toBe("INSUFFICIENT_DATA");
  });
  test("future corrections cannot leak into an as-of calculation", () => {
    const r=analyzeTransactions([...pair(),record({revision:1,recordedAt:8000000,grossComputeUsd:"4",netComputeUsd:"4"})],config());
    expect(r.candidateEstimates?.vwap).toBe("3.500000"); expect(r.excluded.AFTER_AS_OF).toBe(1);
  });
  test("overlapping segments require upstream allocation", () => {
    expect(()=>analyzeTransactions([record(),record({segmentId:"second",serviceStart:1800000,serviceEnd:5400000})],config())).toThrow("Overlapping");
  });
  test("partial windows are not silently prorated", () => {
    const r=analyzeTransactions(pair(),config({windowStart:1000}));
    expect(r.excluded.INTERVAL_REQUIRES_METERED_SPLIT).toBe(2); expect(r.candidateEstimates).toBeNull();
  });
  test("invoice and payment claims require corresponding evidence", () => {
    expect(TransactionRecord.safeParse(record({evidenceState:"INVOICED"})).success).toBe(false);
    expect(TransactionRecord.safeParse(record({evidenceState:"PAID",invoiceId:"invoice",invoiceEvidenceHash:"c".repeat(64),paidAllocatedUsd:"1",paymentEvidenceHash:"d".repeat(64)})).success).toBe(false);
    expect(TransactionRecord.safeParse(record({evidenceState:"PAID",invoiceId:"invoice",invoiceEvidenceHash:"c".repeat(64),paidAllocatedUsd:"2",paymentEvidenceHash:"d".repeat(64)})).success).toBe(true);
  });
  test("discounts refunds and mandatory fees reconcile exactly", () => {
    expect(TransactionRecord.safeParse(record({grossComputeUsd:"4",discountUsd:"1",refundUsd:"2",mandatoryComputeFeesUsd:"1"})).success).toBe(true);
    expect(TransactionRecord.safeParse(record({discountUsd:"1"})).success).toBe(false);
  });
  test("zero charge, affiliations and lower evidence are excluded", () => {
    const r=analyzeTransactions([record({affiliated:true}),record({dealId:"b",evidenceState:"ORDER"}),record({dealId:"c",grossComputeUsd:"0",netComputeUsd:"0"})],config());
    expect(r.acceptedSegments).toBe(0); expect(r.excluded.ZERO_NET_CHARGE).toBe(1);
  });
  test.each(["model","region","bundle","topology","procurement","tenancy"])("keeps %s cohorts separate", key => {
    const values:Record<string,string>={model:"B300",region:"other",bundle:"other",topology:"NVL72",procurement:"RESERVED",tenancy:"FRACTIONAL"};
    expect(analyzeTransactions([record({[key]:values[key]})],config()).excluded.COHORT_MISMATCH).toBe(1);
  });
  test("concentration gate uses exact quantities", () => {
    const r=analyzeTransactions(pair(),config({maxProviderShareBps:7499,maxBuyerShareBps:7499}));
    expect(r.status).toBe("INSUFFICIENT_DATA"); expect(r.reasons).toContain("PROVIDER_CONCENTRATION"); expect(r.reasons).toContain("BUYER_CONCENTRATION");
  });
  test("winsorization is parameterized and reproducible", () => {
    const r=analyzeTransactions(pair(),config({winsorBps:3000}));
    expect(r.candidateEstimates?.winsorizedVwap).toBe("4.000000");
  });
  test("schema rejects unknown fields invalid currency and zero duration", () => {
    expect(TransactionRecord.safeParse(record({secret:"unwanted"})).success).toBe(false);
    expect(TransactionRecord.safeParse(record({currency:"EUR"})).success).toBe(false);
    expect(TransactionRecord.safeParse(record({serviceEnd:0})).success).toBe(false);
  });
  test("backtest reports missing windows without filling gaps", () => {
    const r=backtestTransactions(pair(),[config(),config({windowStart:7200000,windowEnd:8000000,asOf:8000000})]);
    expect(r.missingWindows).toBe(1); expect(r.coverageBps).toBe(5000); expect(r.publishable).toBe(false);
  });
  test("backtest rejects changing weights or overlapping windows", () => {
    expect(()=>backtestTransactions(pair(),[config(),config()])).toThrow("non-overlapping");
    expect(()=>backtestTransactions(pair(),[config(),config({winsorBps:1000})])).toThrow("fixed");
  });
  test("CLI rejects input without leaking file paths or private contents", async () => {
    const child=Bun.spawn([process.execPath,"scripts/transaction-research.ts","/missing/private-invoice.json","/missing/private-config.json","/missing/private-report.json"],{stdout:"pipe",stderr:"pipe"});
    const error=await new Response(child.stderr).text();
    expect(await child.exited).toBe(1); expect(error).toContain("Research input rejected"); expect(error).not.toContain("private-invoice");
  });
  test("CLI writes private new-only output and does not print prices", async () => {
    const dir=mkdtempSync(join(tmpdir(),"sbx-transaction-test-"));
    try {
      const records=join(dir,"records.json"), settings=join(dir,"config.json"), output=join(dir,"report.json");
      writeFileSync(records,JSON.stringify(pair()),{mode:0o600});
      writeFileSync(settings,JSON.stringify(config()),{mode:0o600});
      const run=()=>Bun.spawn([process.execPath,"scripts/transaction-research.ts",records,settings,output],{stdout:"pipe",stderr:"pipe"});
      const first=run(); const stdout=await new Response(first.stdout).text();
      expect(await first.exited).toBe(0); expect(stdout).not.toContain("3.500000");
      expect(statSync(output).mode & 0o777).toBe(0o600);
      const original=readFileSync(output,"utf8"); expect(JSON.parse(original).publishable).toBe(false);
      const second=run(); expect(await second.exited).toBe(1); expect(readFileSync(output,"utf8")).toBe(original);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});
