import type {Metadata} from "next";
import {PublicPage,readPublicMetadata} from "../public-content";

const agentGuide = {url: "/agent.md", title: "银河 Agent 初始化与使用说明"};

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
