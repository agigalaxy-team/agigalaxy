export type FactReference={id:string;version:number};
export type InterventionResponse={id:string;actorId:string;state:string;relationship:string;summary?:string};
export type InterventionOpinionsView={confirmation:string;responseCoverage?:{complete:boolean};responses?:InterventionResponse[]};
export type ResolutionDecision={
 id?:string;status:string;scopeVersion?:number;summary?:string;remainingGoals?:string[];resultRefs?:FactReference[];
 reconfirmationRequired?:boolean;currentDecisionAvailable?:boolean;currentSupport?:string;priorResolutionId?:string;
};
