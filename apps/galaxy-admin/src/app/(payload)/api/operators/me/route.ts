import {getPayload} from 'payload';
import config from '@payload-config';
import {readOperatorSession} from '../../../../../lib/operations.mjs';
import {projectOperatorPrincipal} from '../../../../../lib/operator-strategy';
import {operatorMeResponse} from '../../../../../lib/operator-me.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){return operatorMeResponse(request.headers,{readSession:readOperatorSession,project:async(operator:{id:string;displayName:string;role:'administrator'|'reader';businessAuthorization?:{version:string;permissions:string[]}})=>projectOperatorPrincipal(await getPayload({config}),operator)});}
