import type {Answer,Job} from './contracts.ts';
// PostgREST represents a UNIQUE foreign-key relationship as one object.
export function normalizeJob(row:Record<string,unknown>):Job{
 const nested=row.results as {response_json:Answer}|{response_json:Answer}[]|null|undefined;
 const result=Array.isArray(nested)?nested[0]:nested;
 const {results:_,...job}=row;
 return {...job,...(result?{answer:result.response_json}:{})} as unknown as Job;
}
