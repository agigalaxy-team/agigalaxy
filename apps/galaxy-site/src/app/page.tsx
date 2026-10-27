import {PublicPage,readPublicMetadata} from "../public-content";
export default function Page(){return <PublicPage pathname="/"/>;}

export async function generateMetadata(){return readPublicMetadata("/");}
