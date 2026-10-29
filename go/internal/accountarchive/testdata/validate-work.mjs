// Current shared contract parity only; no database or retired service is loaded.
import { accountWorkPutSchema } from '../../../../packages/galaxy-contracts/src/account-work-schema.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({ checks: JSON.parse(input).map(value => accountWorkPutSchema.safeParse(value).success) }));
