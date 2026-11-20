import {it,expect} from 'vitest';
import {normalizeJob} from '../shared/jobs.ts';
import {demoAnswer} from '../shared/answers.ts';
it('returns saved result from one-to-one PostgREST join',()=>{const answer=demoAnswer('ai');expect(normalizeJob({id:'test',results:{response_json:answer}}).answer).toEqual(answer);});
it('handles empty and one-to-many representations',()=>{const answer=demoAnswer('ai');expect(normalizeJob({results:[{response_json:answer}]}).answer).toEqual(answer);expect(normalizeJob({results:null}).answer).toBeUndefined();});
