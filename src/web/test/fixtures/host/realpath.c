#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
	const char* paths[] = {"/workspace", "/workspace/.", "/workspace/sub/../sub", "/workspace/missing", "/tmp"};
	for (size_t i = 0; i < sizeof paths / sizeof *paths; i++) {
		char buf[PATH_MAX];
		char* r = realpath(paths[i], buf);
		printf("%s -> %s (%s)\n", paths[i], r ? r : "null", r ? "ok" : strerror(errno));
	}
	return 0;
}
