// Report only whether a key was pressed recently. Never access key codes/text.
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <unistd.h>
#include <math.h>
int main(void) {
  int last = -1;
  while (getppid() != 1) {
    double age = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventKeyDown);
    int active = isfinite(age) && age >= 0 && age < 1.8;
    if (active != last) { puts(active ? "1" : "0"); fflush(stdout); last = active; }
    usleep(250000);
  }
  return 0;
}
