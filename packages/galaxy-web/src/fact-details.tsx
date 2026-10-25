import React from 'react';
import {HistoryFacts} from "./features/work-records/history";
import type {HistoryFactsRecord,HistoryPeopleRuntime} from "./features/work-records/history-types";

export function FactDetails({item,runtime,connected=false,subjectId,navigate}:{item:HistoryFactsRecord;runtime?:HistoryPeopleRuntime;connected?:boolean;subjectId?:string;navigate?:(path:string)=>void}){
  return <HistoryFacts record={item} runtime={runtime} connected={connected} subjectId={subjectId} navigate={navigate}/>;
}
