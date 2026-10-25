'use client';

import dynamic from 'next/dynamic';

// Keep the server Views' authorization and data reads, while loading each business UI on demand.
// SSR stays enabled so the selected View renders its initial content on the server.
export const AiRuns = dynamic(() => import('./AiRuns').then(module => module.AiRuns), {ssr: true});
export const AutoOperations = dynamic(() => import('./AutoOperations').then(module => module.AutoOperations), {ssr: true});
export const Analytics = dynamic(() => import('./analytics/Analytics').then(module => module.Analytics), {ssr: true});
export const Audit = dynamic(() => import('./Audit').then(module => module.Audit), {ssr: true});
export const BusinessUsers = dynamic(() => import('./BusinessUsers').then(module => module.BusinessUsers), {ssr: true});
export const Cases = dynamic(() => import('./Cases').then(module => module.Cases), {ssr: true});
export const ChatReports = dynamic(() => import('./ChatReports').then(module => module.ChatReports), {ssr: true});
export const Community = dynamic(() => import('./Community').then(module => module.Community), {ssr: true});
export const Feedback = dynamic(() => import('./feedback/Feedback').then(module => module.Feedback), {ssr: true});
export const Files = dynamic(() => import('./Files').then(module => module.Files), {ssr: true});
export const Maintenance = dynamic(() => import('./Maintenance').then(module => module.Maintenance), {ssr: true});
export const Messaging = dynamic(() => import('./Messaging').then(module => module.Messaging), {ssr: true});
export const ModelSettings = dynamic(() => import('./ModelSettings').then(module => module.ModelSettings), {ssr: true});
export const Notices = dynamic(() => import('./Notices').then(module => module.Notices), {ssr: true});
export const OperationsJobs = dynamic(() => import('./OperationsJobs').then(module => module.OperationsJobs), {ssr: true});
export const Permissions = dynamic(() => import('./Permissions').then(module => module.Permissions), {ssr: true});
export const Recommendation = dynamic(() => import('./Recommendation').then(module => module.Recommendation), {ssr: true});
export const Resources = dynamic(() => import('./Resources').then(module => module.Resources), {ssr: true});
export const Retention = dynamic(() => import('./Retention').then(module => module.Retention), {ssr: true});
export const Rules = dynamic(() => import('./Rules').then(module => module.Rules), {ssr: true});
export const SearchQuality = dynamic(() => import('./SearchQuality').then(module => module.SearchQuality), {ssr: true});
export const SearchRecovery = dynamic(() => import('./SearchRecovery').then(module => module.SearchRecovery), {ssr: true});
export const SitePublication = dynamic(() => import('./SitePublication').then(module => module.SitePublication), {ssr: true});
export const Smtp = dynamic(() => import('./Smtp').then(module => module.Smtp), {ssr: true});
export const Strategies = dynamic(() => import('./Strategies').then(module => module.Strategies), {ssr: true});

export const OperationsDashboard = dynamic(() => import('./workbench/OperationsDashboard').then(module => module.OperationsDashboard), {ssr: true});

export const RegisteredUsers = dynamic(() => import('./RegisteredUsers').then(module => module.RegisteredUsers), {ssr: true});

export const ManagementAccounts = dynamic(() => import('./ManagementAccounts').then(module => module.ManagementAccounts), {ssr: true});

export const SystemSettings = dynamic(() => import('./system-settings/SystemSettings').then(module => module.SystemSettings), {ssr: true});
