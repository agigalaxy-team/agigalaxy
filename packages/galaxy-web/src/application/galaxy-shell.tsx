"use client";
import React from "react";
import {useGalaxySession,useOptionalGalaxySession} from "./galaxy-session";
import {SiteShell,PageLoading} from "../site-shell";
import {Button} from "@/components/ui/button";
import {ReadingDetails,ReadingSummary} from "../shared/reading/reading-details";
import {LoadingFeedback} from "../shared/feedback/interaction-feedback";
export function GalaxyShell({children}:{children:React.ReactNode}){const {path,routeSearch,runtime,endpoint,publicReadingPage,agentIdentityEntry,error,notice,busy,configError,actionOrigin,historySavePending,draftHistory,navigateFromShell,task,accountPage,retryConfiguration}=useGalaxySession();return <SiteShell path={path} search={routeSearch} endpoint={endpoint} navigate={navigateFromShell}>
        {!publicReadingPage&&<LoadingFeedback active={busy&&actionOrigin===path+routeSearch} scopeKey={actionOrigin??''} className="workspace-operation-feedback" label="正在完成当前操作…" detail="处理仍在继续，请保留当前页面。"/>}
        {!publicReadingPage&&!accountPage&&configError && <section className="connection-unavailable" role="alert"><h1 className="small">暂时连不上银河</h1><p>可以重试，或先浏览介绍与使用文档。</p><div className="button-row"><Button onClick={retryConfiguration}>重新连接</Button><a className="text-link" href="/docs/">阅读使用文档</a></div><ReadingDetails className="technical-details"><ReadingSummary>连接问题详情</ReadingSummary><p>{configError}</p></ReadingDetails></section>}
        {!publicReadingPage&&error && (task||!/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path)) && <div className="message error" role="alert">{error}</div>}{!publicReadingPage&&notice && <output className="message">{notice}</output>}
        {historySavePending&&<div className="message"><output>先保存当前输入，再继续离开。保存失败时，输入会留在本页。</output><Button variant="outline" onClick={()=>draftHistory.current?.resume()}>保存并继续</Button></div>}
{!publicReadingPage&&!accountPage&&!agentIdentityEntry&&!runtime&&!configError&&path!=="/app/"&&path!=="/app"&&<PageLoading label="正在打开页面…"/>}{children}</SiteShell>;}

export function GalaxyWorkspace({children}:{children:React.ReactNode}){const session=useOptionalGalaxySession();return session?<GalaxyShell>{children}</GalaxyShell>:<PageLoading label="正在打开银河…"/>;}
