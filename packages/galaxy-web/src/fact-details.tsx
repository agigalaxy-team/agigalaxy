import React from 'react';
import {HistoryFacts} from './history-facts';
import type {HistoryFactsRecord,HistoryPeopleRuntime} from './history-fact-view-types';

export function FactDetails({item,runtime,connected=false,subjectId,navigate}:{item:HistoryFactsRecord;runtime?:HistoryPeopleRuntime;connected?:boolean;subjectId?:string;navigate?:(path:string)=>void}){
  return <HistoryFacts record={item} runtime={runtime} connected={connected} subjectId={subjectId} navigate={navigate}/>;
}
