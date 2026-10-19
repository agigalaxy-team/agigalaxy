import type {ContentImage} from './community-content-visuals';

/** Official, locally served pictures for existing editorial links. Full provenance is in /images/external/credits.json. */
export const externalCommunityCovers:Partial<Record<string,ContentImage>>={
 'webb-pillars':{src:'/images/external/webb-pillars.png',alt:'韦布近红外影像中的创生之柱：金褐色尘埃柱与密集星光'},
 alice:{src:'/images/external/alice-mad-tea-party.gif',alt:'John Tenniel 原版插图：爱丽丝与三月兔、疯帽匠围坐在茶桌旁'},
};

export type ExternalCommunityCoverCredit={credit:string;sourceUrl:string;license:string;licenseUrl:string};
export const externalCommunityCoverCredits:Partial<Record<string,ExternalCommunityCoverCredit>>={
 'webb-pillars':{
  credit:'NASA, ESA, CSA, STScI; Image Processing: Joseph DePasquale (STScI), Anton Koekemoer (STScI), Alyssa Pagan (STScI)',
  sourceUrl:'https://science.nasa.gov/asset/webb/pillars-of-creation-nircam-image/',
  license:'NASA 图像使用准则（资料介绍用途）',
  licenseUrl:'https://www.nasa.gov/nasa-brand-center/images-and-media/',
 },
 alice:{
  credit:'插图：John Tenniel；电子版制作：Geof Pawlicki、Jim Chamings（Project Gutenberg）',
  sourceUrl:'https://www.gutenberg.org/ebooks/114',
  license:'公有领域（美国，按 Project Gutenberg 标注）',
  licenseUrl:'https://www.gutenberg.org/policy/permission.html',
 },
};
