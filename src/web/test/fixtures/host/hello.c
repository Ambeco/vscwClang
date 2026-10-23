#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char** argv) {
	printf("hello");
	for (int i = 1; i < argc; i++) { printf(" %s", argv[i]); }
	printf("\n");
	fprintf(stderr, "to-stderr\n");
	const char* foo = getenv("FOO");
	if (foo) { printf("FOO=%s\n", foo); }
	return argc > 1 && strcmp(argv[1], "exit7") == 0 ? 7 : 3;
}
