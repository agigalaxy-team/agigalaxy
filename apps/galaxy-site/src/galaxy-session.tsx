"use client";
import {usePathname,useSearchParams,useRouter} from "next/navigation";
import {GalaxySessionProvider as SharedGalaxySessionProvider} from "../../../packages/galaxy-web/src/application/galaxy-session";
import {PublicNavigationMotion} from './public-navigation-motion';
export function GalaxySessionProvider({children}:{children:React.ReactNode}){
 const pathname=usePathname(),search=useSearchParams(),router=useRouter();
 return <SharedGalaxySessionProvider navigation={{pathname,search:search.toString(),push:(target,options)=>router.push(target,options),replace:(target,options)=>router.replace(target,options)}}><PublicNavigationMotion/>{children}</SharedGalaxySessionProvider>;
}
