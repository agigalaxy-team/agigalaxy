import {resourceBudgetPolicySchema} from './infrastructure/resource-budgets.mjs';
import {forumPolicySchema,forumPolicyHash} from './community-forum-policy-v1.mjs';
import {operationsPolicySchemas} from './shared/operations-product-schema.mjs';

// Each validated policy is adopted synchronously across the actual holders.
// No awaited work can expose a partially replaced consumer set.
export function apiOperationsPolicyConsumers(services,{onForumPolicy=()=>{}}={}){
  return {
    'resource-budget':policy=>{
      const value=resourceBudgetPolicySchema.parse(policy);
      services.access.resourceBudgetPolicy=value;
      services.evidence.resourceBudgetPolicy=value;
      services.ciV2.resourceBudgetPolicy=value;
    },
    'community-quota':policy=>{services.publicWrites.policy=operationsPolicySchemas['community-quota'].parse(policy);},
    'forum-quota':policy=>{
      const value=forumPolicySchema.parse(policy),policyHash=forumPolicyHash(value);
      onForumPolicy(value);
      for(const consumer of [services.forum,services.forum.permissions,services.forum.budget,services.forumGovernance])Object.assign(consumer,{policy:value,policyHash});
    },
  };
}
export function workerOperationsPolicyConsumers({evidence,ciV2,probes,onForumPolicy}){
  return {
    'resource-budget':policy=>{
      const value=resourceBudgetPolicySchema.parse(policy);
      evidence.resourceBudgetPolicy=value;ciV2.resourceBudgetPolicy=value;probes.budget=value;
    },
    'forum-quota':policy=>{onForumPolicy(forumPolicySchema.parse(policy));},
  };
}
