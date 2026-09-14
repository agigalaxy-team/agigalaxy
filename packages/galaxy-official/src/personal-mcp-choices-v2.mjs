import * as z from 'zod/v4';
import {choicePreferenceSchema,choicePutSchema,choiceGetSchema,choicePageSchema,choiceDeleteSchema} from './shared/choice-snapshot-schema-v2.mjs';
export function choiceToolDefinitions(services,actor){if(!services.choices)return{};
 const tool=(inputSchema,description,run,write=false)=>({inputSchema,description,run,write,scope:'binding'});
 return{
  galaxy_choice_preferences:tool(z.strictObject({}),'Read the separate owner-private choice-snapshot category. Reading or binding never enables synchronization.',()=>services.choices.preferences(actor)),
  galaxy_choice_preferences_save:tool(choicePreferenceSchema,'Apply only the user-selected snapshot IDs at this endpoint. Personal room summary consent never enables choices; do not widen IDs automatically.',x=>services.choices.savePreference(actor,x),true),
  galaxy_choice_put:tool(choicePutSchema,'Synchronize an explicitly selected minimal choice with exact source witnesses and any actual readable result refs. Original queries validate this request but are not stored; no source body, model private reasoning, invitation or success event is generated. Preserve operation ID on uncertain delivery; competing versions remain conflicts.',x=>services.choices.put(actor,x),true),
  galaxy_choice_get:tool(choiceGetSchema,'Read own retained current choice and conflicts with current source filtering; inaccessible reasons are removed. No claim that the original query relevance remains current.',x=>services.choices.get(actor,x)),
  galaxy_choice_list:tool(choicePageSchema,'List this owner’s cloud choices only, not local-only choices or anyone else’s selections.',x=>services.choices.list(actor,x)),
  galaxy_choice_delete:tool(choiceDeleteSchema,'Delete the explicitly chosen cloud copy. Original work facts and local notes remain independently controlled.',x=>services.choices.delete(actor,x),true)
 };
}
