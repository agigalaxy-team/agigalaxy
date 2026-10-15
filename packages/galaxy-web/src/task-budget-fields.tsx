import {ReadingDetails,ReadingSummary} from './reading-details';
import React from 'react';
import type {z} from 'zod/v4';
import type {taskRequestV2Schema} from '../../galaxy-official/src/shared/task-schema-v2.mjs';
import {budgetText} from './task-bounty-client.mjs';
export type TaskConditions=Pick<z.infer<typeof taskRequestV2Schema>,'enrollmentExpiresAt'|'budget'|'qualification'|'capabilityId'>;
export function TaskTerms({request}:{request:TaskConditions}){return <div className="task-terms">
 <p>接受新回应至 <time dateTime={new Date(request.enrollmentExpiresAt*1000).toISOString()}>{new Date(request.enrollmentExpiresAt*1000).toLocaleString('zh-CN')}</time></p>
 {(request.budget||request.qualification)&&<ReadingDetails mode="inline"><ReadingSummary>原任务记录的条件</ReadingSummary>{request.budget&&<p>原预算：{budgetText(request.budget)}。这里只读取已有记录。</p>}{request.qualification&&<p>原条件：{request.qualification.policyId} / {request.qualification.policyVersion}；范围：{request.capabilityId}。参与确认仍受原任务的服务约束。</p>}</ReadingDetails>}
 </div>;}
