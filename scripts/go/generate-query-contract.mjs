import {writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {agentOsQueryArgumentsSchema,agentOsReadArgumentsSchema} from '../../packages/galaxy-contracts/src/operations-agentos-query-schema.mjs';

const jsonSchema=schema=>z.toJSONSchema(schema,{io:'input',unrepresentable:'any'});
const routes=[];
const visit=schema=>{if(schema.shape?.module&&schema.shape?.view){routes.push(schema);return;}for(const option of schema.options??[])visit(option);};
visit(agentOsQueryArgumentsSchema);
const filters={};
for(const route of routes)filters[`${route.shape.module.value}:${route.shape.view.value}`]=jsonSchema(route.shape.filters);
for(const route of agentOsReadArgumentsSchema.options)filters[`read:${route.shape.kind.value}`]=jsonSchema(route.shape.filters);
const value={query:jsonSchema(agentOsQueryArgumentsSchema),read:jsonSchema(agentOsReadArgumentsSchema),filters};
await writeFile(new URL('../../go/internal/operationsquerycontract/query-contract.json',import.meta.url),JSON.stringify(value)+'\n');
