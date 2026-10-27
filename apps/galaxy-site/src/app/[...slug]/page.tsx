import {PublicPage,readPublicMetadata} from "../../public-content";
export default async function Page({params}:{params:Promise<{slug:string[]}>}){const {slug}=await params;return <PublicPage pathname={"/"+slug.join("/")+"/"}/>;}

export async function generateMetadata({params}:{params:Promise<{slug:string[]}>}){const {slug}=await params;return readPublicMetadata("/"+slug.join("/")+"/");}
