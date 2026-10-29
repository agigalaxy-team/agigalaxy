import type {z} from 'zod/v4';
import type {createWebRuntime} from "../../runtime.mjs";
import type {createChoiceSyncClient} from './choice-sync-client.mjs';
import type {choiceContentSchema,choicePutSchema,choicePreferenceSchema} from "../../../../galaxy-contracts/src/choice-snapshot-schema-v2.mjs";
import type {ChoiceVersion} from "../help-search/help-contact-view-types";

export type ChoiceContent=z.infer<typeof choiceContentSchema>;
export type ChoicePreference={endpoint:string;revision:number;enabled:boolean;snapshotIds:string[]};
export type CloudChoiceContent=Partial<Omit<ChoiceContent,'visibleRationale'>>&{visibleRationale?:string|null;rationaleUnavailable?:boolean};
export type CloudChoiceVersion={snapshotId:string;versionId:string;state:string;content:CloudChoiceContent;expiresAt:string;priorRationaleCurrent:boolean};
export type CloudChoice={snapshotId:string;revision:number;current:CloudChoiceVersion|null;conflicts:CloudChoiceVersion[];syncState?:string};
export type ChoiceLocalVersion=ChoiceVersion&{rationaleAuthor?:ChoiceContent['rationaleAuthor']};
export type ChoiceLocalState={pending:Record<string,z.infer<typeof choicePutSchema>>;restored:Record<string,{versionId:string;content:ChoiceContent;restoredAt:string}>};
export type ChoiceSyncProps={runtime:Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'status'|'receiptStatus'|'getLocal'|'putLocal'>|null;subjectId?:string;connected:boolean;localChoices:{id:string;versions:ChoiceLocalVersion[]}[]};
export type ChoiceSyncPreview={id:string;content:ChoiceContent|ChoiceLocalVersion;expectedLocalHash?:string;expectedPendingVersionId?:string;resolveVersionIds:string[]};
type Client=ReturnType<typeof createChoiceSyncClient>;
export type ChoiceSyncViewClient=Omit<Client,'preferences'|'savePreference'|'list'|'localState'|'localPreview'|'sync'>&{
 preferences:()=>Promise<ChoicePreference>;
 savePreference:(input:z.infer<typeof choicePreferenceSchema>)=>Promise<ChoicePreference>;
 list:(input?:{after?:string;limit?:number})=>Promise<{items:CloudChoice[];nextAfter:string|null}>;
 localState:()=>Promise<ChoiceLocalState>;
 localPreview:(id:string)=>Promise<ChoiceLocalVersion>;
 sync:(id:string,options:{resolveVersionIds:string[];expectedLocalHash?:string;expectedPendingVersionId?:string})=>Promise<CloudChoice>;
};
