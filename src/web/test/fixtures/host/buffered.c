#include <stdio.h>
#include <unistd.h>

// Prints two lines without fflush, then blocks on stdin: on a terminal both lines arrive before the read.
int main(void) {
	printf("first\n");
	printf("isatty=%d,%d,%d\n", isatty(0), isatty(1), isatty(2));
	char line[16];
	if (fgets(line, sizeof line, stdin)) { printf("read\n"); }
	return 0;
}
