import {z} from 'zod';
const safeHref=value=>{
  if(typeof value!=='string'||/[\p{Cc}\s\\]/u.test(value))return false;
  if(value.startsWith('/')&&!value.startsWith('//'))return true;
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}
};
const href=z.string().max(2048).refine(safeHref);
// eslint-disable-next-line no-control-regex -- Deliberately reject or sanitize ASCII control characters.
const text=max=>z.string().max(max).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));
const links=z.array(z.strictObject({label:text(120).min(1),href,description:text(400).optional()})).max(12);
const heading=text(200).optional();
const blocks=z.array(z.discriminatedUnion('blockType',[
  z.strictObject({blockType:z.literal('hero'),heading:text(200).min(1),text:text(1600),links}),
  z.strictObject({blockType:z.literal('prose'),heading,body:text(30000)}),
  z.strictObject({blockType:z.literal('linkList'),heading,links}),
  z.strictObject({blockType:z.literal('image'),mediaId:text(128).min(1),caption:text(800)}),
  z.strictObject({blockType:z.literal('notice'),tone:z.enum(['information','service-impact']),title:text(200).min(1),text:text(4000)}),
  z.strictObject({blockType:z.literal('releaseLinks'),heading,channel:z.literal('stable'),label:text(120).min(1)}),
])).max(100);
const reserved=['/admin','/api','/app','/v1','/v2','/preview','/assets','/media','/releases','/archives'];
const pagePath=z.string().max(300).regex(/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/)
  .refine(value=>!reserved.some(prefix=>value===prefix||value.startsWith(prefix+'/')));
const media=z.strictObject({id:text(128).min(1),url:text(2048).min(1),filename:text(255).min(1).refine(value=>!/[\\/\p{Cc}]/u.test(value)&&!['.','..'].includes(value)),
  alt:text(1000),width:z.number().int().positive().nullable().optional(),height:z.number().int().positive().nullable().optional(),
  mimeType:z.enum(['image/jpeg','image/png','image/gif','image/webp','image/avif']),filesize:z.number().int().nonnegative().max(20971520),credit:text(2000).optional()});
export const contentSnapshotSchema=z.strictObject({version:z.literal(1),settings:z.strictObject({siteTitle:text(200).min(1),description:text(1600),
  footerLinks:z.array(z.strictObject({label:text(120).min(1),href})).max(24)}),
  pages:z.array(z.strictObject({id:text(128).min(1),path:pagePath,title:text(200).min(1),description:text(1600),blocks,updatedAt:z.iso.datetime({offset:true})})).max(200),
  media:z.array(media).max(1000)}).superRefine((value,context)=>{
    if(new Set(value.pages.map(page=>page.path)).size!==value.pages.length)context.addIssue({code:'custom',message:'Duplicate page path'});
    const ids=new Set(value.media.map(item=>item.id));
    if(ids.size!==value.media.length)context.addIssue({code:'custom',message:'Duplicate media id'});
    for(const page of value.pages)for(const block of page.blocks)if(block.blockType==='image'&&!ids.has(block.mediaId))context.addIssue({code:'custom',message:'Missing selected media'});
  });
