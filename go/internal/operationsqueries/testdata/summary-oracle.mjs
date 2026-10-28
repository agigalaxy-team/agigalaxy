import {conversationSummary} from '../../../../packages/galaxy-official/src/operations/agentos/conversations.mjs';
let raw='';for await(const b of process.stdin)raw+=b;process.stdout.write(JSON.stringify(JSON.parse(raw).map(x=>conversationSummary(x.value,x.domain,x.permissions))));
