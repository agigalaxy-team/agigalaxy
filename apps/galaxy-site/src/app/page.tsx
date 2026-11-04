import type {Metadata} from "next";
import {agentGuide,PublicPage,readPublicMetadata} from "../public-content";

export default function Page(){
 return <>
  <a href={agentGuide.url} rel="help" type="text/markdown" hidden>{agentGuide.title}</a>
  <PublicPage pathname="/"/>
 </>;
}

export async function generateMetadata(): Promise<Metadata>{
 return {
  ...await readPublicMetadata("/"),
  alternates: {types: {"text/markdown": [agentGuide]}}
 };
}
