"use client";
import {usePathname,useSearchParams,useRouter} from "next/navigation";
import {GalaxySessionProvider as SharedGalaxySessionProvider} from "../../../packages/galaxy-web/src/application/galaxy-session";
export function GalaxySessionProvider({children}:{children:React.ReactNode}){
 const pathname=usePathname(),search=useSearchParams(),router=useRouter();
 return <SharedGalaxySessionProvider navigation={{pathname,search:search.toString(),push:(target,options)=>router.push(target,options),replace:(target,options)=>router.replace(target,options)}}>{children}</SharedGalaxySessionProvider>;
}
