// Approximate default from the OS timezone, never a claim of GPS location.
import type { WeatherPlace } from './weather.ts';
const CITIES: Record<string,[string,number,number]> = {
 'Asia/Seoul':['서울',37.5665,126.978], 'Asia/Tokyo':['도쿄',35.6762,139.6503],
 'Asia/Shanghai':['상하이',31.2304,121.4737], 'Asia/Taipei':['타이베이',25.033,121.5654],
 'Asia/Hong_Kong':['홍콩',22.3193,114.1694], 'Asia/Singapore':['싱가포르',1.3521,103.8198],
 'Asia/Bangkok':['방콕',13.7563,100.5018], 'Asia/Kolkata':['콜카타',22.5726,88.3639],
 'Asia/Dubai':['두바이',25.2048,55.2708], 'Europe/London':['런던',51.5074,-0.1278],
 'Europe/Paris':['파리',48.8566,2.3522], 'Europe/Berlin':['베를린',52.52,13.405],
 'America/New_York':['뉴욕',40.7128,-74.006], 'America/Chicago':['시카고',41.8781,-87.6298],
 'America/Denver':['덴버',39.7392,-104.9903], 'America/Los_Angeles':['로스앤젤레스',34.0522,-118.2437],
 'America/Toronto':['토론토',43.6532,-79.3832], 'America/Vancouver':['밴쿠버',49.2827,-123.1207],
 'Australia/Sydney':['시드니',-33.8688,151.2093], 'Pacific/Auckland':['오클랜드',-36.8485,174.7633],
};
export function localWeatherPlace(timezone=Intl.DateTimeFormat().resolvedOptions().timeZone):WeatherPlace|null {
 const city=CITIES[timezone];if(!city)return null;
 const [name,latitude,longitude]=city;
 return {name,latitude,longitude,timezone,label:`${name} · 컴퓨터 시간대 기준 (${timezone}), 실제 위치와 다를 수 있음`};
}
