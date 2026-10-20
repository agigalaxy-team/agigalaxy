import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {GalaxyMark,GlobalRail,SiteHeader,siteChromeStyles} from '../../packages/galaxy-web/src/site-chrome.mjs';

// One invocation renders the shared presentation needed by the entire Python
// build. Page bodies and their single main remain owned by chrome.py.
let input='';
process.stdin.setEncoding('utf8');
for await(const chunk of process.stdin)input+=chunk;
const {locations,markClasses,origin=''}=JSON.parse(input);
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props));
const headers=Object.fromEntries([...new Set(locations)].map(location=>[location,render(SiteHeader,{location,origin})]));
const marks=Object.fromEntries([...new Set(markClasses)].map(className=>[className,render(GalaxyMark,{bare:true,className:['brand-mark',className].filter(Boolean).join(' ')})]));
process.stdout.write(JSON.stringify({headers,marks,styles:siteChromeStyles,rails:{
  public:render(GlobalRail,{origin}),
  account:render(GlobalRail,{origin,activeHref:'/app/account'}),
}})+'\n');
