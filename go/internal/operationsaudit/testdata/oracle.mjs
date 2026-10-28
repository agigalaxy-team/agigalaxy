import {businessAuditMetadata} from '../../../../packages/galaxy-official/src/operations/audit/view.mjs';
let raw='';for await(const b of process.stdin)raw+=b;
const rows=JSON.parse(raw);process.stdout.write(JSON.stringify(rows.map(businessAuditMetadata)));
