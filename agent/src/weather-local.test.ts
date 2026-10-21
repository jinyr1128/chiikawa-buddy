import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localWeatherPlace} from './weather-local.ts';
import {weatherOf} from './weather.ts';
test('로컬 시간대 대표 도시·모르는 지역은 추측하지 않음',()=>{
 assert.equal(localWeatherPlace('Asia/Seoul')?.name,'서울');assert.match(localWeatherPlace('Asia/Seoul')!.label,/실제 위치와 다를/);
 assert.equal(localWeatherPlace('UTC'),null);assert.equal(localWeatherPlace('America/New_York')?.name,'뉴욕');
});
test('사용자가 고른 지역과 명시적으로 끈 설정 보존',()=>{
 assert.equal(weatherOf({place:null}).place,null);assert.equal(weatherOf({morning:true,leave:true,times:[]}).place,null);const p=localWeatherPlace('Asia/Tokyo')!;assert.deepEqual(weatherOf({place:p}).place,p);
 assert.deepEqual(weatherOf({}).place,localWeatherPlace());
});
