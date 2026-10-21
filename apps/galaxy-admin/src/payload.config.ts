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
      Nav:'/components/Navigation#Navigation',
      graphics:{Logo:'/components/Brand#Brand',Icon:'/components/Brand#BrandIcon'},
      logout:{Button:'/components/SignOut#SignOut'},
      views:{
        dashboard:{Component:'/components/Welcome#Welcome'},
        login:{Component:'/components/Login#Login',path:'/login',exact:true},
        operations:{Component:'/components/OperationsView#OperationsView',path:'/operations/users',exact:true},
        publication:{Component:'/components/PublicationView#PublicationView',path:'/site-publication',exact:true},
        chatReports:{Component:'/components/ChatReportsView#ChatReportsView',path:'/operations/chat-reports',exact:true},
        jobs:{Component:'/components/OperationsJobsView#OperationsJobsView',path:'/operations/jobs',exact:true},
        searchRecovery:{Component:'/components/SearchRecoveryView#SearchRecoveryView',path:'/operations/search-recovery',exact:true},
        community:{Component:'/components/CommunityView#CommunityView',path:'/operations/community',exact:true},
        resources:{Component:'/components/ResourcesView#ResourcesView',path:'/operations/resources',exact:true},
        files:{Component:'/components/FilesView#FilesView',path:'/operations/files',exact:true},
        notices:{Component:'/components/NoticesView#NoticesView',path:'/operations/notices',exact:true},
        rules:{Component:'/components/RulesView#RulesView',path:'/operations/rules',exact:true},
        retention:{Component:'/components/RetentionView#RetentionView',path:'/operations/retention',exact:true},
        audit:{Component:'/components/AuditView#AuditView',path:'/operations/audit',exact:true},
      },
    },
  },
  i18n:{supportedLanguages:{zh,en},fallbackLanguage:'zh'},
  collections:[Operators,SitePages,Media],globals:[SiteSettings],
  db:postgresAdapter({pool:{connectionString:process.env.GALAXY_CMS_DATABASE_URL},idType:'uuid',disableCreateDatabase:true,push:process.env.NODE_ENV!=='production'&&process.env.GALAXY_CMS_DEV_PUSH==='true',migrationDir:path.resolve(here,'migrations')}),
  sharp,
  upload:{limits:{fileSize:8*1024*1024}},
  typescript:{outputFile:path.resolve(here,'payload-types.ts')},
});
