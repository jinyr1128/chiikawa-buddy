import {test} from 'node:test';import assert from 'node:assert/strict';
import {normalizeAction,cardView} from '../src/actions.js';
test('노션 실행 카드에서 긴 변경 본문과 대상 확인 가능',()=>{const body='가'.repeat(8200);const a=normalizeAction({id:'1234567890abcdef1234',type:'notion_write',status:'pending',card:{title:'자료',body,fields:[{label:'대상 ID',value:'page'}]}});assert.ok(a);const v=cardView(a);assert.equal(v.body,body);assert.equal(v.fields[0].value,'page');});
