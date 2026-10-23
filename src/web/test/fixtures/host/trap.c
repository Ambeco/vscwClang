#include <stdio.h>
#include <stdlib.h>
#include <string.h>

volatile int zero = 0;
volatile char* far = (char*)0x7fffff00;

static int recurse(int n) { volatile char pad[4096]; pad[0] = (char)n; return n ? recurse(n + 1) + pad[0] : 0; }

int main(int argc, char** argv) {
	const char* mode = argc > 1 ? argv[1] : "";
	printf("before\n");
	fflush(stdout);
	if (strcmp(mode, "oob") == 0) { *far = 1; }
	else if (strcmp(mode, "div") == 0) { printf("%d\n", 1 / zero); }
	else if (strcmp(mode, "trap") == 0) { __builtin_trap(); }
	else if (strcmp(mode, "abort") == 0) { abort(); }
	else if (strcmp(mode, "stack") == 0) { printf("%d\n", recurse(1)); }
	printf("after\n");
	return 0;
}
