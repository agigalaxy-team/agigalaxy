process.stdin.setEncoding('utf8');
import {createKeycloakAdminDirectory} from '../../packages/galaxy-official/src/identity/authentication/keycloak-admin-directory.mjs';
let text='';for await(const chunk of process.stdin)text+=chunk;const x=JSON.parse(text),origin=new URL(x.adminOrigin);if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1')throw Error('isolated loopback provider required');
const directory=createKeycloakAdminDirectory(x),value=await directory.get({issuer:x.issuer,externalSubject:x.subject});console.log(JSON.stringify(value));
