import {p14ControlsSchema} from "../../shared/p14-rules-schema.mjs";
import {operationsPolicySchemas} from "../../shared/operations-product-schema.mjs";

export const p14PolicySchemas=Object.freeze({...operationsPolicySchemas,'business-controls':p14ControlsSchema});
