import {useLayoutEffect,useMemo} from 'react';
import {createReadTaskController} from '../../../integrations/shared/read-task.mjs';

export type ReadTaskResult<T>=
 |{status:'success';value:T}
 |{status:'error';error:unknown}
 |{status:'superseded'};

export type ReadCallbacks<T>={
 onStart?:()=>void;
 onSuccess?:(value:T)=>void;
 onError?:(error:unknown)=>void;
 onSettled?:()=>void;
};

export interface ReadTasks{
 readonly scopeKey:string;
 run<T>(identity:{lane:string;key:string},read:(context:{signal:AbortSignal})=>Promise<T>,callbacks?:ReadCallbacks<NoInfer<T>>):Promise<ReadTaskResult<T>>;
 cancel(lane?:string):void;
 isPending(lane:string):boolean;
 dispose():void;
 activate():void;
}

/** Scope changes invalidate reads before the next page can receive their callbacks. */
export function useReadTasks(scopeKey:string):ReadTasks{
 const tasks=useMemo(()=>createReadTaskController(scopeKey) as ReadTasks,[scopeKey]);
 useLayoutEffect(()=>{tasks.activate();return()=>tasks.dispose();},[tasks]);
 return tasks;
}
