'use client';

import dynamic from 'next/dynamic';

// Keep the server Views' authorization and data reads, while loading each business UI on demand.
// SSR stays enabled so the selected View renders its initial content on the server.
export const AiRuns = dynamic(() => import("./ai-runs/AiRuns").then(module => module.AiRuns), {ssr: true});
export const AutoOperations = dynamic(() => import("./autonomy/AutoOperations").then(module => module.AutoOperations), {ssr: true});
export const Analytics = dynamic(() => import('./analytics/Analytics').then(module => module.Analytics), {ssr: true});
export const Audit = dynamic(() => import("./audit/Audit").then(module => module.Audit), {ssr: true});
export const BusinessUsers = dynamic(() => import("./accounts/BusinessUsers").then(module => module.BusinessUsers), {ssr: true});
export const Cases = dynamic(() => import("./content-governance/Cases").then(module => module.Cases), {ssr: true});
export const ChatReports = dynamic(() => import("./chat-reports/ChatReports").then(module => module.ChatReports), {ssr: true});
export const Community = dynamic(() => import("./content-governance/Community").then(module => module.Community), {ssr: true});
export const Feedback = dynamic(() => import('./feedback/Feedback').then(module => module.Feedback), {ssr: true});
export const Files = dynamic(() => import("./files/Files").then(module => module.Files), {ssr: true});
export const Maintenance = dynamic(() => import("./maintenance/Maintenance").then(module => module.Maintenance), {ssr: true});
export const Messaging = dynamic(() => import("./messaging/Messaging").then(module => module.Messaging), {ssr: true});
export const ModelSettings = dynamic(() => import("./models/ModelSettings").then(module => module.ModelSettings), {ssr: true});
export const Notices = dynamic(() => import("./messaging/Notices").then(module => module.Notices), {ssr: true});
export const OperationsJobs = dynamic(() => import('./OperationsJobs').then(module => module.OperationsJobs), {ssr: true});
export const Permissions = dynamic(() => import("./permissions/Permissions").then(module => module.Permissions), {ssr: true});
export const Recommendation = dynamic(() => import("./recommendation/Recommendation").then(module => module.Recommendation), {ssr: true});
export const Resources = dynamic(() => import("./content-governance/Resources").then(module => module.Resources), {ssr: true});
export const Retention = dynamic(() => import('./Retention').then(module => module.Retention), {ssr: true});
export const Rules = dynamic(() => import("./rules/Rules").then(module => module.Rules), {ssr: true});
export const SearchQuality = dynamic(() => import("./search/SearchQuality").then(module => module.SearchQuality), {ssr: true});
export const SearchRecovery = dynamic(() => import("./search/SearchRecovery").then(module => module.SearchRecovery), {ssr: true});
export const SitePublication = dynamic(() => import("./site-publication/SitePublication").then(module => module.SitePublication), {ssr: true});
export const Smtp = dynamic(() => import("./smtp/Smtp").then(module => module.Smtp), {ssr: true});
export const Strategies = dynamic(() => import("./strategies/Strategies").then(module => module.Strategies), {ssr: true});

export const OperationsDashboard = dynamic(() => import('./workbench/OperationsDashboard').then(module => module.OperationsDashboard), {ssr: true});

export const RegisteredUsers = dynamic(() => import("./accounts/RegisteredUsers").then(module => module.RegisteredUsers), {ssr: true});

export const ManagementAccounts = dynamic(() => import("./management-accounts/ManagementAccounts").then(module => module.ManagementAccounts), {ssr: true});

export const SystemSettings = dynamic(() => import('./system-settings/SystemSettings').then(module => module.SystemSettings), {ssr: true});
