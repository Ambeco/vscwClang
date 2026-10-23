#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

__attribute__((constructor)) static void start_in_workspace(void) { chdir("/workspace"); }

int main(void) {
	FILE* f = fopen("out.txt", "w");
	if (!f) { perror("fopen out.txt"); return 1; }
	fputs("line one\nline two\n", f);
	fclose(f);
	f = fopen("/workspace/out.txt", "a");
	fputs("line three\n", f);
	fclose(f);
	f = fopen("out.txt", "r");
	char buf[128];
	size_t n = fread(buf, 1, sizeof buf - 1, f);
	buf[n] = 0;
	fclose(f);
	printf("read %zu bytes: %s", n, buf);
	struct stat st;
	if (stat("out.txt", &st) == 0) { printf("size=%ld\n", (long)st.st_size); }
	if (mkdir("sub", 0777) != 0) { perror("mkdir sub"); }
	f = fopen("sub/inner.txt", "w");
	fputs("x", f);
	fclose(f);
	DIR* d = opendir(".");
	char names[512] = "";
	struct dirent* e;
	while ((e = readdir(d))) { if (e->d_name[0] != '.') { strcat(names, e->d_name); strcat(names, ","); } }
	closedir(d);
	printf("entries: %s\n", names);
	if (rename("sub/inner.txt", "sub/renamed.txt") != 0) { perror("rename"); }
	if (unlink("sub/renamed.txt") != 0) { perror("unlink"); }
	if (rmdir("sub") != 0) { perror("rmdir"); }
	printf("missing: %s\n", fopen("nope.txt", "r") ? "found" : "absent");
	f = fopen("/tmp/scratch.txt", "w");
	printf("tmp: %s\n", f ? "writable" : "failed");
	if (f) { fclose(f); }
	return 0;
}
