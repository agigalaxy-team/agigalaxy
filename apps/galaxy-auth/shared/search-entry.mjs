import {bindSiteSearch} from './site-search.mjs';

const form=document.querySelector('.selected-header-search form');
if(form)bindSiteSearch(form,{origin:'https://agigalaxy.org'});
