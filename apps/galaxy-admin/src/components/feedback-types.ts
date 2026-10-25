export type FeedbackCategory='problem'|'suggestion'|null;
export type FeedbackCategoryFilter=''|'unclassified'|'problem'|'suggestion';
export type FeedbackState='pending'|'processing'|'closed';
export type FeedbackModule='account'|'community'|'chat'|'work'|'discovery'|'other';
export type FeedbackDays='7'|'28'|'all';
export type FeedbackAccount={accountId:string;uid:string;displayName:string|null};
export type FeedbackItem={
  id:string;
  account:FeedbackAccount;
  title:string;
  excerpt:string;
  category:FeedbackCategory;
  module:FeedbackModule;
  state:FeedbackState;
  revision:number;
  createdAt:string;
  updatedAt:string;
  attachmentCount:number;
};
export type FeedbackAttachment={id:string;name:string;mediaType:string;byteSize:number;sha256:string;
 state:'prepared'|'uploading'|'scan-pending'|'scanning'|'available'|'blocked'|'erased'|'revoked'|'expired';
 expiresAt:string;url:null;availability:'available'|'unavailable'};
export type FeedbackEvent={
  id:string;
  sequence:string;
  kind:'submitted'|'updated';
  operatorId:string|null;
  operatorDisplayName:string|null;
  category:FeedbackCategory;
  module:FeedbackModule;
  state:FeedbackState;
  note:string|null;
  createdAt:string;
};
export type FeedbackSummary={
  total:number;
  unclassified:number;
  pending:number;
  closed:number;
  byCategory:{category:FeedbackCategory;count:number}[];
};
export type FeedbackPage={items:FeedbackItem[];nextAfter:string|null;summary:FeedbackSummary;checkedAt:number;permissions:{canManage:boolean}};
export type FeedbackDetail={
  feedback:FeedbackItem&{body:string;attachments:FeedbackAttachment[]};
  history:{items:FeedbackEvent[];nextAfter:string|null};
  permissions:{canManage:boolean};
  checkedAt:number;
};
export type FeedbackSaved=FeedbackDetail&{operationId:string;replayed:boolean};
export type FeedbackProps={selected:string;after:string;query:string;category:FeedbackCategoryFilter;state:''|FeedbackState;module:''|FeedbackModule;days:FeedbackDays;csrfToken:string;canManage:boolean};

export const feedbackCategoryLabels:Record<Exclude<FeedbackCategory,null>,string>={problem:'问题反馈',suggestion:'改进建议'};
export const feedbackStateLabels:Record<FeedbackState,string>={pending:'待处理',processing:'处理中',closed:'已处理'};
export const feedbackModuleLabels:Record<FeedbackModule,string>={account:'账户与身份',community:'社区',chat:'私聊',work:'协作',discovery:'发现与检索',other:'其他'};
export const feedbackCategoryLabel=(category:FeedbackCategory)=>category===null?'待归类':feedbackCategoryLabels[category];
export const feedbackModules=Object.keys(feedbackModuleLabels) as FeedbackModule[];
export const feedbackStates=Object.keys(feedbackStateLabels) as FeedbackState[];
