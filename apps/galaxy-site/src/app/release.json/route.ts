import {servePublicResource} from '../../lib/public-resources';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(){return servePublicResource(['release.json']);}
