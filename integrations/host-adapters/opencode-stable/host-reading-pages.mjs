// DialogAlert in the installed stable host does not scroll. Keep every source
// character, splitting only the visual reading into pages that fit its viewport.
export function hostReadingPages(text,{width=80,height=24}={}){
 const columns=Math.max(12,Math.min(72,Math.floor(width)-28));
 const rows=Math.max(3,Math.floor(height/2)-4),pages=[];
 let page='',line=1,column=0;
 for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(String(text))){
  const size=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(segment)?2:1;
  if(segment==='\n'){page+=segment;line++;column=0;continue;}
  if(column+size>columns){line++;column=0;}
  if(line>rows){pages.push(page);page='';line=1;column=0;}
  page+=segment;column+=size;
 }
 if(page||!pages.length)pages.push(page);
 return pages;
}
