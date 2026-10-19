// 메인 프로세스가 IPC 인자를 받지 않을 때 돌려주는 값.
// status·data.error 를 채워 둬서, 화면이 「시사에 연결되지 않아서」 대신 실제 이유를 보여 준다.
export const DENIED_WHY = '앱이 이 요청을 받지 않았어요(보낸 값이 맞지 않아요)';
export const denied = () => ({ ok: false, status: 400, error: 'bad args', data: { error: DENIED_WHY } });
