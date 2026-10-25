import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildConfig} from 'payload';
import {postgresAdapter} from '@payloadcms/db-postgres';
import {zh} from '@payloadcms/translations/languages/zh';
import {en} from '@payloadcms/translations/languages/en';
import sharp from 'sharp';
import {Operators} from './collections/Operators';
import {Media} from './collections/Media';
import {SitePages} from './collections/SitePages';
import {SiteSettings} from './globals/SiteSettings';
import {adminEnvironment} from './lib/environment.mjs';
import {payloadLoggerOptions} from './lib/runtime-log.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const {publicOrigin}=adminEnvironment();
if(!process.env.GALAXY_CMS_DATABASE_URL)throw Error('GALAXY_CMS_DATABASE_URL is required for the separate CMS database');
if(!process.env.GALAXY_CMS_SECRET||process.env.GALAXY_CMS_SECRET.length<32)throw Error('GALAXY_CMS_SECRET must contain at least 32 characters');
export default buildConfig({
  logger:{options:payloadLoggerOptions()},
  secret:process.env.GALAXY_CMS_SECRET,
  serverURL:publicOrigin,
  routes:{admin:'/admin',api:'/api'},
  csrf:[publicOrigin],cors:[publicOrigin],
  admin:{
    user:'operators',autoLogin:false,theme:'light',meta:{titleSuffix:' · 银河运营'},
    importMap:{baseDir:here,importMapFile:path.resolve(here,'app/(payload)/admin/importMap.ts')},
    components:{
      providers:['/components/SettingsDraftSession#SettingsDraftSession'],
      Nav:'/components/Navigation#Navigation',
      graphics:{Logo:'/components/Brand#Brand',Icon:'/components/Brand#BrandIcon'},
      logout:{Button:'/components/SignOut#SignOut'},
      views:{
        dashboard:{Component:'/components/Welcome#Welcome'},
        login:{Component:'/components/Login#Login',path:'/login',exact:true},
        operations:{Component:'/components/OperationsView#OperationsView',path:'/operations/users',exact:true},
        managementAccounts:{Component:'/components/ManagementAccountsView#ManagementAccountsView',path:'/operations/management-accounts',exact:true},
        aiWorkAccounts:{Component:'/components/AiWorkAccountsView#AiWorkAccountsView',path:'/operations/ai-work-accounts',exact:true},
        systemSettings:{Component:'/components/SystemSettingsView#SystemSettingsView',path:'/operations/system-settings',exact:true},
        publication:{Component:'/components/PublicationView#PublicationView',path:'/site-publication',exact:true},
        chatReports:{Component:'/components/ChatReportsView#ChatReportsView',path:'/operations/chat-reports',exact:true},
        jobs:{Component:'/components/OperationsJobsView#OperationsJobsView',path:'/operations/jobs',exact:true},
        searchRecovery:{Component:'/components/SearchRecoveryView#SearchRecoveryView',path:'/operations/search-recovery',exact:true},
        community:{Component:'/components/CommunityView#CommunityView',path:'/operations/community',exact:true},
        feedback:{Component:'/components/FeedbackView#FeedbackView',path:'/operations/feedback',exact:true},
        resources:{Component:'/components/ResourcesView#ResourcesView',path:'/operations/resources',exact:true},
        files:{Component:'/components/FilesView#FilesView',path:'/operations/files',exact:true},
        notices:{Component:'/components/NoticesView#NoticesView',path:'/operations/notices',exact:true},
        messaging:{Component:'/components/MessagingView#MessagingView',path:'/operations/messaging',exact:true},
        smtp:{Component:'/components/SmtpView#SmtpView',path:'/operations/smtp',exact:true},
        strategy:{Component:'/components/StrategiesView#StrategiesView',path:'/operations/strategy',exact:true},
        autonomy:{Component:'/components/AutoOperationsView#AutoOperationsView',path:'/operations/autonomy',exact:true},
        aiRuns:{Component:'/components/AiRunsView#AiRunsView',path:'/operations/ai-runs',exact:true},
        models:{Component:'/components/ModelSettingsView#ModelSettingsView',path:'/operations/models',exact:true},
        analytics:{Component:'/components/AnalyticsView#AnalyticsView',path:'/operations/analytics',exact:true},
        recommendation:{Component:'/components/RecommendationView#RecommendationView',path:'/operations/recommendation',exact:true},
        searchQuality:{Component:'/components/SearchQualityView#SearchQualityView',path:'/operations/search-quality',exact:true},
        maintenance:{Component:'/components/MaintenanceView#MaintenanceView',path:'/operations/maintenance',exact:true},
        rules:{Component:'/components/RulesView#RulesView',path:'/operations/rules',exact:true},
        retention:{Component:'/components/RetentionView#RetentionView',path:'/operations/retention',exact:true},
        audit:{Component:'/components/AuditView#AuditView',path:'/operations/audit',exact:true},
        permissions:{Component:'/components/PermissionsView#PermissionsView',path:'/operations/permissions',exact:true},
      },
    },
  },
  i18n:{supportedLanguages:{zh,en},fallbackLanguage:'zh',translations:{zh:{general:{payloadSettings:'显示偏好',leaveWithoutSaving:'有修改尚未保存',changesNotSaved:'当前修改还未保存，是否离开此页面？',stayOnThisPage:'继续编辑',leaveAnyway:'离开页面'}},en:{general:{payloadSettings:'Display preferences'}}}},
  collections:[Operators,SitePages,Media],globals:[SiteSettings],
  db:postgresAdapter({pool:{connectionString:process.env.GALAXY_CMS_DATABASE_URL},idType:'uuid',disableCreateDatabase:true,push:process.env.NODE_ENV!=='production'&&process.env.GALAXY_CMS_DEV_PUSH==='true',migrationDir:path.resolve(here,'migrations')}),
  sharp,
  upload:{limits:{fileSize:8*1024*1024}},
  typescript:{outputFile:path.resolve(here,'payload-types.ts')},
});
