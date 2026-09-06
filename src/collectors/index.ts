import type { Collector } from "../types";
import { oracle } from "./oracle";
import { azure } from "./azure";
import { lambda } from "./lambda";
import { runpod } from "./runpod";
import { vast } from "./vast";
import { google } from "./google";
import { aws } from "./aws";

export interface CollectorDescriptor {
  id: string;
  provider: string;
  credentialEnv?: string;
  credentialEnvs?: string[];
  configurationEnvs?: string[];
  documentation: string;
  defaultEnabled: boolean;
}
export const collectorCatalog: CollectorDescriptor[] = [
  { id: oracle.id, provider: oracle.provider, documentation: "https://docs.oracle.com/en-us/iaas/Content/Billing/Tasks/signingup_topic-Estimating_Costs.htm", defaultEnabled: true },
  { id: azure.id, provider: azure.provider, documentation: "https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices", defaultEnabled: true },
  { id: lambda.id, provider: lambda.provider, credentialEnv: "LAMBDA_API_KEY", documentation: "https://docs.lambda.ai/public-cloud/cloud-api/", defaultEnabled: false },
  { id: runpod.id, provider: runpod.provider, credentialEnv: "RUNPOD_API_KEY", documentation: "https://docs.runpod.io/sdks/graphql/manage-pods", defaultEnabled: false },
  { id: vast.id, provider: vast.provider, credentialEnv: "VAST_API_KEY", documentation: "https://docs.vast.ai/api-reference/search/search-offers", defaultEnabled: false },
  { id: google.id, provider: google.provider, credentialEnv: "GOOGLE_CLOUD_BILLING_API_KEY", configurationEnvs: ["GOOGLE_BILLING_SKU_MAP_JSON"], documentation: "https://docs.cloud.google.com/billing/v1/how-tos/catalog-api", defaultEnabled: false },
  { id: aws.id, provider: aws.provider, credentialEnv: "AWS_ACCESS_KEY_ID", credentialEnvs: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"], documentation: "https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-price-list-query-api.html", defaultEnabled: false },
];
const implementations = new Map([oracle, azure, lambda, runpod, vast, google, aws].map(collector => [collector.id, collector]));
export function createCollectors(ids: string[]): Collector[] {
  return [...new Set(ids)].map(id => {
    const collector = implementations.get(id);
    if (!collector) throw new Error(`Unknown collector: ${id}`);
    return collector;
  });
}
