import {Suspense} from "react";
import {GalaxySessionProvider} from "../galaxy-session";
import "@/app/globals.css";
import "../../../../packages/galaxy-web/src/shared/feedback/control-feedback.css";
import "../../../../packages/galaxy-web/src/site-foundation.css";
import "../../../../packages/galaxy-web/src/selected-shell.css";
import "../../../../packages/galaxy-web/src/features/tasks/task-help-continuation.css";
import "../../../../packages/galaxy-web/src/workspace.css";
import "../../../../packages/galaxy-web/src/porcelain-theme.css";
import "../../../../packages/galaxy-web/src/full-width-layout.css";
export const dynamic='force-dynamic';
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body><Suspense><GalaxySessionProvider>{children}</GalaxySessionProvider></Suspense></body></html>;}
