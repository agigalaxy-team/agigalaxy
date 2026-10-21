import config from '@payload-config';
import '@payloadcms/next/css';
import type {ServerFunctionClient} from 'payload';
import {RootLayout,handleServerFunctions} from '@payloadcms/next/layouts';
import {importMap} from './admin/importMap';
import {headers} from 'next/headers';
import {requireAdminWrite} from '../../lib/request-origin.mjs';
import type {ReactNode} from 'react';
import './custom.css';
const serverFunction:ServerFunctionClient=async function(args){'use server';requireAdminWrite(await headers());return handleServerFunctions({...args,config,importMap});};
export default function Layout({children}:{children:ReactNode}){return <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>{children}</RootLayout>;}
