// The two bundles are on the same volume. A failed exchange leaves the running version intact.
#import <Cocoa/Cocoa.h>
#include <stdio.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>

static BOOL launch(NSString *bundle) {
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/open"];
    task.arguments = @[@"-n", bundle];
    if (![task launchAndReturnError:NULL]) return NO;
    [task waitUntilExit];
    return task.terminationStatus == 0;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 4) return 2;
        int parent = atoi(argv[1]);
        if (parent <= 1) return 2;
        for (int i = 0; i < 600 && kill(parent, 0) == 0; i++) usleep(100000);
        NSString *current = [NSString stringWithUTF8String:argv[2]];
        NSString *next = [NSString stringWithUTF8String:argv[3]];
        BOOL exchanged = NO;
        if (kill(parent, 0) < 0 && errno == ESRCH)
            exchanged = renamex_np(argv[2], argv[3], RENAME_SWAP) == 0;
        if (exchanged && launch(current)) {
            [[NSFileManager defaultManager] removeItemAtPath:next.stringByDeletingLastPathComponent error:NULL];
            return 0;
        }
        if (exchanged && renamex_np(argv[2], argv[3], RENAME_SWAP) == 0) launch(current);
        [NSApplication sharedApplication];
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"업데이트를 마치지 못했어요";
        alert.informativeText = @"앱을 다시 열어 설치된 버전을 확인해 주세요. 설정의 ‘다운로드 페이지’에서 설치 파일을 받을 수 있어요.";
        [alert runModal];
        return 1;
    }
}
