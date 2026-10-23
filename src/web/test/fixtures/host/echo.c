#include <stdio.h>
#include <string.h>

int main(void) {
	char line[256];
	while (fgets(line, sizeof line, stdin)) {
		line[strcspn(line, "\n")] = 0;
		if (strcmp(line, "quit") == 0) { break; }
		printf("got: %s\n", line);
		fflush(stdout);
	}
	printf("bye\n");
	return 0;
}
